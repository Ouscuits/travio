/* ── Route Form ── compute-then-enrich pipeline ──
 *
 * The route is COMPUTED, not narrated:
 *   1. parse destinations
 *   2. geocode every place (geo-provider, rate limited — progress is shown)
 *   3. build the road distance matrix (geo-provider)
 *   4. planRoute() (route-engine, pure + deterministic) -> the itinerary skeleton
 *   4b. ONE routeGeometry() call, for the MAP ONLY (see below)
 *   5. compute costs in JS and render the itinerary + the map
 *   6. ONLY THEN ask Claude to enrich that fixed skeleton with prose
 *
 * The model can never change the order, the days, the distances or the times:
 * steps 1-5 finish and are already on screen before step 6 is even sent.
 *
 * THE MAP CHANGES NOTHING. Step 4b runs AFTER planRoute, so the order it is asked
 * about is already fixed, and its answer is used for one thing only: the shape of
 * the line drawn on screen. Nothing downstream of it reads a distance or a time
 * from it. If it fails, the itinerary is byte-for-byte the same and the map falls
 * back to straight lines between the stops — which is an ESTIMATE and is labelled
 * as one, in the notice list as well as inside the SVG.
 *
 * EXACTLY ONCE PER GENERATION. The line is fetched here and kept on the route
 * object; exporting, re-rendering after a language switch, and loading a saved
 * document never issue another request.
 *
 * PROVENANCE SURVIVES THE ROUND TRIP. geo-provider marks its answer with a
 * NON-ENUMERABLE `source`, which JSON.stringify drops — so a line saved without
 * its provenance comes back looking like measured road data. Everything below
 * therefore carries the source as an ordinary value, saves it as an ordinary
 * Firestore field, and treats an ABSENT source as unknown, never as road.
 *
 * ── MEASURED, in Chrome against live OSRM (Madrid → Valencia → Zaragoza →
 *    Barcelona, 3 days, 1007 km) ────────────────────────────────────────────
 *   raw geometry 11,011 points -> 188 after simplification at 0.5 km
 *   stored flat: 376 numbers, 3,285 bytes of JSON; whole saved document 8,977
 *   bytes, i.e. 0.9% of the Firestore 1 MB limit (the raw line alone would be
 *   ~20%). Exports produced locally: GPX 11,564 B, print HTML 13,965 B,
 *   ICS 1,881 B. Geometry requests: 1 for the generation, and still 1 after
 *   three language switches, three exports and three saved-route loads.
 *
 * ── KNOWN LIMITATIONS, none of them fixed, all of them measured ────────────
 *  L1 The geometry request is a FOURTH serialised network call. geo-provider
 *     spaces every request by >=1100 ms (OSM usage policy), so a generation now
 *     takes roughly 1.2-2.5 s longer, and the user waits for the map even though
 *     the itinerary is already computed. Rendering the itinerary first and
 *     slotting the map in when the line lands was NOT done: it needs a second
 *     render pass and a second generation-token check on a surface the user is
 *     already reading, which is exactly the shape of the zombie-route bug.
 *  L2 A saved route never gains geometry afterwards — no backfill, no re-fetch,
 *     no "draw the road" button. Documents from earlier builds stay an estimate
 *     for ever, and say so on every load.
 *  L3 The calendar start date lives in the export bar and is NOT saved with the
 *     route: exporting the same saved route next week asks for it again. The
 *     form has no trip date and inventing one is what buildIcs refuses to do.
 *  L4 "Print / PDF" downloads a standalone .html file rather than opening the
 *     print dialog. Deliberate: window.open() is blocked in an installed PWA on
 *     iOS, and the file prints from anywhere.
 *  L5 Map labels can overlap on short legs — measured with L'Hospitalet 12 km
 *     from Barcelona at national zoom, where the day-3 line is shorter than the
 *     two markers. js/route-map.js places labels without collision detection;
 *     the legend still names every day, so nothing is unreadable, but it is
 *     ugly. Not fixed (that file belongs to the map builder).
 *  L6 The map is static: no pan, no zoom, no basemap tiles. Deliberate — a tile
 *     layer means a CDN, a third-party origin and a broken offline install.
 *  L7 GPX / ICS importer compatibility is UNTESTED against Garmin, OsmAnd,
 *     Komoot or any calendar app. The files are well-formed and the exporter's
 *     own header records the same gap; nobody has imported one.
 */

const CLAUDE_PROXY = 'https://sitoclaude-proxy.sito041971.workers.dev';
const CLAUDE_MODEL = 'claude-opus-5';
const MAX_DRIVE_MIN_PER_DAY = 360;      // quality bar B6 — 6 h/day cap

/* Map geometry. 0.5 km of simplification error is about one screen pixel at
   national zoom and takes the stored line from ~199 KB to ~5 KB (see the header
   of js/route-map.js). Width/height are viewBox units, not pixels. */
const MAP_TOLERANCE_KM = 0.5;
const MAP_VIEW_WIDTH   = 640;
const MAP_VIEW_HEIGHT  = 400;
/* The only geometry provenance value that may be drawn as a road. */
const GEOMETRY_ROAD = 'osrm';

let currentRoute = null;
let isGenerating = false;

/* Every write to the result pane is stamped with the generation that produced it.
   Step 6 (enrichment) lands seconds after step 5, and in between the user can clear
   the form or load a saved route — without this token that late write resurrects a
   dead itinerary against an empty form, or clobbers the route just loaded. */
let generationId = 0;
function beginGeneration() { return ++generationId; }
function invalidateGeneration() { generationId++; }
function isCurrentGeneration(id) { return id === generationId; }

/* ── Small helpers ── */
function itin() {
    return (typeof window !== 'undefined' && window.TravioItinerary) ? window.TravioItinerary : null;
}
function mapApi() {
    return (typeof window !== 'undefined' && window.TravioMap) ? window.TravioMap : null;
}
function exportApi() {
    return (typeof window !== 'undefined' && window.TravioExport) ? window.TravioExport : null;
}
function trCtx() {
    return { t: t, tf: (typeof tf === 'function' ? tf : null) };
}
function el(id) { return document.getElementById(id); }
function numVal(id, def) {
    const node = el(id);
    if (!node) return def;
    const n = Number(node.value);
    return isFinite(n) && n > 0 ? n : def;
}
/* Firestore rejects undefined and NaN — everything unusable becomes an explicit null. */
function numOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return isFinite(n) && n >= 0 ? n : null;
}
function setVal(id, value) {
    const node = el(id);
    if (node && value !== null && value !== undefined && value !== '') node.value = value;
}

