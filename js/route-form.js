/* ── Route Form ── compute-then-enrich pipeline ──
 *
 * The route is COMPUTED, not narrated:
 *   1. parse destinations
 *   2. geocode every place (geo-provider, rate limited — progress is shown)
 *   3. build the road distance matrix (geo-provider)
 *   4. planRoute() (route-engine, pure + deterministic) -> the itinerary skeleton
 *   5. compute costs in JS and render the itinerary
 *   6. ONLY THEN ask Claude to enrich that fixed skeleton with prose
 *
 * The model can never change the order, the days, the distances or the times:
 * steps 1-5 finish and are already on screen before step 6 is even sent.
 */

const CLAUDE_PROXY = 'https://sitoclaude-proxy.sito041971.workers.dev';
const CLAUDE_MODEL = 'claude-opus-5';
const MAX_DRIVE_MIN_PER_DAY = 360;      // quality bar B6 — 6 h/day cap

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
    const tollText = fd.tollPreference === 'with-tolls'
        ? 'The traveller accepts toll motorways.'
        : 'The traveller avoids tolls, so tollsEur must be 0 for every day.';

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
            places.push(one && one[0] ? one[0] : { name: names[i], lat: null, lon: null, resolved: false, source: 'osm' });
        }

        /* 3 — road distance matrix */
        setProgress((names.length / (names.length + 2)) * 100, t('progress.matrix'), '');
        const matrix = await distanceMatrix(places, geoOpts);

        /* 4 — the deterministic skeleton: THIS is the route */
        setProgress(((names.length + 1) / (names.length + 2)) * 100, t('progress.planning'), '');
        const plan = planRoute({
            start: places[0],
            end: places[places.length - 1],
            stops: places.slice(1, places.length - 1),
            matrix: matrix,
            days: fd.duration,
            departureTime: fd.departureTime,
            maxDriveMinPerDay: MAX_DRIVE_MIN_PER_DAY
        });

        /* 5 — costs + render, with no model involvement whatsoever */
        const viewArgs = {
            plan: plan,
            requestedStops: stopNames,
            startName: fd.startPoint,
            endName: fd.endPoint,
            places: places,
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
        currentRoute = makeRoute(fd, baseView);
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
        currentRoute = makeRoute(fd, finalView);
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

function makeRoute(fd, view) {
    const I = itin();
    return {
        formData: fd,
        view: view,
        structured: I.serialiseView(view),
        result: I.buildPlainSummary(view, trCtx()),
        language: currentLang
    };
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
            language:       currentRoute.language || currentLang
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
        currentRoute = { formData: r, view: view, structured: r.structured || null, result: r.result || '', language: r.language };

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
