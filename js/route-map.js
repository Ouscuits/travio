/* ── Travio Route Map ── Web Mercator projection · Douglas-Peucker · inline SVG ── */
/*
 * Classic script. No ES modules, no bundler, no npm dependency, NO MAP LIBRARY.
 * Works in the browser (attaches to `window`) and in Node for tests
 * (`module.exports`). NOTHING here touches the DOM, the network, Date.now() or
 * Math.random(): every function is pure, so the same input always produces the
 * same bytes and the whole file is unit-testable in Node.
 *
 * WHY INLINE SVG AND NOT LEAFLET
 *   The app is a PWA served from GitHub Pages with vendored SDKs, relative paths
 *   and no build step. A CDN <script> would break the offline install and add a
 *   third-party origin to a page that currently has none. An SVG string needs
 *   nothing: it is markup, it prints, it scales, and it survives being saved into
 *   a Firestore document.
 *
 * WHY WEB MERCATOR
 *   x = (lon + 180) / 360
 *   y = 0.5 - ln((1 + sin lat) / (1 - sin lat)) / (4 PI)
 *   This is the projection every map tile in the world uses. Plotting raw lat/lon
 *   on a square canvas stretches Spain sideways by ~25% and a Nordic trip by ~50%,
 *   and the resulting shape does not match the map the traveller has in their head.
 *
 * WHY SIMPLIFICATION IS MANDATORY, NOT AN OPTIMISATION
 *   Measured against live OSRM on a 4-stop Spanish route, the real overview
 *   geometry is 11,344 points / 199 KB. That is a fifth of the Firestore 1 MB
 *   document limit for ONE saved route, and it is 11,344 <path> coordinates the
 *   phone has to lay out. Douglas-Peucker in projected units:
 *       tol 0.25 km -> 423 pts, max error 0.25 km
 *       tol 0.50 km -> 252 pts, max error 0.49 km   <- default
 *       tol 1.00 km -> 131 pts, max error 0.99 km
 *   0.5 km of error is roughly one screen pixel at national zoom: invisible on a
 *   phone, 36x smaller on the wire. Both `view.geometry` and `view.geometryDoc`
 *   hand back the SIMPLIFIED line, precisely so that the thing a caller persists
 *   is the small one.
 *
 *   TWO different payloads come out of one simplification, and they are not the
 *   same size — quoting one for the other is how a 5 KB line gets budgeted at
 *   2.8 KB:
 *     · what the SVG DRAWS — 2-decimal viewBox units, ~14.5 bytes a point, so the
 *       default tolerance ships ~4.1 KB of <path d="...">;
 *     · what Firestore STORES — `view.geometryDoc`, 5-decimal lat/lon (the
 *       precision decodePolyline gives), ~19 bytes a point, so ~5.4 KB plus about
 *       60 bytes of provenance.
 *   Both are reported: `view.geometryBytes` is the stored one, because that is
 *   the one with a 1 MB limit attached to it, and a `persist-oversize:N` warning
 *   fires above 64 KB whatever the cause.
 *
 * WHY THE SIMPLIFIER IS ITERATIVE
 *   Douglas-Peucker is textbook-recursive and blows the stack on an 11k-point
 *   input (observed: RangeError). The implementation below uses an explicit
 *   stack; depth is bounded by the heap, not by the call stack.
 *
 * THE FALLBACK IS A FLAG, NOT A SILENCE
 *   When no road geometry is available the map draws straight lines between the
 *   stops — which is a picture of something nobody will ever drive. The view
 *   carries `geometryReal: false` and `geometrySource: 'straight'`, the SVG
 *   draws the line DASHED and prints the reason, and the caller is expected to
 *   surface it too. This project's rule: an estimate is never presented as a
 *   measurement.
 *
 * PROVENANCE IS AN ALLOWLIST, AND IT TRAVELS WITH THE LINE
 *   `geometryReal` is true for EXACTLY ONE label, `'osrm'`, matched literally.
 *   Absence is not consent: an unlabelled line is `'unknown'` and renders as an
 *   estimate. This was a real defect, found across the module's own documented
 *   save/reload cycle — round 2 of review:
 *     1. OSRM down -> straight-line geometry, correctly dashed and captioned;
 *     2. the caller persists the points, and a bare `[[lat,lon],...]` array
 *        cannot carry a label — `JSON.stringify` drops every non-index property,
 *        so geo-provider's NON-ENUMERABLE `source` marker cannot reach Firestore;
 *     3. the route is reopened, the label is gone, and the old denylist read
 *        "not 'straight' and not 'none'" as road data. The estimate came back a
 *        measurement: solid line, caption gone.
 *   The same hole trusted every unrecognised label — including `'haversine'`,
 *   which is this project's own word for a straight-line estimate.
 *   So: **persist `view.geometryDoc`, not `view.geometry`.** The doc is a plain
 *   JSON object carrying the points AND their provenance, and feeding it back
 *   into `buildMapView({ geometry: doc })` reproduces the original verdict
 *   exactly. `view.geometry` stays a bare point array for drawing and GPX, where
 *   a wrapper would be in the way.
 *   A stored `real` flag is never trusted on the way back in: the label is the
 *   evidence, the boolean is only its conclusion, and re-deriving it costs
 *   nothing.
 *
 * ONE BAD VERTEX MUST NOT SHRINK THE WHOLE MAP
 *   The fit is computed over every drawn point, so a single corrupt vertex in an
 *   otherwise correct polyline used to collapse the scale by 24x — a Madrid-
 *   Barcelona route rendered as a 25-unit smudge, still solid, still captioned as
 *   road data. The geo layer verifies polyline ENDPOINTS, not middles, partly on
 *   the assumption that this module would not magnify a bad middle. So a dense
 *   line gets an outlier-resistant fit (median absolute deviation), under three
 *   guards that make a false positive on real geography essentially impossible —
 *   see robustLineBounds(). Excluded points are still DRAWN (clipped by the SVG
 *   viewport, so the anomaly stays visible as a line running off the edge) and
 *   counted in `view.warnings` as `geometry-outliers:N`. Nothing is deleted and
 *   nothing is hidden.
 *
 * TIME IS BOUNDED BY DECIMATION, BECAUSE DOUGLAS-PEUCKER IS O(n^2) IN THE WORST
 * CASE
 *   Typical road geometry is O(n log n) — 10k real points simplify in ~4 ms, and
 *   200k in 36 ms. But the cost is quadratic on a shape where the deepest
 *   deviation always sits next to the end of the range, so every split peels off
 *   one point. Reproduced here with decaying alternating spikes (independently
 *   measured by review at 176 ms / 693 ms / 11.8 s / 197 s):
 *        5k ->    39 ms       20k ->    642 ms
 *       10k ->   132 ms       40k ->  9,131 ms   <- on the main thread
 *   That input can arrive from a corrupt or hostile routing server, so it has to
 *   be bounded rather than hoped away. Above MAX_SIMPLIFY_POINTS the line is
 *   first decimated UNIFORMLY to the cap — 40k then costs 891 ms instead of 9.1 s
 *   — which is safe in practice, because real overview geometry is ~88 m per
 *   point, so even a 3,000 km trip decimates to ~235 m per point, still far below
 *   a 500 m tolerance. It is never silent: `simplification.decimatedFrom` plus a
 *   `geometry-decimated:N` warning, and the stated error bound then applies to
 *   the decimated line, which is the honest claim. `maxPoints: 0` opts out.
 *
 *   KNOWN LIMITATION, accepted on severity: the cap bounds the worst case to the
 *   cost at 15,000 points, which is ~0.9 s of main thread on the same adversarial
 *   shape, not to something imperceptible. Lowering the cap further would start
 *   decimating REAL routes (a live 4-stop Spanish route is 11,344 points), and
 *   trading a certain loss of fidelity on every honest route against a rarer
 *   stall on a hostile one is the wrong trade. Moving the simplifier off the main
 *   thread is the actual fix and needs a Worker, which this no-build-step PWA
 *   does not have.
 *
 * WHAT THE TOLERANCE ACTUALLY BOUNDS (recorded, not fixed)
 *   The error is measured in the projection the map DRAWS in, so a kept segment
 *   is a straight line on the map — a rhumb line, not a great circle. On short
 *   segments the two coincide; on very long ones they diverge quadratically.
 *   Measured worst case: a 154 km simplified segment reported 0.497 km of
 *   deviation while the true great-circle offset was 0.809 km. This is invisible
 *   on any map at this scale and irrelevant to the SVG, which is drawn in exactly
 *   that projection. It matters only to a consumer that re-interpolates the
 *   points along great circles — js/route-export.js does consume the per-day
 *   points — where a segment can sit up to ~0.3 km further from the road than
 *   this module's number suggests.
 *
 * TRANSLATION KEYS read through `ctx.t` (all fall back to the key itself, so the
 * module is usable before i18n.js carries them):
 *   map.title  map.noRoute  map.sourceRoad  map.sourceStraight
 *   map.straightLineNote  map.dayLabel {day}{from}{to}  map.legend {day}
 *
 * KNOWN LIMITATION — the unknown-provenance state has no words of its own.
 *   A line whose label was lost is dashed, is excluded from every road claim,
 *   appears in `view.warnings` as `geometry-source-unknown:X`, and is marked
 *   `data-geometry-real="false"` / `data-geometry-source="unknown"` on the SVG
 *   root — but it prints NO caption, because the only captions that exist say
 *   "straight lines between the stops", and an unlabelled polyline is not known
 *   to be straight. Printing that would be a fresh falsehood on top of the lost
 *   label, so the module says nothing about the shape instead.
 *   The user is still told: js/route-form.js renders a full-sentence notice for
 *   any `geometryReal !== true`, on screen and in the printed export.
 *   The fix is two i18n keys — `map.sourceUnknown` and `map.unknownSourceNote`,
 *   wording along the lines of "the origin of this line could not be confirmed;
 *   treat it as an estimate" — in all five locales. Not done here because
 *   js/i18n.js is owned by another builder and was mid-edit; a caption that lies
 *   was the worse of the two available compromises.
 *
 * `view.warnings` — codes for the caller to surface, in the engine's
 * `code:detail` style. Nothing here is rendered by this module beyond the
 * caption, so a caller that ignores them shows a map that is still honest, but
 * less specific:
 *   geometry-straight          no road geometry; straight lines between stops
 *   geometry-source-unknown:X  provenance absent or unrecognised; drawn dashed
 *   geometry-outliers:N        N points excluded from the fit as corrupt spikes
 *   geometry-decimated:N       input was N points, decimated to the time cap
 *   geometry-unsimplified      toleranceKm <= 0, so every vertex was kept
 *   persist-oversize:N         geometryDoc is N bytes, over the 64 KB budget
 *   markers-without-day        the plan has no days, so markers name none
 *
 * KNOWN LIMITATION: a route crossing the antimeridian (Fiji, Chukotka) projects
 * into a bounding box that spans the whole world and the line runs the wrong way
 * round the globe. It does not throw and no number is falsified; it is simply
 * drawn badly. Travio is a European car planner, so this is accepted.
 */