/* ══════════════════════════════════════════════════════════════════════════════
   GEOMETRY — persistence, provenance, and the view model behind the map
   ══════════════════════════════════════════════════════════════════════════════
   PERSISTENCE DECISION: the SIMPLIFIED line is saved with the route, and its
   provenance is saved with it as an ordinary field.

   Why save it. Raw OSRM geometry for a 4-stop Spanish route is 11,344 points /
   199 KB — a fifth of the Firestore 1 MB document limit for ONE route. Simplified
   at 0.5 km it is ~280 points / ~5.4 KB, i.e. 0.5% of the limit, and the worst
   ground error is under half a kilometre, which is roughly one screen pixel at
   national zoom. For that price a saved route shows the road it was planned on
   instead of a picture of a journey nobody drives. Re-fetching it on load was
   rejected: it is a second network round trip against a community server, on a
   screen the user did not ask to recompute, and it can silently answer with a
   DIFFERENT line from the one the itinerary was built with.

   Why the provenance must be stored with it. geo-provider marks its answer with a
   non-enumerable `source`, which JSON.stringify drops; js/route-map.js reads an
   absent label as road data. Save the line alone and a straight-line ESTIMATE
   comes back as a confident solid road line. So: the source is written as an
   ordinary field, and anything that is not exactly 'osrm' — including absent, the
   only thing every route saved by an older build can offer — is not road data and
   is not drawn as one.

   Why FLAT. Firestore has no nested arrays, so [[lat,lon],...] cannot be stored.
   The line goes in as [lat,lon,lat,lon,...] and is read back whole or not at all:
   a half-decoded line is a plausible-looking road that joins places it never
   joined, which is worse than no line. */

function flattenGeometry(points) {
    if (!Array.isArray(points)) return null;
    const out = [];
    for (let i = 0; i < points.length; i++) {
        const p = points[i];
        if (!Array.isArray(p) || p.length < 2) return null;
        const lat = Number(p[0]), lon = Number(p[1]);
        if (!isFinite(lat) || !isFinite(lon)) return null;
        if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
        out.push(lat, lon);
    }
    return out.length >= 4 ? out : null;      /* fewer than 2 points is not a line */
}

function unflattenGeometry(flat) {
    if (!Array.isArray(flat) || flat.length < 4 || flat.length % 2 !== 0) return null;
    const out = [];
    for (let i = 0; i + 1 < flat.length; i += 2) {
        const lat = Number(flat[i]), lon = Number(flat[i + 1]);
        if (!isFinite(lat) || !isFinite(lon)) return null;
        if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
        out.push([lat, lon]);
    }
    return out.length >= 2 ? out : null;
}

/* What a SAVED document may be drawn from. Only a line that says it came off the
   road graph is used; an unlabelled one is discarded rather than redrawn dashed,
   because "estimate" would still assert a shape nothing vouches for. */
function savedGeometry(saved) {
    if (!saved || saved.geometrySource !== GEOMETRY_ROAD) return null;
    return unflattenGeometry(saved.geometry);
}

/* What gets written to Firestore for the route currently on screen: the
   simplified, day-joined line, and only when it is verified road geometry. */
function storedGeometryOf(route) {
    const view = route && route.mapView;
    if (!view || view.geometryReal !== true || view.geometrySource !== GEOMETRY_ROAD) return null;
    const flat = flattenGeometry(view.geometry);
    return flat ? { geometry: flat, source: GEOMETRY_ROAD, points: flat.length / 2 } : null;
}

/* The map view is rebuilt from the plan every time — never loaded from a
   document — so day colours and marker labels cannot drift from the itinerary. */
function buildRouteMapView(route) {
    const M = mapApi();
    if (!M || !route || !route.view || !route.view.plan) return null;
    const src = (route.geometrySource === GEOMETRY_ROAD || route.geometrySource === 'straight' ||
        route.geometrySource === 'none') ? route.geometrySource : null;
    /* A line with no usable provenance is not passed in at all: buildMapView reads
       an absent label as road data, so handing it one would over-claim. */
    const geometry = (src && Array.isArray(route.geometry) && route.geometry.length >= 2)
        ? route.geometry : null;
    try {
        return M.buildMapView({
            plan: route.view.plan,
            geometry: geometry,
            geometrySource: geometry ? src : null,
            width: MAP_VIEW_WIDTH,
            height: MAP_VIEW_HEIGHT,
            toleranceKm: MAP_TOLERANCE_KM
        });
    } catch (e) {
        console.warn('Map view unavailable:', e);
        return null;
    }
}

/* ── Rendering the map ── */
function renderRouteMap(route) {
    const panel = el('routeMapPanel');
    if (!panel) return;
    const M = mapApi();
    const view = route ? route.mapView : null;
    /* Nothing to draw (a legacy plain-text route, or the module missing): hide the
       panel AND empty it, so a previous route's picture and caption cannot linger. */
    if (!M || !view) {
        panel.style.display = 'none';
        const fig0 = el('routeMapFigure');
        if (fig0) fig0.innerHTML = '';
        const leg0 = el('routeMapLegend');
        if (leg0) leg0.innerHTML = '';
        const src0 = el('routeMapSource');
        if (src0) { src0.textContent = ''; src0.className = 'map-source mono'; }
        return;
    }
    panel.style.display = '';

    const titleEl = el('routeMapTitle');
    if (titleEl) titleEl.textContent = t('map.title');

    const fig = el('routeMapFigure');
    /* renderMapSvg escapes every value it interpolates — place names in this
       project really do contain &, <, > and quotes. */
    if (fig) fig.innerHTML = M.renderMapSvg(view, trCtx());

    const nothing = view.empty === true || view.geometrySource === 'none';
    const real = view.geometryReal === true;
    const srcEl = el('routeMapSource');
    if (srcEl) {
        srcEl.textContent = nothing ? t('map.noRoute') : t(real ? 'map.sourceRoad' : 'map.sourceStraight');
        srcEl.className = 'map-source mono' + (!nothing && !real ? ' map-source-estimate' : '');
    }
    renderMapLegend(view);

    /* The fallback is stated in the notice list too, not only inside the picture:
       the SVG caption is small, and this is the app saying the line is an estimate
       in the same place it says everything else that qualifies the numbers. */
    if (!nothing && !real) {
        addItineraryNotice(t(route.savedRoute ? 'map.savedNoGeometry' : 'map.straightNotice'), 'warn');
    }
}

