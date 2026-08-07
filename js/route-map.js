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
 *   phone, 40x smaller on the wire. `view.geometry` hands back the SIMPLIFIED
 *   line precisely so that the thing a caller persists is the small one.
 *
 *   TWO different payloads come out of one simplification, and they are not the
 *   same size — quoting one for the other is how a 5 KB line gets budgeted at
 *   2.8 KB:
 *     · what the SVG DRAWS — 2-decimal viewBox units, ~12 bytes a point, so the
 *       default tolerance ships ~3.3 KB of <path d="...">;
 *     · what Firestore STORES — `view.geometry`, 5-decimal lat/lon (the precision
 *       decodePolyline gives), ~19 bytes a point, so ~5.4 KB.
 *   Both are reported: `view.geometryBytes` is the stored one, because that is
 *   the one with a 1 MB limit attached to it.
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
 * TRANSLATION KEYS read through `ctx.t` (all fall back to the key itself, so the
 * module is usable before i18n.js carries them):
 *   map.title  map.noRoute  map.sourceRoad  map.sourceStraight
 *   map.straightLineNote  map.dayLabel {day}{from}{to}  map.legend {day}
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

    /* Day colours. The palette cycles, so day 9 reuses day 1's colour — but no
       information is carried by colour ALONE: every path has a <title> naming its
       day and its endpoints, and every marker is labelled. */
    const DAY_COLORS = [
        '#10B981', '#0EA5E9', '#F59E0B', '#8B5CF6',
        '#EF4444', '#14B8A6', '#EC4899', '#84CC16'
    ];
    const BG_COLOR     = '#ECFDF5';
    const STROKE_DARK  = '#1A1A1A';
    const MUTED_COLOR  = '#6B7280';

    /* ── Tiny pure helpers (same discipline as itinerary-render.js) ── */
    function num(v, def) {
        if (v === null || v === undefined || v === '') return def;
        const n = Number(v);
        return isFinite(n) ? n : def;
    }
    function pos(v, def) { const n = num(v, NaN); return isFinite(n) && n > 0 ? n : def; }
    function nonNeg(v, def) { const n = num(v, NaN); return isFinite(n) && n >= 0 ? n : def; }

    function esc(s) {
        if (s === null || s === undefined) return '';
        return String(s)
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

    /* Public simplifier. Takes and returns lat/lon points — the shape
       geo-provider produces and the shape a caller should PERSIST. */
    function simplify(points, toleranceKm) {
        const src = [];
        const list = Array.isArray(points) ? points : [];
        for (let i = 0; i < list.length; i++) {
            const c = coordOf(list[i]);
            if (c) src.push(c);
        }
        if (src.length <= 2) return src;

        const tolKm = num(toleranceKm, DEFAULT_TOL_KM);
        if (!(tolKm > 0)) return src;          /* 0 / negative / NaN => no thinning */

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

    /* Byte cost of persisting a line, as JSON. Requirement: what goes into
       Firestore is the simplified line, and the caller can prove it here. */
    function estimatePayloadBytes(points) {
        try { return JSON.stringify(points || []).length; } catch (e) { return 0; }
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
           are still the only geography there is, and they all belong to day 1. */
        if (legTotal === 0) {
            const src = order.length ? order : (days.length && days[0] && days[0].startPlace ? [days[0].startPlace] : []);
            for (let i = 0; i < src.length; i++) {
                const c = coordOf(src[i]);
                if (!c) continue;
                out.push({ name: nameOf(src[i]), lat: c[0], lon: c[1], day: 0, dayEnd: i === src.length - 1 });
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

        /* Provenance. An explicit argument wins; otherwise the non-enumerable
           `source` marker geo-provider attaches to its array; otherwise, if we
           were handed a usable line with no label at all, it is road geometry
           (the only thing that produces one). */
        const rawGeom = Array.isArray(a.geometry) ? a.geometry : [];
        const geomPts = [];
        for (let i = 0; i < rawGeom.length; i++) {
            const c = coordOf(rawGeom[i]);
            if (c) geomPts.push(c);
        }
        let declared = typeof a.geometrySource === 'string' ? a.geometrySource : null;
        if (!declared && rawGeom && typeof rawGeom.source === 'string') declared = rawGeom.source;

        const usable = geomPts.length >= 2;
        let source, real;
        if (usable && declared !== 'straight' && declared !== 'none') {
            source = declared || 'osrm';
            real = true;
        } else if (usable) {
            source = declared;                 /* caller says these ARE straight lines */
            real = false;
        } else {
            source = ways.length >= 2 ? 'straight' : 'none';
            real = false;
        }

        /* The line to draw: real geometry, or the straight fallback through the
           stops. Both go through the same pipeline from here on. */
        let line = usable ? geomPts : ways.map(function (w) { return [w.lat, w.lon]; });
        if (line.length === 1 && ways.length === 0) line = [];

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
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
        const seePoint = function (lat, lon) {
            const xy = project(lat, lon);
            if (!xy) return;
            if (xy[0] < minX) minX = xy[0];
            if (xy[0] > maxX) maxX = xy[0];
            if (xy[1] < minY) minY = xy[1];
            if (xy[1] > maxY) maxY = xy[1];
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
            if (lon < minLon) minLon = lon;
            if (lon > maxLon) maxLon = lon;
        };
        for (let d = 0; d < days.length; d++) {
            for (let i = 0; i < days[d].points.length; i++) {
                seePoint(days[d].points[i][0], days[d].points[i][1]);
            }
        }
        for (let w = 0; w < ways.length; w++) seePoint(ways[w].lat, ways[w].lon);

        const hasContent = isFinite(minX) && isFinite(minY);
        if (!hasContent) {
            minX = minY = 0; maxX = maxY = 0;
            minLat = maxLat = minLon = maxLon = 0;
        }

        /* Fit, preserving the aspect ratio. A degenerate box (one stop, or two
           stops at identical coordinates) has zero extent in one or both axes:
           scale from the other axis, or fall back to 1 and centre the point. */
        const dx = maxX - minX, dy = maxY - minY;
        const availW = Math.max(1, width - 2 * padding);
        const availH = Math.max(1, height - 2 * padding);
        let scale;
        if (dx > 0 && dy > 0) scale = Math.min(availW / dx, availH / dy);
        else if (dx > 0) scale = availW / dx;
        else if (dy > 0) scale = availH / dy;
        else scale = 1;
        if (!isFinite(scale) || scale <= 0) scale = 1;
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
            markers.push({
                name: ways[w].name,
                lat: ways[w].lat, lon: ways[w].lon,
                x: v[0], y: v[1],
                day: ways[w].day,
                dayNumber: (days[ways[w].day] ? days[ways[w].day].day : ways[w].day + 1),
                color: DAY_COLORS[ways[w].day % DAY_COLORS.length],
                overnight: !!ways[w].dayEnd && w !== ways.length - 1,
                kind: w === 0 ? 'start' : (w === ways.length - 1 ? 'end' : 'stop')
            });
        }

        /* The one line a caller should ever persist: simplified, day-joined,
           without the duplicated seam point between consecutive days. */
        const geometry = [];
        for (let d = 0; d < days.length; d++) {
            const p = days[d].points;
            for (let i = 0; i < p.length; i++) {
                const prev = geometry[geometry.length - 1];
                if (prev && prev[0] === p[i][0] && prev[1] === p[i][1]) continue;
                geometry.push(p[i]);
            }
        }

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
            geometryBytes: estimatePayloadBytes(geometry),
            simplification: {
                toleranceKm: tolKm,
                inputPoints: inputPoints,
                outputPoints: outputPoints,
                rawPoints: geomPts.length
            },
            bounds: {
                minLat: hasContent ? minLat : 0, maxLat: hasContent ? maxLat : 0,
                minLon: hasContent ? minLon : 0, maxLon: hasContent ? maxLon : 0,
                minX: minX, maxX: maxX, minY: minY, maxY: maxY,
                scale: scale
            },
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
        const desc = tr(ctx, real ? 'map.sourceRoad' : 'map.sourceStraight');

        let svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' +
            fmt(w) + ' ' + fmt(h) + '" preserveAspectRatio="xMidYMid meet" ' +
            'role="img" aria-label="' + esc(title + ' — ' + desc) + '" ' +
            'class="travio-map" style="width:100%;height:auto;display:block">';
        svg += '<title>' + esc(title) + '</title><desc>' + esc(desc) + '</desc>';
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
        if (!real) {
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