(function () {
    'use strict';

    /* ── Constants ── */
    const EARTH_CIRCUM_KM  = 40075.016686;   /* equatorial, = 1.0 projected unit  */
    const MAX_MERC_LAT     = 85.05112878;    /* beyond this Mercator y -> Infinity */
    const DEFAULT_TOL_KM   = 0.5;
    const DEFAULT_WIDTH    = 640;            /* viewBox units, NOT pixels          */
    const DEFAULT_HEIGHT   = 400;
    const DEFAULT_PADDING  = 28;
    const COORD_DECIMALS   = 2;              /* SVG path precision (~0.01 unit)    */

    /* Douglas-Peucker is quadratic in the worst case; above this the line is
       decimated uniformly first, so the render time is bounded by ~400 ms even on
       an adversarial input. Chosen to sit above the 11,344 points a real 4-stop
       Spanish route produces, so no real trip is ever decimated. */
    const MAX_SIMPLIFY_POINTS = 15000;

    /* Outlier-resistant fit. FOUR guards, because a wrong exclusion pushes real
       geography off the map, which is a worse bug than the one being fixed:
         · only points of the drawn LINE are ever excluded — a stop marker is
           never dropped from the fit, so a legitimately distant destination is
           safe by construction;
         · the point must be far from the route's median — OUTLIER_MAD_FACTOR
           times the median absolute deviation;
         · it must be a SPIKE, not part of a run: its distance from the chord
           between its own two neighbours must be at least half of how far it sits
           from the median. This is the guard that tells a corrupt vertex (goes
           there and comes straight back) from a legitimate distant arm (the route
           travels along it, so every point is near its neighbours' chord). Only
           interior points can be tested, which is the right split of labour: the
           geo layer verifies polyline ENDPOINTS, this one covers the middles;
         · excluding must actually rescue the map — if the scale barely moves, the
           point was not distorting anything and the flag would be noise. */
    const MIN_POINTS_FOR_ROBUST_FIT = 5;
    const OUTLIER_MAD_FACTOR        = 12;
    const OUTLIER_SPIKE_SHARE       = 0.5;
    const MAX_OUTLIER_SHARE         = 0.01;
    const MIN_SCALE_GAIN            = 2;

    /* A persisted map line past this is a Firestore risk worth naming out loud.
       64 KB is 6% of the 1 MB document limit; the default tolerance produces ~5 KB. */
    const PERSIST_BUDGET_BYTES = 64 * 1024;

    /* The ONLY label that means road data. Matched literally: 'OSRM', ' osrm ' and
       '' are all unknown, which fails towards captioning a real route as an
       estimate rather than the reverse. */
    const REAL_GEOMETRY_SOURCE = 'osrm';
    const KNOWN_SOURCES = { osrm: 1, straight: 1, none: 1, unknown: 1 };

    /* Day colours. The palette cycles, so day 9 reuses day 1's colour — but no
       information is carried by colour ALONE: every path has a <title> naming its
       day and its endpoints, and every marker is labelled. */
    const DAY_COLORS = [
        '#10B981', '#0EA5E9', '#F59E0B', '#8B5CF6',
        '#EF4444', '#14B8A6', '#EC4899', '#84CC16'
    ];
    const BG_COLOR         = '#ECFDF5';
    const STROKE_DARK      = '#1A1A1A';
    const MUTED_COLOR      = '#6B7280';
    /* A marker belonging to no day of the plan is grey, not day-1 emerald: it is
       not a day-1 stop and must not be coloured as one. */
    const UNASSIGNED_COLOR = '#9CA3AF';

    /* ── Tiny pure helpers (same discipline as itinerary-render.js) ── */
    function num(v, def) {
        if (v === null || v === undefined || v === '') return def;
        const n = Number(v);
        return isFinite(n) ? n : def;
    }
    function pos(v, def) { const n = num(v, NaN); return isFinite(n) && n > 0 ? n : def; }
    function nonNeg(v, def) { const n = num(v, NaN); return isFinite(n) && n >= 0 ? n : def; }

    /* Escaping markup is only half the job. XML 1.0 forbids most C0 control
       characters OUTRIGHT — there is no entity for them — so a place name
       containing U+000B renders happily in an HTML page and then makes the same
       SVG fail a standalone XML parse ("PCDATA invalid Char value 11"). That
       breaks save, print and export: precisely the artefacts the fallback caption
       exists in order to survive inside. Unpaired surrogates and the two
       permanently-unassigned code points fail the same way.
       They become a space rather than being deleted, so "A<VT>B" stays two words
       instead of silently becoming "AB". */
    /* XML 1.0 Char production, inverted: #x0-#x8, #xB, #xC, #xE-#x1F, plus DEL
       and the two noncharacters. Written with \u escapes on purpose — a literal
       U+000B in this source file would be invisible to every reviewer of it. */
    const XML_INVALID_CHARS   = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFE\uFFFF]/g;
    const LONE_HIGH_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g;
    const LONE_LOW_SURROGATE  = /(^|[^\uD800-\uDBFF])([\uDC00-\uDFFF])/g;

    function sanitiseXmlText(str) {
        /* Tab / LF / CR are legal XML but meaningless in an SVG label, and an
           attribute parser rewrites them to spaces anyway — do it here, so that
           what is measured is what is drawn. */
        return str
            .replace(/[\t\n\r]/g, ' ')
            .replace(XML_INVALID_CHARS, ' ')
            .replace(LONE_HIGH_SURROGATE, ' ')
            .replace(LONE_LOW_SURROGATE, '$1 ');
    }

    function esc(s) {
        if (s === null || s === undefined) return '';
        return sanitiseXmlText(String(s))
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function fill(str, params) {
        if (typeof str !== 'string') return '';
        if (!params) return str;
        return str.replace(/\{(\w+)\}/g, function (m, k) {
            return Object.prototype.hasOwnProperty.call(params, k) ? String(params[k]) : m;
        });
    }
    function tr(ctx, key) {
        if (ctx && typeof ctx.t === 'function') {
            const v = ctx.t(key);
            return (v === null || v === undefined) ? key : String(v);
        }
        return key;
    }
    function trf(ctx, key, params) { return fill(tr(ctx, key), params); }

    /* Numbers printed into the SVG. Rounded for size AND for determinism of the
       decimal expansion; -0 is normalised to 0 so the same geometry can never
       produce two different strings. */
    function fmt(n) {
        const v = num(n, 0);
        const p = Math.pow(10, COORD_DECIMALS);
        const r = Math.round(v * p) / p;
        return Object.is(r, -0) ? '0' : String(r);
    }

    /* ── Coordinate coercion ──
       Accepts [lat, lon] (what geo-provider returns), {lat, lon} (a Place), and
       numeric strings (what a saved Firestore document can come back as).
       Anything else is not a coordinate and is DROPPED, never guessed. */
    function coordOf(p) {
        if (!p) return null;
        let lat, lon;
        if (Array.isArray(p)) { lat = num(p[0], NaN); lon = num(p[1], NaN); }
        else if (typeof p === 'object') { lat = num(p.lat, NaN); lon = num(p.lon, NaN); }
        else return null;
        if (!isFinite(lat) || !isFinite(lon)) return null;
        if (lat < -90 || lat > 90) return null;
        return [lat, normaliseLon(lon)];
    }

    function normaliseLon(lon) {
        let v = num(lon, 0);
        if (v > 180 || v < -180) v = ((v + 180) % 360 + 360) % 360 - 180;
        return v;
    }

    /* ── Web Mercator ──
       Returns [x, y] in the unit square: x 0..1 west->east, y 0..1 north->south
       (already the direction SVG's y axis runs, so no flip is needed later).
       Returns null for anything that is not a usable coordinate. */
    function project(lat, lon) {
        const la = num(lat, NaN);
        const lo = num(lon, NaN);
        if (!isFinite(la) || !isFinite(lo)) return null;
        if (la < -90 || la > 90) return null;
        /* The poles are infinitely far away in Mercator; clamp instead of
           returning Infinity, so an antipodal or polar input degrades to the
           edge of the world rather than poisoning the bounding box. */
        const c = Math.max(-MAX_MERC_LAT, Math.min(MAX_MERC_LAT, la));
        const s = Math.sin(c * Math.PI / 180);
        const x = (normaliseLon(lo) + 180) / 360;
        const y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
        if (!isFinite(x) || !isFinite(y)) return null;
        return [x, y];
    }

    /* Kilometres per projected unit at a given latitude. Mercator is conformal:
       distances shrink by cos(lat), so a projected unit is worth LESS ground at
       higher latitude. */
    function kmPerUnit(latDeg) {
        const la = Math.max(-MAX_MERC_LAT, Math.min(MAX_MERC_LAT, num(latDeg, 0)));
        return EARTH_CIRCUM_KM * Math.cos(la * Math.PI / 180);
    }

    /* The reference latitude for the km <-> projected-unit conversion is the one
       CLOSEST TO THE EQUATOR in the data, because that is where a projected unit
       buys the most ground. Using the mid-latitude instead would let the true
       error at the northern end of a long route exceed the stated tolerance —
       and a tolerance you can exceed is not a tolerance. This errs towards
       keeping a few extra points. */
    function referenceLat(points) {
        let best = null;
        for (let i = 0; i < points.length; i++) {
            const a = Math.abs(points[i][0]);
            if (best === null || a < best) best = a;
        }
        return best === null ? 0 : best;
    }

    /* ── Geometry maths ── */
    /* Squared distance from p to the SEGMENT ab (not the infinite line: the
        infinite-line version keeps points a straight-line detour would drop). */
    function segDistSq(p, a, b) {
        const abx = b[0] - a[0], aby = b[1] - a[1];
        const apx = p[0] - a[0], apy = p[1] - a[1];
        const len = abx * abx + aby * aby;
        let t = 0;
        if (len > 0) {
            t = (apx * abx + apy * aby) / len;
            if (t < 0) t = 0; else if (t > 1) t = 1;
        }
        const dx = apx - t * abx, dy = apy - t * aby;
        return dx * dx + dy * dy;
    }

    /* ── Douglas-Peucker, ITERATIVE ──
       `pts` are projected [x, y]; `tol` is in projected units. Returns a boolean
       keep-mask. An explicit stack, because the recursive form overflows on the
       11k-point geometry a real 4-stop route produces. */
    function dpKeepMask(pts, tol) {
        const n = pts.length;
        const keep = new Array(n);
        for (let i = 0; i < n; i++) keep[i] = false;
        if (n === 0) return keep;
        keep[0] = true;
        keep[n - 1] = true;
        if (n <= 2) return keep;

        const tolSq = tol * tol;
        const stack = [0, n - 1];              /* flat pairs: cheaper than arrays */
        while (stack.length) {
            const last = stack.pop();
            const first = stack.pop();
            if (last <= first + 1) continue;
            let maxSq = -1, idx = -1;
            const a = pts[first], b = pts[last];
            for (let i = first + 1; i < last; i++) {
                const d = segDistSq(pts[i], a, b);
                /* strict > keeps the FIRST maximum: same input, same split, always */
                if (d > maxSq) { maxSq = d; idx = i; }
            }
            if (maxSq > tolSq && idx > first) {
                keep[idx] = true;
                stack.push(first, idx);
                stack.push(idx, last);
            }
        }
        return keep;
    }

    /* Uniform decimation, keeping the first and last point. The bound on
       Douglas-Peucker's quadratic worst case: see the header. Index-based, so the
       output is still a SUBSET of the input — nothing is invented or moved. */
    function decimateTo(pts, cap) {
        if (cap < 2 || pts.length <= cap) return pts;
        const out = [];
        let last = -1;
        for (let i = 0; i < cap; i++) {
            const idx = Math.round(i * (pts.length - 1) / (cap - 1));
            if (idx === last) continue;
            out.push(pts[idx]);
            last = idx;
        }
        if (out[out.length - 1] !== pts[pts.length - 1]) out.push(pts[pts.length - 1]);
        return out;
    }

    function pointCap(opts) {
        const o = opts || {};
        if (o.maxPoints === 0 || o.maxPoints === Infinity || o.maxPoints === false) return 0;
        const n = Math.floor(num(o.maxPoints, MAX_SIMPLIFY_POINTS));
        return isFinite(n) && n >= 2 ? n : MAX_SIMPLIFY_POINTS;
    }

    /* Public simplifier. Takes and returns lat/lon points — the shape
       geo-provider produces. NOTE: the thing to PERSIST is `view.geometryDoc`,
       which carries these points together with their provenance; a bare array
       cannot, and losing the label used to turn an estimate into a measurement. */
    function simplify(points, toleranceKm, opts) {
        let src = [];
        const list = Array.isArray(points) ? points : [];
        for (let i = 0; i < list.length; i++) {
            const c = coordOf(list[i]);
            if (c) src.push(c);
        }
        const cap = pointCap(opts);
        if (cap && src.length > cap) src = decimateTo(src, cap);
        if (src.length <= 2) return src;

        const tolKm = num(toleranceKm, DEFAULT_TOL_KM);
        if (!(tolKm > 0)) return src;          /* 0 / negative => explicit no-thinning */

        const perUnit = kmPerUnit(referenceLat(src));
        if (!(perUnit > 0)) return src;
        const tol = tolKm / perUnit;

        const proj = [];
        for (let i = 0; i < src.length; i++) {
            const xy = project(src[i][0], src[i][1]);
            proj.push(xy || [0, 0]);
        }
        const keep = dpKeepMask(proj, tol);
        const out = [];
        for (let i = 0; i < src.length; i++) if (keep[i]) out.push(src[i]);
        return out;
    }

    /* Worst-case ground error introduced by a simplification, in km. Exported
       because "0.49 km max error" is a claim, and a claim in this project has to
       be checkable by the test suite rather than asserted in a comment. */
    function maxDeviationKm(original, simplified) {
        const a = [], b = [];
        const oi = Array.isArray(original) ? original : [];
        const si = Array.isArray(simplified) ? simplified : [];
        for (let i = 0; i < oi.length; i++) { const c = coordOf(oi[i]); if (c) a.push(c); }
        for (let i = 0; i < si.length; i++) { const c = coordOf(si[i]); if (c) b.push(c); }
        if (a.length === 0 || b.length === 0) return 0;

        const perUnit = kmPerUnit(referenceLat(a.concat(b)));
        const pa = [], pb = [];
        for (let i = 0; i < a.length; i++) pa.push(project(a[i][0], a[i][1]) || [0, 0]);
        for (let i = 0; i < b.length; i++) pb.push(project(b[i][0], b[i][1]) || [0, 0]);
        if (pb.length === 1) pb.push(pb[0]);

        let worst = 0;
        for (let i = 0; i < pa.length; i++) {
            let best = Infinity;
            for (let j = 0; j + 1 < pb.length; j++) {
                const d = segDistSq(pa[i], pb[j], pb[j + 1]);
                if (d < best) best = d;
            }
            if (best < Infinity && best > worst) worst = best;
        }
        return Math.sqrt(worst) * perUnit;
    }

    /* Byte cost of persisting something, as JSON. Requirement: what goes into
       Firestore is the simplified line, and the caller can prove it here. */
    function estimatePayloadBytes(value) {
        try { return JSON.stringify(value === undefined ? null : value).length; }
        catch (e) { return 0; }
    }

    /* ── Outlier-resistant bounding box ──
       `pts` are projected {x, y} entries. Returns null — meaning "use the plain
       bounding box" — unless all three guards in the constants above are
       satisfied. Median absolute deviation rather than a percentile trim: a route
       is a LINE, so its outermost 1% of vertices are its start and its end, and
       trimming by percentile would crop real geography off every map. */
    function medianOf(sorted) {
        const n = sorted.length;
        if (n === 0) return 0;
        const mid = n >> 1;
        return (n % 2) ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    function robustLineBounds(pts) {
        const n = pts.length;
        if (n < MIN_POINTS_FOR_ROBUST_FIT) return null;

        const xs = [], ys = [];
        for (let i = 0; i < n; i++) { xs.push(pts[i].x); ys.push(pts[i].y); }
        xs.sort(function (a, b) { return a - b; });
        ys.sort(function (a, b) { return a - b; });
        const medX = medianOf(xs), medY = medianOf(ys);

        const devs = [];
        for (let i = 0; i < n; i++) {
            devs.push(Math.abs(pts[i].x - medX) + Math.abs(pts[i].y - medY));
        }
        const sortedDevs = devs.slice().sort(function (a, b) { return a - b; });
        const medDev = medianOf(sortedDevs);
        if (!(medDev > 0)) return null;         /* every point on one spot */

        const threshold = medDev * OUTLIER_MAD_FACTOR;
        const drop = {};
        let outliers = 0;
        for (let i = 1; i < n - 1; i++) {
            if (devs[i] <= threshold) continue;
            /* Spike test — the guard that separates "corrupt vertex" from
               "legitimate distant arm". A point the route genuinely travels
               through sits on the chord between its neighbours; a spike does not. */
            const chord = Math.sqrt(segDistSq(
                [pts[i].x, pts[i].y],
                [pts[i - 1].x, pts[i - 1].y],
                [pts[i + 1].x, pts[i + 1].y]
            ));
            if (chord >= OUTLIER_SPIKE_SHARE * devs[i]) { drop[i] = 1; outliers++; }
        }
        if (outliers === 0) return null;
        if (outliers > Math.max(3, Math.floor(n * MAX_OUTLIER_SHARE))) return null;

        const kept = [];
        for (let i = 0; i < n; i++) if (!drop[i]) kept.push(pts[i]);
        return { points: kept, outliers: outliers };
    }

    /* ── Waypoints from the plan ──
       The route's waypoint sequence is day 1's start followed by the `to` of every
       leg of every day, in order. Built from the DAYS rather than from
       `plan.order` so that the day each waypoint belongs to is a fact, not a
       re-derivation that can drift out of step with the day cards. */
    function waypointsFromPlan(plan) {
        const days = (plan && Array.isArray(plan.days)) ? plan.days : [];
        const order = (plan && Array.isArray(plan.order)) ? plan.order : [];
        const out = [];
        let legTotal = 0;
        for (let i = 0; i < days.length; i++) {
            const legs = (days[i] && Array.isArray(days[i].legs)) ? days[i].legs : [];
            legTotal += legs.length;
        }

        /* No legs anywhere (all-rest plan, or a 1-place trip): the ordered places
           are still the only geography there is, and they belong to day 1 — unless
           the plan has NO days, in which case there is no day to belong to and
           `day: null` says so. Claiming day 1 of a zero-day plan was a real defect:
           a malformed `{ days: [], order: [A, B] }` produced two markers both
           labelled "day 1", inventing the very structure the invariant
           `view.days.length === plan.days.length` exists to protect. */
        if (legTotal === 0) {
            const src = order.length ? order : (days.length && days[0] && days[0].startPlace ? [days[0].startPlace] : []);
            const day = days.length ? 0 : null;
            for (let i = 0; i < src.length; i++) {
                const c = coordOf(src[i]);
                if (!c) continue;
                out.push({ name: nameOf(src[i]), lat: c[0], lon: c[1], day: day, dayEnd: i === src.length - 1 });
            }
            return dedupeAdjacent(out);
        }

        let first = null;
        for (let i = 0; i < days.length && !first; i++) {
            const legs = (days[i] && Array.isArray(days[i].legs)) ? days[i].legs : [];
            if (days[i] && days[i].startPlace) first = days[i].startPlace;
            else if (legs.length && legs[0] && legs[0].from) first = legs[0].from;
        }
        if (!first && order.length) first = order[0];
        const fc = coordOf(first);
        if (fc) out.push({ name: nameOf(first), lat: fc[0], lon: fc[1], day: 0, dayEnd: false });

        for (let d = 0; d < days.length; d++) {
            const legs = (days[d] && Array.isArray(days[d].legs)) ? days[d].legs : [];
            for (let i = 0; i < legs.length; i++) {
                const c = coordOf(legs[i] && legs[i].to);
                if (!c) continue;
                out.push({
                    name: nameOf(legs[i].to), lat: c[0], lon: c[1],
                    day: d, dayEnd: i === legs.length - 1
                });
            }
        }
        return dedupeAdjacent(out);
    }

    function nameOf(place) {
        if (!place) return '';
        if (typeof place === 'string') return place;
        return String(place.name === undefined || place.name === null ? '' : place.name);
    }

    /* A stop repeated back-to-back at the same coordinates (an overnight place a
       zero-km day "travels" to) is one marker, not two stacked on one pixel. The
       LATER entry wins its day flags so the overnight badge lands on the day that
       actually ends there. */
    function dedupeAdjacent(list) {
        const out = [];
        for (let i = 0; i < list.length; i++) {
            const prev = out[out.length - 1];
            const cur = list[i];
            if (prev && prev.lat === cur.lat && prev.lon === cur.lon &&
                normName(prev.name) === normName(cur.name)) {
                prev.dayEnd = prev.dayEnd || cur.dayEnd;
                continue;
            }
            out.push(cur);
        }
        return out;
    }

    function normName(s) {
        if (s === null || s === undefined) return '';
        return String(s).toLowerCase().trim().replace(/\s+/g, ' ');
    }

    /* ── Splitting the road geometry between days ──
       OSRM returns ONE polyline for the whole trip. Each waypoint is snapped to
       its nearest vertex, scanning forward only so the indices can never cross
       (a route that passes near an earlier stop would otherwise hand day 3 a
       slice that runs backwards). First and last waypoints are pinned to the ends
       of the line so no geometry is dropped. */
    function snapWaypoints(projGeom, projWays) {
        const idx = [];
        if (projGeom.length === 0 || projWays.length === 0) return idx;
        let from = 0;
        for (let w = 0; w < projWays.length; w++) {
            if (w === 0) { idx.push(0); from = 0; continue; }
            let best = from, bestD = Infinity;
            for (let i = from; i < projGeom.length; i++) {
                const dx = projGeom[i][0] - projWays[w][0];
                const dy = projGeom[i][1] - projWays[w][1];
                const d = dx * dx + dy * dy;
                if (d < bestD) { bestD = d; best = i; }
            }
            idx.push(best);
            from = best;
        }
        idx[idx.length - 1] = projGeom.length - 1;
        if (idx.length > 1 && idx[idx.length - 1] < idx[idx.length - 2]) {
            idx[idx.length - 1] = idx[idx.length - 2];
        }
        return idx;
    }

    /* ── The view model ──
       Pure data: projected + simplified path per day, markers with their day, the
       bounding box, and the provenance flag. Everything the renderer needs and
       nothing it has to recompute.

       INVARIANT: view.days.length === plan.days.length, always. Day colouring is
       indexed by that array, so it cannot drift away from the itinerary's days. */
    function buildMapView(args) {
        const a = args || {};
        const plan = a.plan || null;
        const planDays = (plan && Array.isArray(plan.days)) ? plan.days : [];
        const width  = pos(a.width, DEFAULT_WIDTH);
        const height = pos(a.height, DEFAULT_HEIGHT);
        const padding = nonNeg(a.padding, DEFAULT_PADDING);
        const tolKm = nonNeg(a.toleranceKm, DEFAULT_TOL_KM);

        const ways = waypointsFromPlan(plan);
        const warnings = [];

        /* ── Geometry in ──
           Three accepted shapes, because the round trip has to close:
             · a bare [[lat,lon],...] array (what geo-provider returns);
             · that same array carrying geo-provider's non-enumerable `source`;
             · a persisted `geometryDoc` — { points, source } — which is the ONLY
               one of the three that survives JSON.stringify with its label
               intact, and therefore the only one that survives Firestore. */
        let rawGeom = [], envelopeSource = null;
        if (Array.isArray(a.geometry)) {
            rawGeom = a.geometry;
        } else if (a.geometry && typeof a.geometry === 'object' && Array.isArray(a.geometry.points)) {
            rawGeom = a.geometry.points;
            if (typeof a.geometry.source === 'string') envelopeSource = a.geometry.source;
            /* a.geometry.real is deliberately ignored: the label is the evidence,
               a stored boolean is only somebody's old conclusion about it. */
        }
        const geomPts = [];
        for (let i = 0; i < rawGeom.length; i++) {
            const c = coordOf(rawGeom[i]);
            if (c) geomPts.push(c);
        }

        /* ── Provenance: an ALLOWLIST ──
           Explicit argument, then the persisted envelope, then the in-memory
           marker. Absence is NOT road data — it is 'unknown', and unknown renders
           as an estimate. Matched literally, so 'OSRM', 'haversine', 'guess' and
           '' all land on 'unknown': the failure direction is captioning a real
           route as an estimate, never the reverse. */
        let declared = typeof a.geometrySource === 'string' ? a.geometrySource : null;
        if (declared === null) declared = envelopeSource;
        if (declared === null && rawGeom && typeof rawGeom.source === 'string') declared = rawGeom.source;

        const usable = geomPts.length >= 2;
        let source, real;
        if (usable) {
            real = declared === REAL_GEOMETRY_SOURCE;
            source = (declared !== null && KNOWN_SOURCES[declared]) ? declared : 'unknown';
            if (!real) {
                warnings.push(source === 'straight'
                    ? 'geometry-straight'
                    : 'geometry-source-unknown:' + (declared === null ? '(absent)' : declared));
            }
        } else {
            real = false;
            source = ways.length >= 2 ? 'straight' : 'none';
            if (source === 'straight') warnings.push('geometry-straight');
        }

        /* The line to draw: real geometry, or the straight fallback through the
           stops. Both go through the same pipeline from here on. */
        let line = usable ? geomPts : ways.map(function (w) { return [w.lat, w.lon]; });
        if (line.length === 1 && ways.length === 0) line = [];

        /* Bound the quadratic worst case BEFORE any per-day work, so every slice
           is drawn from the same decimated line and the seams still meet. */
        const cap = pointCap(a);
        let decimatedFrom = 0;
        if (cap && line.length > cap) {
            decimatedFrom = line.length;
            line = decimateTo(line, cap);
            warnings.push('geometry-decimated:' + decimatedFrom);
        }

        const projLine = [];
        for (let i = 0; i < line.length; i++) projLine.push(project(line[i][0], line[i][1]) || [0, 0]);
        const projWays = [];
        for (let i = 0; i < ways.length; i++) projWays.push(project(ways[i].lat, ways[i].lon) || [0, 0]);

        /* Where each day's slice of the line starts and ends, as waypoint indices. */
        const dayWayRange = [];
        let cursor = 0;
        for (let d = 0; d < planDays.length; d++) {
            let count = 0;
            for (let w = 0; w < ways.length; w++) if (ways[w].day === d && !(d === 0 && w === 0)) count++;
            /* day 0 owns the origin marker too, but the origin adds no leg */
            const start = cursor;
            const end = Math.min(ways.length - 1, cursor + count);
            dayWayRange.push([Math.max(0, start), Math.max(0, end)]);
            cursor = end;
        }
        /* No plan days at all: nothing to colour, nothing to draw. */
        const snapped = (planDays.length && projLine.length) ? snapWaypoints(projLine, projWays) : [];

        const perUnit = kmPerUnit(referenceLat(line.length ? line : [[0, 0]]));
        const tolUnits = (tolKm > 0 && perUnit > 0) ? tolKm / perUnit : 0;

        const days = [];
        let inputPoints = 0, outputPoints = 0;
        for (let d = 0; d < planDays.length; d++) {
            const pd = planDays[d] || {};
            const range = dayWayRange[d] || [0, 0];
            let pts = [];
            if (snapped.length && ways.length >= 2 && range[1] > range[0]) {
                const i0 = snapped[range[0]] === undefined ? 0 : snapped[range[0]];
                const i1 = snapped[range[1]] === undefined ? projLine.length - 1 : snapped[range[1]];
                if (i1 > i0) pts = line.slice(i0, i1 + 1);
            }
            inputPoints += pts.length;
            const simplifiedPts = simplifyProjected(pts, tolUnits);
            outputPoints += simplifiedPts.length;
            days.push({
                day: num(pd.day, d + 1),
                index: d,
                color: DAY_COLORS[d % DAY_COLORS.length],
                from: nameOf(pd.startPlace) || (ways[range[0]] ? ways[range[0]].name : ''),
                to: nameOf(pd.endPlace) || (ways[range[1]] ? ways[range[1]].name : ''),
                km: nonNeg(pd.km, 0),
                rest: !(Array.isArray(pd.legs) && pd.legs.length > 0),
                points: simplifiedPts,          /* [lat, lon] — the line to PERSIST */
                path: []                        /* filled in below, in viewBox units */
            });
        }

        /* ── Bounding box over everything that will be drawn ── */
        const availW = Math.max(1, width - 2 * padding);
        const availH = Math.max(1, height - 2 * padding);

        const entryOf = function (lat, lon) {
            const xy = project(lat, lon);
            return xy ? { x: xy[0], y: xy[1], lat: lat, lon: lon } : null;
        };
        const linePoints = [], markerPoints = [];
        for (let d = 0; d < days.length; d++) {
            for (let i = 0; i < days[d].points.length; i++) {
                const e = entryOf(days[d].points[i][0], days[d].points[i][1]);
                if (e) linePoints.push(e);
            }
        }
        for (let w = 0; w < ways.length; w++) {
            const e = entryOf(ways[w].lat, ways[w].lon);
            if (e) markerPoints.push(e);
        }

        const boxOf = function (lists) {
            const b = {
                minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity,
                minLat: Infinity, maxLat: -Infinity, minLon: Infinity, maxLon: -Infinity, n: 0
            };
            for (let l = 0; l < lists.length; l++) {
                const list = lists[l];
                for (let i = 0; i < list.length; i++) {
                    const e = list[i];
                    if (e.x < b.minX) b.minX = e.x;
                    if (e.x > b.maxX) b.maxX = e.x;
                    if (e.y < b.minY) b.minY = e.y;
                    if (e.y > b.maxY) b.maxY = e.y;
                    if (e.lat < b.minLat) b.minLat = e.lat;
                    if (e.lat > b.maxLat) b.maxLat = e.lat;
                    if (e.lon < b.minLon) b.minLon = e.lon;
                    if (e.lon > b.maxLon) b.maxLon = e.lon;
                    b.n++;
                }
            }
            return b;
        };
        /* Fit, preserving the aspect ratio. A degenerate box (one stop, or two
           stops at identical coordinates) has zero extent in one or both axes:
           scale from the other axis, or fall back to 1 and centre the point. */
        const scaleOf = function (b) {
            const dx = b.maxX - b.minX, dy = b.maxY - b.minY;
            let s;
            if (dx > 0 && dy > 0) s = Math.min(availW / dx, availH / dy);
            else if (dx > 0) s = availW / dx;
            else if (dy > 0) s = availH / dy;
            else s = 1;
            return (isFinite(s) && s > 0) ? s : 1;
        };

        let box = boxOf([linePoints, markerPoints]);
        let outlierPoints = 0;

        /* One corrupt vertex in an otherwise correct polyline used to collapse the
           scale 24x and render a whole country as a smudge — still solid, still
           captioned as road data. Refit without the far outliers when, and only
           when, doing so actually rescues the map. The excluded points are still
           drawn: they run off the edge of the viewBox and are clipped there, so
           the anomaly stays visible instead of being quietly deleted. */
        const robust = robustLineBounds(linePoints);
        if (robust) {
            const candidate = boxOf([robust.points, markerPoints]);
            if (scaleOf(candidate) >= MIN_SCALE_GAIN * scaleOf(box)) {
                box = candidate;
                outlierPoints = robust.outliers;
                warnings.push('geometry-outliers:' + outlierPoints);
            }
        }

        const hasContent = box.n > 0 && isFinite(box.minX) && isFinite(box.minY);
        let minX, maxX, minY, maxY, minLat, maxLat, minLon, maxLon;
        if (hasContent) {
            minX = box.minX; maxX = box.maxX; minY = box.minY; maxY = box.maxY;
            minLat = box.minLat; maxLat = box.maxLat; minLon = box.minLon; maxLon = box.maxLon;
        } else {
            minX = maxX = minY = maxY = 0;
            minLat = maxLat = minLon = maxLon = 0;
        }

        const dx = maxX - minX, dy = maxY - minY;
        const scale = hasContent ? scaleOf(box) : 1;
        const offX = padding + (availW - dx * scale) / 2;
        const offY = padding + (availH - dy * scale) / 2;
        const toView = function (lat, lon) {
            const xy = project(lat, lon);
            if (!xy) return null;
            return [offX + (xy[0] - minX) * scale, offY + (xy[1] - minY) * scale];
        };

        for (let d = 0; d < days.length; d++) {
            const path = [];
            for (let i = 0; i < days[d].points.length; i++) {
                const v = toView(days[d].points[i][0], days[d].points[i][1]);
                if (v) path.push(v);
            }
            days[d].path = path;
        }

        const markers = [];
        for (let w = 0; w < ways.length; w++) {
            const v = toView(ways[w].lat, ways[w].lon);
            if (!v) continue;
            /* `day` is null when the plan has no days to belong to. A marker must
               never name a day the itinerary does not have — that is the same
               class of fabrication as an unlabelled estimate drawn as a road. */
            const di = ways[w].day;
            const hasDay = di !== null && di !== undefined && days[di] !== undefined;
            markers.push({
                name: ways[w].name,
                lat: ways[w].lat, lon: ways[w].lon,
                x: v[0], y: v[1],
                day: hasDay ? di : null,
                dayNumber: hasDay ? days[di].day : null,
                color: hasDay ? DAY_COLORS[di % DAY_COLORS.length] : UNASSIGNED_COLOR,
                overnight: hasDay && !!ways[w].dayEnd && w !== ways.length - 1,
                kind: w === 0 ? 'start' : (w === ways.length - 1 ? 'end' : 'stop')
            });
        }
        for (let i = 0; i < markers.length; i++) {
            if (markers[i].day === null) { warnings.push('markers-without-day'); break; }
        }

        /* The simplified, day-joined line, without the duplicated seam point
           between consecutive days. This is what gets DRAWN and exported — but
           see geometryDoc below for what gets PERSISTED: a bare array cannot
           carry its own provenance through JSON.stringify. */
        const geometry = [];
        for (let d = 0; d < days.length; d++) {
            const p = days[d].points;
            for (let i = 0; i < p.length; i++) {
                const prev = geometry[geometry.length - 1];
                if (prev && prev[0] === p[i][0] && prev[1] === p[i][1]) continue;
                geometry.push(p[i]);
            }
        }

        /* ── The persistable document ──
           Points AND provenance in one plain JSON object, so that
           `buildMapView({ geometry: JSON.parse(saved) })` reaches the same verdict
           the original render did. Persisting `geometry` alone loses the label,
           and a lost label used to be read as road data. */
        const geometryDoc = {
            points: geometry,
            source: source,
            toleranceKm: tolKm,
            pointCount: geometry.length
        };
        if (decimatedFrom) geometryDoc.decimatedFrom = decimatedFrom;
        const geometryBytes = estimatePayloadBytes(geometryDoc);

        /* A tolerance of 0 is honoured — a print or export view may legitimately
           want every vertex — but the module exists to stop a 199 KB line reaching
           a 1 MB document, so the consequence is stated rather than discovered. */
        if (!(tolKm > 0) && geometry.length > 0) warnings.push('geometry-unsimplified');
        if (geometryBytes > PERSIST_BUDGET_BYTES) warnings.push('persist-oversize:' + geometryBytes);

        let drawn = 0;
        for (let d = 0; d < days.length; d++) if (days[d].path.length >= 2) drawn++;

        return {
            width: width,
            height: height,
            padding: padding,
            viewBox: '0 0 ' + fmt(width) + ' ' + fmt(height),
            days: days,
            markers: markers,
            /* Provenance — the caller MUST surface this when it is false. */
            geometryReal: real,
            geometrySource: source,
            geometry: geometry,
            geometryDoc: geometryDoc,
            geometryBytes: geometryBytes,
            simplification: {
                toleranceKm: tolKm,
                inputPoints: inputPoints,
                outputPoints: outputPoints,
                rawPoints: geomPts.length,
                decimatedFrom: decimatedFrom
            },
            bounds: {
                minLat: hasContent ? minLat : 0, maxLat: hasContent ? maxLat : 0,
                minLon: hasContent ? minLon : 0, maxLon: hasContent ? maxLon : 0,
                minX: minX, maxX: maxX, minY: minY, maxY: maxY,
                scale: scale
            },
            fit: { robust: outlierPoints > 0, outlierPoints: outlierPoints },
            warnings: warnings,
            empty: markers.length === 0 && drawn === 0
        };
    }

    /* Simplify a lat/lon slice with a tolerance already expressed in projected
       units (buildMapView computes it once for the whole route so that every day
       is thinned by the same physical distance). */
    function simplifyProjected(latlon, tolUnits) {
        if (latlon.length <= 2) return latlon.slice();
        if (!(tolUnits > 0)) return latlon.slice();
        const proj = [];
        for (let i = 0; i < latlon.length; i++) {
            proj.push(project(latlon[i][0], latlon[i][1]) || [0, 0]);
        }
        const keep = dpKeepMask(proj, tolUnits);
        const out = [];
        for (let i = 0; i < latlon.length; i++) if (keep[i]) out.push(latlon[i]);
        return out;
    }

    /* ── Rendering ──
       A self-contained SVG string with a viewBox and NO pixel width/height, so it
       scales to whatever box the page gives it. Every name goes through esc():
       "Sant Joan Despi & Cornella", "L'Hospitalet <centre>" and 'Zaragoza "La Seo"'
       are all real destinations in this project's test data, and each one of them
       breaks unescaped markup in a different place. */
    function pathData(path) {
        let d = '';
        let px = null, py = null;
        for (let i = 0; i < path.length; i++) {
            const x = fmt(path[i][0]), y = fmt(path[i][1]);
            if (x === px && y === py) continue;   /* no zero-length segments */
            d += (d === '' ? 'M' : 'L') + x + ' ' + y;
            if (i < path.length - 1) d += ' ';
            px = x; py = y;
        }
        return d;
    }

    function renderMapSvg(view, ctx) {
        if (!view || typeof view !== 'object') return '';
        const w = pos(view.width, DEFAULT_WIDTH);
        const h = pos(view.height, DEFAULT_HEIGHT);
        const days = Array.isArray(view.days) ? view.days : [];
        const markers = Array.isArray(view.markers) ? view.markers : [];
        const real = view.geometryReal === true;

        const title = tr(ctx, 'map.title');
        /* THREE source states, but only TWO of them may make a claim about the
           SHAPE of the line:
             'osrm'              -> drawn from the road network;
             'straight'/'none'   -> straight lines between the stops;
             'unknown'           -> SAYS NOTHING about the shape. An unlabelled
                                    polyline is not known to be straight either,
                                    so borrowing the straight-line wording would
                                    print a false description of the picture the
                                    user is looking at — a second invention on top
                                    of the lost label.
           The unknown state is still dashed, still excluded from any road claim,
           and still carried in `view.warnings` and in the machine-readable
           data-geometry-* attributes below, which need no translation and survive
           the SVG being exported on its own. See the known limitation in the
           header about the wording this state deserves and does not yet have. */
        const straightShape = view.geometrySource === 'straight' || view.geometrySource === 'none';
        const desc = real ? tr(ctx, 'map.sourceRoad') : (straightShape ? tr(ctx, 'map.sourceStraight') : '');
        const label = desc ? title + ' — ' + desc : title;

        let svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' +
            fmt(w) + ' ' + fmt(h) + '" preserveAspectRatio="xMidYMid meet" ' +
            'overflow="hidden" role="img" aria-label="' + esc(label) + '" ' +
            'data-geometry-real="' + (real ? 'true' : 'false') + '" ' +
            'data-geometry-source="' + esc(view.geometrySource || 'none') + '" ' +
            'class="travio-map" style="width:100%;height:auto;display:block">';
        svg += '<title>' + esc(title) + '</title>';
        if (desc) svg += '<desc>' + esc(desc) + '</desc>';
        svg += '<rect x="0" y="0" width="' + fmt(w) + '" height="' + fmt(h) +
            '" rx="10" fill="' + BG_COLOR + '"/>';

        if (view.empty === true) {
            svg += '<text x="' + fmt(w / 2) + '" y="' + fmt(h / 2) +
                '" text-anchor="middle" font-family="DM Sans, sans-serif" font-size="16" fill="' +
                MUTED_COLOR + '">' + esc(tr(ctx, 'map.noRoute')) + '</text>';
            return svg + '</svg>';
        }

        /* Routes, oldest day first so later days draw on top at a crossing. */
        svg += '<g class="travio-map-routes" fill="none" stroke-linecap="round" stroke-linejoin="round">';
        for (let d = 0; d < days.length; d++) {
            const day = days[d];
            const data = pathData(Array.isArray(day.path) ? day.path : []);
            if (!data) continue;
            svg += '<path class="travio-map-day travio-map-day-' + (d + 1) + '" d="' + data +
                '" stroke="' + esc(day.color || DAY_COLORS[0]) + '" stroke-width="3.5"' +
                /* A straight-line fallback is DASHED: the picture itself has to say
                   it is not a road, not just the caption next to it. */
                (real ? '' : ' stroke-dasharray="7 5"') +
                ' opacity="0.95"><title>' +
                esc(trf(ctx, 'map.dayLabel', {
                    day: day.day, from: day.from || '', to: day.to || ''
                })) + '</title></path>';
        }
        svg += '</g>';

        /* Markers. Never colour alone: every one carries its name as a label and
           as a <title>, and start/end are also distinguished by shape. */
        svg += '<g class="travio-map-stops">';
        for (let i = 0; i < markers.length; i++) {
            const m = markers[i];
            const x = num(m.x, 0), y = num(m.y, 0);
            const r = (m.kind === 'start' || m.kind === 'end') ? 7 : 5;
            const label = esc(m.name || '');
            svg += '<g class="travio-map-stop travio-map-stop-' + esc(m.kind) + '">';
            if (m.kind === 'start' || m.kind === 'end') {
                svg += '<rect x="' + fmt(x - r) + '" y="' + fmt(y - r) + '" width="' + fmt(r * 2) +
                    '" height="' + fmt(r * 2) + '" rx="2" fill="#FFFFFF" stroke="' + STROKE_DARK +
                    '" stroke-width="2.5"><title>' + label + '</title></rect>';
            } else {
                svg += '<circle cx="' + fmt(x) + '" cy="' + fmt(y) + '" r="' + fmt(r) +
                    '" fill="#FFFFFF" stroke="' + esc(m.color || DAY_COLORS[0]) +
                    '" stroke-width="2.5"><title>' + label + '</title></circle>';
            }
            const right = x > w * 0.62;
            svg += '<text x="' + fmt(right ? x - r - 4 : x + r + 4) + '" y="' + fmt(y + 4) +
                '" text-anchor="' + (right ? 'end' : 'start') +
                '" font-family="DM Sans, sans-serif" font-size="12" fill="' + STROKE_DARK +
                '" paint-order="stroke" stroke="' + BG_COLOR + '" stroke-width="3">' +
                label + '</text>';
            svg += '</g>';
        }
        svg += '</g>';

        /* The fallback caption. Printed INSIDE the artefact, so it survives being
           saved, printed or screenshotted away from the page that built it. */
        /* Only the straight-line state gets the printed caption, because it is the
           only non-road state whose shape can be described truthfully with the
           wording that exists. Every non-road state is dashed and carries
           data-geometry-real="false". */
        if (!real && straightShape) {
            svg += '<text x="' + fmt(w / 2) + '" y="' + fmt(h - 10) +
                '" text-anchor="middle" font-family="Space Mono, monospace" font-size="11" fill="' +
                MUTED_COLOR + '">' + esc(tr(ctx, 'map.straightLineNote')) + '</text>';
        }
        return svg + '</svg>';
    }

    /* Convenience: plan + geometry -> SVG, for callers that never need the view. */
    function renderPlanMap(args, ctx) {
        return renderMapSvg(buildMapView(args), ctx);
    }

    /* ── Exports ── */
    const api = {
        DEFAULT_TOLERANCE_KM: DEFAULT_TOL_KM,
        DAY_COLORS: DAY_COLORS,
        EARTH_CIRCUM_KM: EARTH_CIRCUM_KM,
        MAX_MERC_LAT: MAX_MERC_LAT,
        project: project,
        kmPerUnit: kmPerUnit,
        simplify: simplify,
        maxDeviationKm: maxDeviationKm,
        estimatePayloadBytes: estimatePayloadBytes,
        buildMapView: buildMapView,
        renderMapSvg: renderMapSvg,
        renderPlanMap: renderPlanMap,
        escapeText: esc
    };

    if (typeof window !== 'undefined') window.TravioMap = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