/* Colour is never the only carrier: each entry names its day and its endpoints. */
function renderMapLegend(view) {
    const host = el('routeMapLegend');
    if (!host) return;
    host.innerHTML = '';
    const days = Array.isArray(view.days) ? view.days : [];
    const real = view.geometryReal === true;
    for (let i = 0; i < days.length; i++) {
        const d = days[i];
        if (!d || !Array.isArray(d.path) || d.path.length < 2) continue;   /* only what is drawn */
        const item = document.createElement('span');
        item.className = 'map-legend-item';
        item.title = tf('map.dayLabel', { day: d.day, from: d.from || '', to: d.to || '' });
        const sw = document.createElement('span');
        sw.className = 'map-legend-swatch';
        /* Solid for road geometry, dashed for the estimate — the swatch matches
           the stroke it stands for. */
        if (real) { sw.style.background = d.color; sw.style.height = '4px'; }
        else { sw.style.borderTop = '3px dashed ' + d.color; sw.style.height = '0'; }
        const label = document.createElement('span');
        /* Named endpoints when there are any; a place with no name at all (an
           unresolved geocode) leaves the day number as the only honest label. */
        label.textContent = (d.from || d.to)
            ? tf('map.dayLabel', { day: d.day, from: d.from || '', to: d.to || '' })
            : tf('map.legend', { day: d.day });
        item.appendChild(sw);
        item.appendChild(label);
        host.appendChild(item);
    }
}

/* Appends one notice to the itinerary's own notice list, in its own styling.
   Built with createElement + textContent, so no string reaches innerHTML. */
function addItineraryNotice(text, level) {
    const host = el('resultItinerary');
    if (!host || !text) return;
    let list = host.querySelector('.notice-list');
    if (!list) {
        list = document.createElement('div');
        list.className = 'notice-list';
        host.insertBefore(list, host.firstChild);
    }
    const icons = { alert: '⛔', warn: '⚠️', info: 'ℹ️' };
    const box = document.createElement('div');
    box.className = 'notice notice-' + (level || 'info');
    const icon = document.createElement('span');
    icon.className = 'notice-icon';
    icon.textContent = icons[level] || icons.info;
    const body = document.createElement('span');
    body.className = 'notice-text';
    body.textContent = text;
    box.appendChild(icon);
    box.appendChild(body);
    list.appendChild(box);
}

/* ══════════════════════════════════════════════════════════════════════════════
   EXPORT — GPX / iCalendar / printable HTML, built and downloaded in the browser
   ══════════════════════════════════════════════════════════════════════════════
   js/route-export.js is pure: it takes data and returns a string. Everything here
   is the wiring — a Blob, a download attribute, and an object URL that is revoked
   once the browser has read it. No request leaves the device. */

/* The export module's user-visible words. Keys already in the dictionary are
   reused so the same sentence never exists twice in five locales. */
function exportLabels() {
    return {
        trip: t('exp.trip'),
        day: t('itin.dayN'),
        start: t('exp.start'), end: t('exp.end'), stop: t('exp.stop'), overnight: t('exp.overnight'),
        restDay: t('itin.restDay'), restDayAt: t('exp.restDayAt'),
        distance: t('itin.distance'), driveTime: t('itin.driveTime'), stops: t('itin.stops'),
        cost: t('exp.cost'), costFloor: t('exp.costFloor'),
        suggestions: t('exp.suggestions'),
        lodging: t('itin.lodgingIdea'), tip: t('itin.tip'),
        viaPoints: t('exp.viaPoints'), roadTrack: t('exp.roadTrack'),
        unlocated: t('exp.unlocated'),
        basisRoad: t('itin.sourceRoad'),
        basisPartial: t('itin.sourcePartial'),
        /* The stern one, deliberately: this is the "no road data at all" case. */
        basisEstimated: t('notice.haversine'),
        unreliable: t('exp.unreliable'),
        notAvailable: t('exp.notAvailable'),
        atLeast: t('exp.atLeast'),
        longDay: t('exp.longDay'), longDayNoCap: t('exp.longDayNoCap'),
        plannerNotes: t('exp.plannerNotes'),
        km: t('unit.km'), hour: t('unit.hour'), minute: t('unit.minute')
    };
}

/* Everything the three builders share. Returns null when there is nothing
   exportable — a legacy plain-text route, or no route at all. */
function exportContext(route) {
    if (!route || !route.view || !route.view.plan) return null;
    const plan = route.view.plan;
    if (!Array.isArray(plan.days) || plan.days.length === 0) return null;
    const meta = route.view.meta || {};
    const args = {
        plan: plan,
        labels: exportLabels(),
        matrixSource: meta.matrixSource || ''
    };
    if (meta.maxDriveMin !== null && meta.maxDriveMin !== undefined) args.maxDriveMin = meta.maxDriveMin;
    /* Only ever passed as TRUE. `false` tells the module to downgrade "unusable"
       to "estimated" — an upgrade of the claim, which the screen never made. */
    if (meta.numbersUnreliable === true) args.numbersUnreliable = true;
    return args;
}

function exportFileBase(route) {
    const fd = (route && route.formData) || {};
    const from = String(fd.startPoint || '').trim();
    const to = String(fd.endPoint || '').trim();
    const base = (from && to) ? (from + '-' + to) : (from || to);
    return base || 'travio-route';
}

/* One Blob, one download attribute, one revoke. */
function downloadText(text, mime, filename) {
    try {
        const blob = new Blob([text], { type: mime + ';charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        /* The click is dispatched synchronously but the download reads the URL
           afterwards, so the revoke waits a beat rather than racing it. */
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        return true;
    } catch (e) {
        console.error('Export failed:', e);
        showFormMsg(t('common.error'), 'err');
        return false;
    }
}

function exportGpx() {
    const X = exportApi();
    const args = exportContext(currentRoute);
    if (!X || !args) return;
    /* A <trk> is a path that was actually resolved on the road graph. The
       straight-line fallback is NEVER exported as one: it would state that the
       road goes that way. Without it the file still carries every waypoint and
       the planned per-day <rte>. */
    const view = currentRoute.mapView;
    if (view && view.geometryReal === true && view.geometrySource === GEOMETRY_ROAD) {
        const days = [];
        for (let i = 0; i < view.days.length; i++) days.push(view.days[i].points);
        args.geometry = { days: days };
    }
    downloadText(X.buildGpx(args), 'application/gpx+xml', X.safeFileName(exportFileBase(currentRoute), 'gpx'));
}

function exportIcs() {
    const X = exportApi();
    const args = exportContext(currentRoute);
    if (!X || !args) return;
    const node = el('exportStartDate');
    args.startDate = node ? node.value : '';
    args.costs = currentRoute.view.costs || null;
    args.enrichment = currentRoute.view.enrichment || null;
    const ics = X.buildIcs(args);
    /* '' means the module refused to invent a date. Offer no download. */
    if (!ics) { showExportHint(t('exp.needDate')); return; }
    downloadText(ics, 'text/calendar', X.safeFileName(exportFileBase(currentRoute), 'ics'));
}

function exportPrint() {
    const X = exportApi();
    const I = itin();
    const M = mapApi();
    const args = exportContext(currentRoute);
    if (!X || !I || !args) return;
    const view = currentRoute.view;
    const fd = currentRoute.formData || {};

    let body = '';
    const mapView = currentRoute.mapView;
    if (M && mapView) {
        body += '<div style="max-width:520px;margin:0 0 18px">' + M.renderMapSvg(mapView, trCtx()) + '</div>';
    }
    body += I.renderItineraryHtml(view, trCtx());

    const notes = [];
    /* The printed page leaves the app behind, so the caption travels with it. */
    if (mapView && mapView.geometryReal !== true && mapView.geometrySource !== 'none') {
        notes.push(t(currentRoute.savedRoute ? 'map.savedNoGeometry' : 'map.straightNotice'));
    }
    const days = (view.plan.days || []).length;
    const html = X.buildPrintHtml({
        plan: args.plan,
        labels: args.labels,
        title: (fd.startPoint || '') + ' → ' + (fd.endPoint || ''),
        subtitle: days + ' ' + t('result.days') + ' · ' + t('result.budget') +
            ': EUR ' + (fd.dailyBudget || 0),
        bodyHtml: body,
        notes: notes,
        footer: t('app.name') + ' · ' + t('app.tagline'),
        lang: currentLang
    });
    downloadText(html, 'text/html', X.safeFileName(exportFileBase(currentRoute), 'html'));
}

function showExportHint(text) {
    const hint = el('exportHint');
    if (hint) hint.textContent = text || '';
}

/* Shown for anything with a computed plan — freshly generated OR loaded from
   Firestore. A legacy plain-text route has nothing to export and hides the bar. */
function updateExportControls() {
    const bar = el('exportBar');
    if (!bar) return;
    const usable = !!(exportApi() && exportContext(currentRoute));
    bar.style.display = usable ? '' : 'none';
    if (!usable) return;
    const node = el('exportStartDate');
    const hasDate = !!(node && node.value);
    const icsBtn = el('exportIcsBtn');
    if (icsBtn) icsBtn.disabled = !hasDate;
    showExportHint(hasDate ? '' : t('exp.needDate'));
}

function initExportControls() {
    const gpx = el('exportGpxBtn');
    if (gpx) gpx.onclick = exportGpx;
    const ics = el('exportIcsBtn');
    if (ics) ics.onclick = exportIcs;
    const print = el('exportPrintBtn');
    if (print) print.onclick = exportPrint;
    const date = el('exportStartDate');
    if (date) date.addEventListener('change', updateExportControls);
}

/* ── Initialization ── */
function initRouteForm() {
    const advBtn = el('advancedToggle');
    if (advBtn) advBtn.onclick = toggleAdvancedOptions;

    const genBtn = el('generateBtn');
    if (genBtn) genBtn.onclick = generateRoute;

    const clrBtn = el('clearBtn');
    if (clrBtn) clrBtn.onclick = clearForm;

    const saveBtn = el('saveRouteBtn');
    if (saveBtn) saveBtn.onclick = saveCurrentRoute;

    const durInput = el('rfDuration');
    if (durInput) durInput.addEventListener('change', renderBudgetPerDay);

    const customChk = el('rfCustomBudget');
    if (customChk) customChk.addEventListener('change', renderBudgetPerDay);

    initExportControls();

    /* The itinerary is built in JS, so applyTranslations() cannot reach it: without
       this hook a language switch leaves every label, notice and budget verdict in
       the result pane frozen in the previous language. */
    if (typeof onLanguageChange === 'function') onLanguageChange(rerenderCurrentRoute);
}

/* Re-render the result pane in the current language. Cheap and idempotent: the view
   is already computed, only the strings change. */
function rerenderCurrentRoute() {
    if (!currentRoute) return;
    const I = itin();
    if (I && currentRoute.view) {
        currentRoute.result = I.buildPlainSummary(currentRoute.view, trCtx());
        currentRoute.language = currentLang;
    }
    displayRoute(currentRoute);
    renderBudgetPerDay();
}

/* ── Advanced Options ── */
function toggleAdvancedOptions() {
    const panel = el('advancedPanel');
    const icon  = el('advancedIcon');
    if (!panel) return;
    const show = panel.style.display === 'none';
    panel.style.display = show ? '' : 'none';
    if (icon) icon.textContent = show ? '▲' : '▼';
}

/* ── Budget per day (the rfBudgetDay{i} inputs are now actually read) ── */
function renderBudgetPerDay() {
    const container = el('budgetPerDayContainer');
    const chk = el('rfCustomBudget');
    if (!container || !chk) return;
    if (!chk.checked) { container.innerHTML = ''; return; }

    const days = parseInt(el('rfDuration').value) || 3;
    const base = parseInt(el('rfDailyBudget').value) || 100;
    const previous = readPerDayBudgets(days);
    let html = '';
    for (let i = 1; i <= days; i++) {
        const value = previous[i - 1] === null ? base : previous[i - 1];
        html += `<div class="budget-day-row">
            <span>${escapeHtml(t('form.day'))} ${i}:</span>
            <input type="number" id="rfBudgetDay${i}" value="${value}" min="0" step="10" class="budget-day-input">
            <span class="mono">EUR</span>
        </div>`;
    }
    container.innerHTML = html;
}

/* Reads rfBudgetDay1..N; null where the input is missing or unusable. */
function readPerDayBudgets(days) {
    const out = [];
    for (let i = 1; i <= days; i++) {
        const node = el('rfBudgetDay' + i);
        if (!node) { out.push(null); continue; }
        const n = Number(node.value);
        out.push(isFinite(n) && n >= 0 ? n : null);
    }
    return out;
}

/* ── Validation ── */
function validateForm() {
    const s = el('rfStartPoint').value.trim();
    const e = el('rfEndPoint').value.trim();
    const d = el('rfDestinations').value.trim();
    const dur = parseInt(el('rfDuration').value);
    const bud = parseInt(el('rfDailyBudget').value);
    return !!(s && e && d && dur > 0 && bud > 0);
}

/* ── Collect form data ── */
function collectFormData() {
    const duration = parseInt(el('rfDuration').value) || 3;
    const chk = el('rfCustomBudget');
    const D = (itin() && itin().ITIN_DEFAULTS) || { consumption: 7, fuelPrice: 1.5, lodgingPerNight: 60, mealsPerDay: 35 };
    return {
        startPoint:      el('rfStartPoint').value.trim(),
        endPoint:        el('rfEndPoint').value.trim(),
        destinations:    el('rfDestinations').value.trim(),
        tripType:        el('rfTripType').value,
        duration:        duration,
        dailyBudget:     parseInt(el('rfDailyBudget').value) || 100,
        budgets:         (chk && chk.checked) ? readPerDayBudgets(duration) : [],
        customBudget:    !!(chk && chk.checked),
        tollPreference:  el('rfTolls') ? el('rfTolls').value : 'with-tolls',
        departureTime:   el('rfDepartureTime') ? el('rfDepartureTime').value : '09:00',
        consumption:     numVal('rfConsumption', D.consumption),
        fuelPrice:       numVal('rfFuelPrice', D.fuelPrice),
        lodgingPerNight: numVal('rfLodging', D.lodgingPerNight),
        mealsPerDay:     numVal('rfMeals', D.mealsPerDay),
        language:        currentLang
    };
}

/* ── Enrichment prompt — describes the FIXED skeleton and asks for strict JSON ── */
function buildEnrichmentPrompt(fd, plan) {
    const I = itin();
    const langName = { es: 'Spanish', en: 'English', ca: 'Catalan', fr: 'French', zh: 'Simplified Chinese' }[fd.language] || 'English';
    const tripLabel = { familiar: 'family', pareja: 'couple', aventura: 'adventure', moto: 'motorcycle' }[fd.tripType] || fd.tripType;
    /* Nothing in the pipeline re-plans the route to avoid tolls (no exclude=toll on the
       road-graph calls), so asking the model to report zero would only manufacture the
       fact the app never established. The UI marks that branch "not applicable" and
       ignores tollsEur entirely — say so rather than soliciting a number to discard. */
    const tollText = fd.tollPreference === 'with-tolls'
        ? 'The traveller accepts toll motorways.'
        : 'The traveller would prefer to avoid tolls, but the itinerary above was NOT re-planned ' +
          'to avoid them — do not change any route, distance or time for it. Set tollsEur to 0; ' +
          'it is ignored in this case.';

    const lines = [];
    for (let i = 0; i < plan.days.length; i++) {
        const d = plan.days[i];
        const from = (d.startPlace && d.startPlace.name) || '?';
        const to = (d.endPlace && d.endPlace.name) || '?';
        if (!d.legs || d.legs.length === 0) {
            lines.push('DAY ' + d.day + ': rest / exploration day at ' + to + ' — no driving.');
            continue;
        }
        const stops = d.stops.map(function (s) { return s && s.name; }).filter(Boolean).join(', ');
        lines.push('DAY ' + d.day + ': ' + from + ' -> ' + to +
            ' | ' + Math.round(d.km) + ' km | ' + Math.round(d.driveMin) + ' min driving' +
            (d.startTime ? ' | departs ' + d.startTime + ', arrives ' + d.endTime : '') +
            '\n  stops today: ' + (stops || to) + '\n  overnight: ' + to);
    }

    return 'You are a local travel expert. The itinerary below has ALREADY been computed from real road data. ' +
        'It is FIXED: do not reorder it, do not add or remove stops or days, do not restate or change any distance or time.\n\n' +
        'Trip type: ' + tripLabel + '. Daily budget: EUR ' + fd.dailyBudget + '. ' + tollText + '\n' +
        'Write every piece of text in ' + langName + '.\n\n' +
        lines.join('\n') + '\n\n' +
        'For EACH of the ' + plan.days.length + ' days give: 2-4 activities suited to the trip type and to the places listed, ' +
        'breakfast / lunch / dinner ideas, one lodging suggestion that fits the daily budget, one short local tip, ' +
        'and "tollsEur" = your estimate of the motorway tolls for that day\'s driving, in euros (0 if none).\n\n' +
        'Respond with a single JSON object and nothing else: no prose, no explanation, no markdown fences. Shape:\n' +
        '{"days":[{"day":1,"activities":["...","..."],"meals":{"breakfast":"...","lunch":"...","dinner":"..."},' +
        '"lodging":"...","tip":"...","tollsEur":0}]}';
}

const ENRICH_SCHEMA = {
    type: 'object',
    properties: {
        days: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    day: { type: 'integer' },
                    activities: { type: 'array', items: { type: 'string' } },
                    meals: {
                        type: 'object',
                        properties: {
                            breakfast: { type: 'string' },
                            lunch: { type: 'string' },
                            dinner: { type: 'string' }
                        },
                        required: ['breakfast', 'lunch', 'dinner'],
                        additionalProperties: false
                    },
                    lodging: { type: 'string' },
                    tip: { type: 'string' },
                    tollsEur: { type: 'number' }
                },
                required: ['day', 'activities', 'meals', 'lodging', 'tip', 'tollsEur'],
                additionalProperties: false
            }
        }
    },
    required: ['days'],
    additionalProperties: false
};

async function callClaude(prompt) {
    const resp = await fetch(CLAUDE_PROXY, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: CLAUDE_MODEL,
            max_tokens: 8000,
            output_config: { effort: 'low', format: { type: 'json_schema', schema: ENRICH_SCHEMA } },
            messages: [{ role: 'user', content: prompt }]
        })
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    let text = '';
    if (data && Array.isArray(data.content)) {
        for (let i = 0; i < data.content.length; i++) {
            if (data.content[i] && data.content[i].type === 'text') text += data.content[i].text;
        }
    }
    if (!text) throw new Error('empty-response');
    return text;
}

/* ── The pipeline ── */
async function generateRoute() {
    if (!validateForm()) { showFormMsg(t('form.required'), 'err'); return; }
    if (isGenerating) return;
    const I = itin();
    if (!I || typeof window.planRoute !== 'function' || typeof window.geocodePlaces !== 'function') {
        showRouteError(t('result.error'));
        return;
    }

    isGenerating = true;
    const myGen = beginGeneration();
    const genBtn = el('generateBtn');
    const clrBtn = el('clearBtn');
    genBtn.disabled = true;
    genBtn.textContent = t('form.generating');
    if (clrBtn) clrBtn.disabled = true;
    showLoadingState();

    const fd = collectFormData();

    try {
        /* 1 — destinations */
        const stopNames = I.parseDestinations(fd.destinations);
        const names = [fd.startPoint].concat(stopNames, [fd.endPoint]);

        /* 2 — geocoding, one name at a time so the progress bar is honest.
               geo-provider serialises and rate-limits every request globally. */
        const geoOpts = { language: currentLang };
        const places = [];
        for (let i = 0; i < names.length; i++) {
            setProgress((i / (names.length + 2)) * 100, t('progress.geocoding'),
                tf('progress.geocodingItem', { done: i + 1, total: names.length, name: names[i] }));
            const one = await geocodePlaces([names[i]], geoOpts);
            const got = (one && one[0]) ? one[0]
                : { name: names[i], lat: null, lon: null, resolved: false, source: 'osm' };
            places.push(got);
            /* Say where it landed the moment it lands, not only in the itinerary:
               the user watching the progress bar is already looking at this line. */
            if (got.displayName) {
                setProgress(((i + 1) / (names.length + 2)) * 100, t('progress.geocoding'),
                    tf('progress.geocodedAs', { name: names[i], label: got.displayName }));
            }
        }

        /* Which of those, if any, sits far from the rest of the trip. Pure and
           synchronous — no network, no second geocode — and it is the only thing on
           the page that can explain 24,179 km round northern Spain. The provider
           owns the geometry; a build without it simply reports nothing rather than
           the wiring inventing a threshold of its own. */
        let geoOutliers = [];
        try {
            const G = (typeof window !== 'undefined' && window.TravioGeo) ? window.TravioGeo : null;
            if (G && typeof G.geocodeOutliers === 'function') {
                const found = G.geocodeOutliers(places);
                if (Array.isArray(found)) geoOutliers = found;
            }
        } catch (e) {
            console.warn('Outlier check unavailable:', e);
            geoOutliers = [];
        }

        /* 3 — road distance matrix */
        setProgress((names.length / (names.length + 3)) * 100, t('progress.matrix'), '');
        const matrix = await distanceMatrix(places, geoOpts);

        /* 4 — the deterministic skeleton: THIS is the route */
        setProgress(((names.length + 1) / (names.length + 3)) * 100, t('progress.planning'), '');
        const plan = planRoute({
            start: places[0],
            end: places[places.length - 1],
            stops: places.slice(1, places.length - 1),
            matrix: matrix,
            days: fd.duration,
            departureTime: fd.departureTime,
            maxDriveMinPerDay: MAX_DRIVE_MIN_PER_DAY
        });

        /* 4b — ONE road-geometry request, for the map and nothing else.
           It runs AFTER planRoute because the line has to follow the order the
           engine computed, and it is asked for exactly once per generation: the
           export buttons and every re-render reuse this answer. A failure here
           costs the shape of the line and nothing else. */
        let geometry = null, geometrySource = 'none';
        if (typeof window.routeGeometry === 'function' &&
            Array.isArray(plan.order) && plan.order.length >= 2) {
            setProgress(((names.length + 2) / (names.length + 3)) * 100, t('progress.mapping'), '');
            try {
                const line = await routeGeometry(plan.order, geoOpts);
                if (Array.isArray(line) && line.length >= 2) {
                    geometry = line;
                    /* The provider's flag is authoritative; an unlabelled line is
                       NOT assumed to be road data. */
                    geometrySource = (line.source === GEOMETRY_ROAD) ? GEOMETRY_ROAD : 'straight';
                } else {
                    geometrySource = 'none';
                }
            } catch (e) {
                console.warn('Route geometry unavailable:', e);
                geometry = null;
                geometrySource = 'none';
            }
        }
        /* The zombie-route guard covers this await too: the user can clear the
           form or load a saved route while the geometry is in flight. */
        if (!isCurrentGeneration(myGen)) return;

        /* 5 — costs + render, with no model involvement whatsoever */
        const viewArgs = {
            plan: plan,
            requestedStops: stopNames,
            startName: fd.startPoint,
            endName: fd.endPoint,
            places: places,
            geoOutliers: geoOutliers,
            matrixSource: matrix.source,
            matrixFilledCells: matrix.filledCells,
            matrixOsrmCells: matrix.osrmCells,
            maxDriveMin: MAX_DRIVE_MIN_PER_DAY,
            tripType: fd.tripType,
            departureTime: fd.departureTime,
            dailyBudget: fd.dailyBudget,
            budgets: fd.budgets,
            consumption: fd.consumption,
            fuelPrice: fd.fuelPrice,
            lodgingPerNight: fd.lodgingPerNight,
            mealsPerDay: fd.mealsPerDay,
            tollsEnabled: fd.tollPreference === 'with-tolls',
            tollPreference: fd.tollPreference,
            t: t, tf: tf
        };
        if (!isCurrentGeneration(myGen)) return;   // cleared / another route loaded
        const baseView = I.buildItineraryView(viewArgs);
        currentRoute = makeRoute(fd, baseView, geometry, geometrySource);
        setProgress(100, t('progress.done'), '');
        displayRoute(currentRoute);

        /* 6 — enrichment. Failure here changes nothing about the itinerary. */
        setEnrichBusy(true);
        let enrichment = null;
        try {
            const raw = await callClaude(buildEnrichmentPrompt(fd, plan));
            enrichment = I.parseEnrichment(raw, plan.days.length);
        } catch (e) {
            console.warn('Enrichment unavailable:', e);
            enrichment = I.parseEnrichment(null, plan.days.length);
            enrichment.error = 'unavailable';
        }
        setEnrichBusy(false);
        /* The user may have cleared the form or loaded a saved route while this was in
           flight. Writing now would resurrect a dead itinerary or clobber theirs. */
        if (!isCurrentGeneration(myGen)) return;
        viewArgs.enrichment = enrichment;
        const finalView = I.buildItineraryView(viewArgs);
        /* The same line, not a second request. */
        currentRoute = makeRoute(fd, finalView, geometry, geometrySource);
        displayRoute(currentRoute);

    } catch (e) {
        console.error('Route generation error:', e);
        if (isCurrentGeneration(myGen)) showRouteError(t('result.error') + ': ' + e.message);
    } finally {
        isGenerating = false;
        genBtn.disabled = false;
        genBtn.textContent = t('form.generate');
        if (clrBtn) clrBtn.disabled = false;
        setEnrichBusy(false);
        hideLoadingState();
    }
}

function makeRoute(fd, view, geometry, geometrySource) {
    const I = itin();
    const route = {
        formData: fd,
        view: view,
        structured: I.serialiseView(view),
        result: I.buildPlainSummary(view, trCtx()),
        language: currentLang,
        geometry: Array.isArray(geometry) ? geometry : null,
        geometrySource: geometrySource || null,
        savedRoute: false
    };
    route.mapView = buildRouteMapView(route);
    return route;
}

/* ── Display ── */
function displayRoute(route) {
    const empty   = el('resultEmpty');
    const loading = el('resultLoading');
    const content = el('resultContent');
    const saveBtn = el('saveRouteBtn');
    const errDiv  = el('resultError');

    if (empty)   empty.style.display = 'none';
    if (loading) loading.style.display = 'none';
    if (errDiv)  errDiv.style.display = 'none';
    if (!content) return;
    content.style.display = '';

    const fdta = route.formData || {};
    const days = (route.view && route.view.plan && route.view.plan.days.length) || fdta.duration || 0;
    const header = el('resultHeader');
    if (header) {
        header.innerHTML =
            `<strong>${escapeHtml(t('result.route'))}:</strong> ${escapeHtml(fdta.startPoint || '')} &rarr; ${escapeHtml(fdta.endPoint || '')}` +
            `<br><span class="result-meta">${days} ${escapeHtml(t('result.days'))} &bull; ` +
            `${escapeHtml(t('tripTypeLabel.' + fdta.tripType) || fdta.tripType || '')} &bull; ` +
            `${escapeHtml(t('result.budget'))}: EUR ${escapeHtml(String(fdta.dailyBudget || 0))}/${escapeHtml(t('form.day')).toLowerCase()}</span>`;
    }

    const structuredEl = el('resultItinerary');
    const bodyEl = el('resultBody');
    const I = itin();
    if (route.view && I) {
        if (structuredEl) {
            structuredEl.innerHTML = I.renderItineraryHtml(route.view, trCtx());
            structuredEl.style.display = '';
        }
        if (bodyEl) { bodyEl.textContent = ''; bodyEl.style.display = 'none'; }
    } else {
        /* Legacy plain-text route (saved before the routing engine existed). */
        if (structuredEl) { structuredEl.innerHTML = ''; structuredEl.style.display = 'none'; }
        if (bodyEl) { bodyEl.textContent = route.result || ''; bodyEl.style.display = ''; }
    }

    /* After the itinerary HTML is in place: the map notice is appended to the
       notice list that renderItineraryHtml just wrote. */
    renderRouteMap(route);
    updateExportControls();

    if (saveBtn) saveBtn.style.display = '';
}

/* ── Progress / loading ── */
function showLoadingState() {
    const empty   = el('resultEmpty');
    const loading = el('resultLoading');
    const content = el('resultContent');
    if (empty)   empty.style.display = 'none';
    if (content) content.style.display = 'none';
    if (loading) loading.style.display = '';
    setProgress(0, t('progress.geocoding'), '');
    const note = el('progressNote');
    if (note) note.textContent = t('progress.ratePolicy');
}

function hideLoadingState() {
    const loading = el('resultLoading');
    if (loading) loading.style.display = 'none';
}

function setProgress(pct, title, detail) {
    const bar = el('progressBar');
    if (bar) bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
    const step = el('progressStep');
    if (step) step.textContent = title || '';
    const det = el('progressDetail');
    if (det) det.textContent = detail || '';
}

function setEnrichBusy(busy) {
    const banner = el('enrichStatus');
    if (!banner) return;
    banner.style.display = busy ? '' : 'none';
    if (busy) banner.textContent = t('progress.enriching');
}

function showRouteError(msg) {
    const content = el('resultContent');
    const empty   = el('resultEmpty');
    const loading = el('resultLoading');
    if (content) content.style.display = 'none';
    if (empty)   empty.style.display = 'none';
    if (loading) loading.style.display = 'none';

    const errDiv = el('resultError');
    if (errDiv) {
        errDiv.style.display = '';
        errDiv.textContent = msg;
    }
}

function showFormMsg(msg, type) {
    const node = el('formMsg');
    if (!node) return;
    node.textContent = msg;
    node.className = 'form-msg ' + type;
    node.style.display = '';
    setTimeout(function () { node.style.display = 'none'; }, 4000);
}

/* ── Save route to Firestore ── */
async function saveCurrentRoute() {
    if (!currentRoute || !currentUser) return;
    const btn = el('saveRouteBtn');
    btn.disabled = true;
    try {
        const fd = currentRoute.formData || {};
        const stored = storedGeometryOf(currentRoute);
        await fsSaveRoute({
            startPoint:     fd.startPoint || '',
            endPoint:       fd.endPoint || '',
            destinations:   fd.destinations || '',
            tripType:       fd.tripType || 'familiar',
            duration:       fd.duration || 0,
            dailyBudget:    fd.dailyBudget || 0,
            tollPreference: fd.tollPreference || 'with-tolls',
            departureTime:  fd.departureTime || '09:00',
            /* Cost assumptions and per-day budgets are part of the answer: without them
               a reloaded route silently regenerates against the defaults. */
            consumption:     numOrNull(fd.consumption),
            fuelPrice:       numOrNull(fd.fuelPrice),
            lodgingPerNight: numOrNull(fd.lodgingPerNight),
            mealsPerDay:     numOrNull(fd.mealsPerDay),
            customBudget:    !!fd.customBudget,
            budgets:         Array.isArray(fd.budgets)
                ? fd.budgets.map(function (v) { return numOrNull(v); }) : [],
            result:         currentRoute.result || '',
            structured:     currentRoute.structured || null,
            language:       currentRoute.language || currentLang,
            /* The simplified road line and its provenance, or explicit nulls. A
               line is only ever stored WITH the label that says where it came
               from — see the persistence note at the top of this file. Firestore
               rejects undefined, so nothing here is left out. */
            geometry:       stored ? stored.geometry : null,
            geometrySource: stored ? stored.source : null,
            geometryPoints: stored ? stored.points : null
        });
        showFormMsg(t('result.routeSaved'), 'ok');
    } catch (e) {
        console.error('Save error:', e);
        showFormMsg(t('common.error'), 'err');
    } finally {
        btn.disabled = false;
    }
}

/* ── Clear form ── */
function clearForm() {
    invalidateGeneration();     // any in-flight enrichment must not write back
    el('rfStartPoint').value = '';
    el('rfEndPoint').value = '';
    el('rfDestinations').value = '';
    el('rfTripType').value = 'familiar';
    el('rfDuration').value = '3';
    el('rfDailyBudget').value = '100';
    const tolls = el('rfTolls');
    if (tolls) tolls.value = 'with-tolls';
    const time = el('rfDepartureTime');
    if (time) time.value = '09:00';
    const chk = el('rfCustomBudget');
    if (chk) { chk.checked = false; renderBudgetPerDay(); }

    currentRoute = null;
    el('resultEmpty').style.display = '';
    el('resultContent').style.display = 'none';
    el('resultLoading').style.display = 'none';
    const structuredEl = el('resultItinerary');
    if (structuredEl) structuredEl.innerHTML = '';
    const mapPanel = el('routeMapPanel');
    if (mapPanel) mapPanel.style.display = 'none';
    const mapFig = el('routeMapFigure');
    if (mapFig) mapFig.innerHTML = '';
    const mapLegend = el('routeMapLegend');
    if (mapLegend) mapLegend.innerHTML = '';
    updateExportControls();
    const saveBtn = el('saveRouteBtn');
    if (saveBtn) saveBtn.style.display = 'none';
    const errDiv = el('resultError');
    if (errDiv) errDiv.style.display = 'none';
}

/* ── Saved routes ── */
async function loadSavedRoutesList() {
    if (!currentUser) return;
    const container = el('savedRoutesList');
    if (!container) return;

    try {
        const routes = await fsGetUserRoutes(currentUser.uid);
        if (routes.length === 0) {
            container.innerHTML = `<p class="empty-text" data-i18n="routes.noRoutes">${escapeHtml(t('routes.noRoutes'))}</p>`;
            return;
        }
        container.innerHTML = routes.map(function (r) {
            const date = r.createdAt && r.createdAt.toDate ? r.createdAt.toDate().toLocaleDateString() : '';
            return `<div class="route-card">
                <div class="route-card-info">
                    <strong>${escapeHtml(r.startPoint)} &rarr; ${escapeHtml(r.endPoint)}</strong>
                    <span class="route-card-meta">${r.duration} ${escapeHtml(t('result.days'))} &bull; ${escapeHtml(date)}</span>
                </div>
                <div class="route-card-actions">
                    <button class="btn btn-sm btn-outline" onclick="viewSavedRoute('${r.id}')">${escapeHtml(t('routes.load'))}</button>
                    <button class="btn btn-sm btn-ghost" onclick="deleteSavedRoute('${r.id}')">${escapeHtml(t('routes.delete'))}</button>
                </div>
            </div>`;
        }).join('');
    } catch (e) {
        console.error('Load routes error:', e);
        container.innerHTML = '<p class="empty-text">Error</p>';
    }
}

async function viewSavedRoute(routeId) {
    try {
        const doc = await db.collection('routes').doc(routeId).get();
        if (!doc.exists) return;
        const r = doc.data();
        const I = itin();
        invalidateGeneration();     // a pending enrichment must not clobber this route
        /* New saves carry a structured plan; older ones only have the plain text. */
        const view = (I && I.isStructuredRoute(r)) ? I.viewFromSaved(r) : null;
        /* Stored road line, or nothing. A document written by any earlier build
           carries no geometry and no provenance; absent means unknown, the map
           falls back to straight lines and SAYS so. No geometry request is made
           for a saved route — the user did not ask to recompute it. */
        const line = savedGeometry(r);
        currentRoute = {
            formData: r, view: view, structured: r.structured || null,
            result: r.result || '', language: r.language,
            geometry: line, geometrySource: line ? GEOMETRY_ROAD : null,
            savedRoute: true
        };
        currentRoute.mapView = buildRouteMapView(currentRoute);

        el('rfStartPoint').value   = r.startPoint || '';
        el('rfEndPoint').value     = r.endPoint || '';
        el('rfDestinations').value = r.destinations || '';
        el('rfTripType').value     = r.tripType || 'familiar';
        el('rfDuration').value     = r.duration || 3;
        el('rfDailyBudget').value  = r.dailyBudget || 100;
        if (el('rfTolls') && r.tollPreference) el('rfTolls').value = r.tollPreference;
        if (el('rfDepartureTime') && r.departureTime) el('rfDepartureTime').value = r.departureTime;

        /* Restore the assumptions the route was costed with, so regenerating it does
           not silently swap in the defaults. */
        setVal('rfConsumption', r.consumption);
        setVal('rfFuelPrice', r.fuelPrice);
        setVal('rfLodging', r.lodgingPerNight);
        setVal('rfMeals', r.mealsPerDay);
        const chk = el('rfCustomBudget');
        if (chk) {
            chk.checked = !!r.customBudget;
            renderBudgetPerDay();
            if (chk.checked && Array.isArray(r.budgets)) {
                for (let i = 0; i < r.budgets.length; i++) setVal('rfBudgetDay' + (i + 1), r.budgets[i]);
            }
        }

        showView('userHomeView');
        applyTranslations();
        displayRoute(currentRoute);
    } catch (e) {
        console.error('View route error:', e);
    }
}

async function deleteSavedRoute(routeId) {
    if (!confirm(t('routes.confirmDelete'))) return;
    try {
        await fsDeleteRoute(routeId);
        await loadSavedRoutesList();
    } catch (e) {
        console.error('Delete route error:', e);
    }
}
