/* ── Travio Geo Provider ── geocoding · road distance matrix · route geometry ── */
/*
 * Classic script. No ES modules, no npm dependencies, no bundler.
 * Loads safely in the browser (attaches to `window`) AND in Node for tests
 * (`module.exports`). Every global (window, fetch, localStorage, setTimeout)
 * is looked up lazily and guarded — nothing here runs or throws at load time.
 *
 * Wrapped in an IIFE, like js/route-engine.js: internal helpers stay private, so
 * the classic <script> load order cannot collide with engine helper names and a
 * duplicated <script> tag re-runs harmlessly instead of throwing
 * "Identifier 'GEO_NOMINATIM_URL' has already been declared".
 *
 * Public API (see docs/ENGINE_CONTRACT.md) — `window.TravioGeo`, plus the same
 * names bound directly on `window` for convenience:
 *   geocodePlaces(names, opts)  -> Promise<Place[]>     Nominatim, serialised >=1100ms
 *   distanceMatrix(places, opts)-> Promise<Matrix>      OSRM table, haversine fallback
 *   routeGeometry(places, opts) -> Promise<[lat,lon][]> OSRM route polyline, straight fallback
 *   decodePolyline, haversineKm, normalisePlaceName, clearGeoCache, resetGeoRateLimit
 *
 * Injection seam — every network/time/storage dependency can be stubbed:
 *   opts = { fetchImpl, sleepImpl, now, storage, minIntervalMs, cacheTtlMs,
 *            timeoutMs, nominatimUrl, osrmBase, maxTablePlaces, roadFactor,
 *            speedKmh, userAgent, language }
 *
 * MATRIX SOURCE — describes the WHOLE matrix, never one lucky cell:
 *   'osrm'      every off-diagonal cell came from the road graph (filledCells === 0)
 *   NOTE  osrmCells/filledCells count off-diagonal CELLS, not undirected pairs: the
 *         matrix is symmetric, so one unroutable pair contributes two cells. This is
 *         what the engine's dim*(dim-1) denominator expects ("14 of 20 cells").
 *   'mixed'     some real, some haversine-filled (islands, ferries, unroutable pairs)
 *   'haversine' no cell came from the road graph (also the degenerate n < 2 case,
 *               where there is no off-diagonal cell to have road data at all)
 *   The engine warns on 'mixed' and 'haversine', so reporting 'osrm' for a matrix
 *   that is 30% real would silently show "Palma->Ibiza 161 km by road" across open sea.
 *
 * FALLBACK CALIBRATION — haversine × 1.25 at 88 km/h.
 *   Measured against live OSRM on long Spanish routes: the 1.25 road factor is well
 *   calibrated on distance, but 75 km/h was 22–26% pessimistic on time. Because the
 *   engine enforces maxDriveMinPerDay on `min`, a pessimistic speed invents false
 *   over-cap warnings and over-splits days — the exact bug class this project set out
 *   to fix. 88 km/h sits inside the measured 87–92 km/h long-haul average.
 *
 * UNRESOLVED PLACES — documented strategy (contract: no NaN/null/Infinity cells):
 *   A place whose geocoding failed (lat/lon null, or coordinates outside ±90/±180)
 *   is treated as being located at the CENTROID of every resolved place in the same
 *   request. Consequences:
 *     - all of its matrix cells are finite and geometrically consistent (the
 *       substitution is a real point, so the matrix stays a metric space and 2-opt in
 *       the engine cannot be poisoned by a fake asymmetry);
 *     - it is "cheap to insert anywhere", which is the honest representation of
 *       "we do not know where this is";
 *     - if NO place in the request resolved, all coordinates collapse to the same
 *       point and the whole matrix is legitimately zero — finite, square, symmetric,
 *       zero-diagonal, and the engine degrades to input order.
 *   Unresolved places are never sent to OSRM; their rows/columns are always
 *   haversine-filled, so a matrix containing one always reports 'mixed' (or
 *   'haversine'), never 'osrm'.
 */

(function () {
    'use strict';

    /* ── Configuration ── */
    const GEO_NOMINATIM_URL   = 'https://nominatim.openstreetmap.org/search';
    const GEO_OSRM_BASE       = 'https://router.project-osrm.org';
    const GEO_MIN_INTERVAL_MS = 1100;               // OSM usage policy: max 1 req/s
    const GEO_CACHE_PREFIX    = 'travio.geo.v1.';
    const GEO_CACHE_TTL_MS    = 30 * 24 * 60 * 60 * 1000;
    const GEO_CLOCK_SKEW_MS   = 5 * 60 * 1000;      // tolerated clock drift on cache reads
    const GEO_TIMEOUT_MS      = 12000;
    const GEO_MAX_TABLE       = 25;                 // guard against huge table URLs
    const GEO_ROAD_FACTOR     = 1.25;               // straight line -> road distance
    const GEO_SPEED_KMH       = 88;                 // fallback average driving speed
    const GEO_EARTH_R_KM      = 6371.0088;

    /* ── Environment seams (all lazy, all guarded) ── */
    function geoGlobalObject() {
        if (typeof globalThis !== 'undefined') return globalThis;
        if (typeof self !== 'undefined') return self;
        if (typeof window !== 'undefined') return window;
        return {};
    }

    function geoDefaultFetch() {
        const g = geoGlobalObject();
        if (typeof g.fetch === 'function') return g.fetch.bind(g);
        return null;
    }

    function geoDefaultSleep(ms) {
        const g = geoGlobalObject();
        if (typeof g.setTimeout !== 'function' || !(ms > 0)) return Promise.resolve();
        return new Promise(function (resolve) { g.setTimeout(resolve, ms); });
    }

    function geoDefaultStorage() {
        try {
            const s = geoGlobalObject().localStorage;
            if (s && typeof s.getItem === 'function' && typeof s.setItem === 'function') return s;
        } catch (e) { /* sandboxed iframe / disabled storage — treat as absent */ }
        return null;
    }

    function geoOptions(opts) {
        const o = opts && typeof opts === 'object' ? opts : {};
        const has = function (k) { return Object.prototype.hasOwnProperty.call(o, k); };
        return {
            fetchImpl:      typeof o.fetchImpl === 'function' ? o.fetchImpl : geoDefaultFetch(),
            sleepImpl:      typeof o.sleepImpl === 'function' ? o.sleepImpl : geoDefaultSleep,
            now:            typeof o.now === 'function' ? o.now : function () { return Date.now(); },
            storage:        has('storage') ? (o.storage || null) : geoDefaultStorage(),
            minIntervalMs:  typeof o.minIntervalMs === 'number' ? o.minIntervalMs : GEO_MIN_INTERVAL_MS,
            cacheTtlMs:     typeof o.cacheTtlMs === 'number' ? o.cacheTtlMs : GEO_CACHE_TTL_MS,
            clockSkewMs:    typeof o.clockSkewMs === 'number' ? o.clockSkewMs : GEO_CLOCK_SKEW_MS,
            timeoutMs:      typeof o.timeoutMs === 'number' ? o.timeoutMs : GEO_TIMEOUT_MS,
            nominatimUrl:   o.nominatimUrl || GEO_NOMINATIM_URL,
            osrmBase:       o.osrmBase || GEO_OSRM_BASE,
            maxTablePlaces: typeof o.maxTablePlaces === 'number' ? o.maxTablePlaces : GEO_MAX_TABLE,
            roadFactor:     typeof o.roadFactor === 'number' && o.roadFactor > 0 ? o.roadFactor : GEO_ROAD_FACTOR,
            speedKmh:       typeof o.speedKmh === 'number' && o.speedKmh > 0 ? o.speedKmh : GEO_SPEED_KMH,
            userAgent:      o.userAgent || '',
            language:       o.language || ''
        };
    }

    /* ── Small helpers ── */
    function geoIsFiniteNumber(v) {
        return typeof v === 'number' && isFinite(v);
    }

    function geoNum(v) {
        if (v === null || v === undefined || v === '') return NaN;
        const n = Number(v);
        return isFinite(n) ? n : NaN;
    }

    /* Coordinates accept only a number or a non-empty numeric string. Number(true) is 1
       and Number([]) is 0, so a loose coercion would invent a point off West Africa. */
    function geoCoordNum(v) {
        const isNumber = typeof v === 'number';
        const isNumericString = typeof v === 'string' && v.trim() !== '';
        if (!isNumber && !isNumericString) return NaN;
        const n = Number(v);
        return isFinite(n) ? n : NaN;
    }

    /* Single source of truth for "is this a usable coordinate", used by the network
       path, the cache path and the matrix/geometry paths alike. */
    function geoValidLatLon(lat, lon) {
        return isFinite(lat) && isFinite(lon) &&
               lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
    }

    function geoRound(v, decimals) {
        const f = Math.pow(10, decimals);
        return Math.round(v * f) / f;
    }

    /* Normalised cache / comparison key: lowercase, no accents, collapsed spaces. */
    function normalisePlaceName(name) {
        let s = (name === null || name === undefined) ? '' : String(name);
        s = s.trim().toLowerCase();
        if (typeof s.normalize === 'function') {
            s = s.normalize('NFD').replace(/[̀-ͯ]/g, '');
        }
        return s.replace(/\s+/g, ' ');
    }

    function geoMakePlace(name, lat, lon, source, extra) {
        const ok = geoIsFiniteNumber(lat) && geoIsFiniteNumber(lon) && geoValidLatLon(lat, lon);
        const place = {
            name: (name === null || name === undefined) ? '' : String(name),
            lat: ok ? lat : null,
            lon: ok ? lon : null,
            resolved: ok,
            source: source
        };
        if (extra) {
            for (const k in extra) {
                if (Object.prototype.hasOwnProperty.call(extra, k)) place[k] = extra[k];
            }
        }
        return place;
    }

    /* ── Haversine ── */
    function geoToRad(deg) { return deg * Math.PI / 180; }

    function haversineKm(aLat, aLon, bLat, bLon) {
        if (!geoIsFiniteNumber(aLat) || !geoIsFiniteNumber(aLon) ||
            !geoIsFiniteNumber(bLat) || !geoIsFiniteNumber(bLon)) return 0;
        const dLat = geoToRad(bLat - aLat);
        const dLon = geoToRad(bLon - aLon);
        const s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                  Math.cos(geoToRad(aLat)) * Math.cos(geoToRad(bLat)) *
                  Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(s), Math.sqrt(Math.max(0, 1 - s)));
        const km = GEO_EARTH_R_KM * c;
        return isFinite(km) ? km : 0;
    }

    /* ── HTTP (never throws, returns null on any failure) ── */
    async function geoFetchJson(url, cfg) {
        if (typeof cfg.fetchImpl !== 'function') return null;
        const g = geoGlobalObject();
        let controller = null;
        let timer = null;
        try {
            if (typeof g.AbortController === 'function' && typeof g.setTimeout === 'function') {
                controller = new g.AbortController();
                timer = g.setTimeout(function () {
                    try { controller.abort(); } catch (e) { /* ignore */ }
                }, cfg.timeoutMs);
            }
            const headers = { 'Accept': 'application/json' };
            if (cfg.userAgent) headers['User-Agent'] = cfg.userAgent;
            if (cfg.language) headers['Accept-Language'] = cfg.language;

            const init = { method: 'GET', headers: headers };
            if (controller) init.signal = controller.signal;

            const res = await cfg.fetchImpl(url, init);
            if (!res || res.ok === false) return null;
            if (typeof res.status === 'number' && (res.status < 200 || res.status >= 300)) return null;
            if (typeof res.json !== 'function') return null;
            return await res.json();
        } catch (e) {
            return null;
        } finally {
            if (timer !== null && typeof g.clearTimeout === 'function') g.clearTimeout(timer);
        }
    }

    /* ── Serial request queue + rate limiter (OSM: 1 request per second, one in flight) ── */
    let geoQueueTail = Promise.resolve();
    let geoLastRequestAt = 0;

    function geoEnqueue(task) {
        const run = geoQueueTail.then(task, task);
        geoQueueTail = run.then(function () {}, function () {});
        return run;
    }

    async function geoThrottle(cfg) {
        const elapsed = cfg.now() - geoLastRequestAt;
        const wait = cfg.minIntervalMs - elapsed;
        if (wait > 0) await cfg.sleepImpl(wait);
        geoLastRequestAt = cfg.now();
    }

    /* Test seam: forget the last-request timestamp and drain the queue reference. */
    function resetGeoRateLimit() {
        geoQueueTail = Promise.resolve();
        geoLastRequestAt = 0;
    }

    /* ── localStorage cache (no-ops safely when storage is unavailable) ── */
    function geoCacheKey(name) {
        return GEO_CACHE_PREFIX + normalisePlaceName(name);
    }

    function geoCacheDrop(name, cfg) {
        if (!cfg.storage || typeof cfg.storage.removeItem !== 'function') return;
        try { cfg.storage.removeItem(geoCacheKey(name)); } catch (e) { /* ignore */ }
    }

    /*
     * A cached entry gets EXACTLY the validation the network path performs — a poisoned
     * localStorage must not be able to inject coordinates that the parser would have
     * rejected, because those coordinates go straight into the OSRM URL. A future-dated
     * timestamp (beyond a small clock skew) is treated as expired: `now - ts > ttl` is
     * false forever for `ts = 9e15`, so it would otherwise be an immortal entry.
     */
    function geoCacheRead(name, cfg) {
        if (!cfg.storage) return null;
        let raw = null;
        try { raw = cfg.storage.getItem(geoCacheKey(name)); } catch (e) { return null; }
        if (!raw) return null;

        let entry = null;
        try { entry = JSON.parse(raw); } catch (e) { entry = null; }
        if (!entry || typeof entry !== 'object') { geoCacheDrop(name, cfg); return null; }

        const lat = geoCoordNum(entry.lat);
        const lon = geoCoordNum(entry.lon);
        const ts  = geoNum(entry.ts);
        if (!geoValidLatLon(lat, lon)) { geoCacheDrop(name, cfg); return null; }

        const age = cfg.now() - ts;
        if (!isFinite(ts) || age > cfg.cacheTtlMs || age < -cfg.clockSkewMs) {
            geoCacheDrop(name, cfg);
            return null;
        }
        return { lat: lat, lon: lon, displayName: entry.displayName || '' };
    }

    function geoCacheWrite(name, lat, lon, displayName, cfg) {
        if (!cfg.storage || typeof cfg.storage.setItem !== 'function') return;
        if (!geoValidLatLon(lat, lon)) return;
        try {
            cfg.storage.setItem(geoCacheKey(name), JSON.stringify({
                lat: lat, lon: lon, displayName: displayName || '', ts: cfg.now()
            }));
        } catch (e) { /* quota / private mode — cache is best-effort */ }
    }

    /* Remove every Travio geo cache entry (best effort). */
    function clearGeoCache(opts) {
        const cfg = geoOptions(opts);
        const s = cfg.storage;
        if (!s) return 0;
        let removed = 0;
        try {
            const keys = [];
            const n = typeof s.length === 'number' ? s.length : 0;
            for (let i = 0; i < n; i++) {
                const k = typeof s.key === 'function' ? s.key(i) : null;
                if (typeof k === 'string' && k.indexOf(GEO_CACHE_PREFIX) === 0) keys.push(k);
            }
            for (let i = 0; i < keys.length; i++) {
                try { s.removeItem(keys[i]); removed++; } catch (e) { /* ignore */ }
            }
        } catch (e) { /* ignore */ }
        return removed;
    }

    /* ── Geocoding ── */
    function geoNominatimUrl(name, cfg) {
        return cfg.nominatimUrl + '?format=jsonv2&limit=1&q=' + encodeURIComponent(name);
    }

    function geoParseNominatim(data) {
        if (!data) return null;
        const first = Array.isArray(data) ? data[0] : data;
        if (!first || typeof first !== 'object') return null;
        const lat = geoCoordNum(first.lat);
        const lon = geoCoordNum(first.lon);
        if (!geoValidLatLon(lat, lon)) return null;
        return { lat: lat, lon: lon, displayName: first.display_name || '' };
    }

    /*
     * geocodePlaces(names, opts) -> Promise<Place[]>
     * Sequential (>=1100ms apart, one request in flight at a time), cached, and
     * strictly index-aligned to `names`: never throws, never reorders, never drops.
     * A failed lookup yields { lat:null, lon:null, resolved:false } at its own index.
     */
    async function geocodePlaces(names, opts) {
        const cfg = geoOptions(opts);
        const list = Array.isArray(names) ? names : (names ? [names] : []);
        const out = new Array(list.length);
        const localCache = new Map();   // dedupe repeated names inside one call

        for (let i = 0; i < list.length; i++) {
            const raw = list[i];
            const name = (raw === null || raw === undefined) ? '' : String(raw);
            const key = normalisePlaceName(name);

            if (!key) {
                out[i] = geoMakePlace(name, null, null, 'osm', { error: 'empty-name' });
                continue;
            }

            if (localCache.has(key)) {
                const hit = localCache.get(key);
                out[i] = geoMakePlace(name, hit.lat, hit.lon, 'cache', { displayName: hit.displayName });
                continue;
            }

            const cached = geoCacheRead(name, cfg);
            if (cached) {
                localCache.set(key, cached);
                out[i] = geoMakePlace(name, cached.lat, cached.lon, 'cache', { displayName: cached.displayName });
                continue;
            }

            /* Network path — serialised through the shared queue. */
            const hit = await geoEnqueue(async function () {
                await geoThrottle(cfg);
                const data = await geoFetchJson(geoNominatimUrl(name, cfg), cfg);
                return geoParseNominatim(data);
            });

            if (hit) {
                localCache.set(key, hit);
                geoCacheWrite(name, hit.lat, hit.lon, hit.displayName, cfg);
                out[i] = geoMakePlace(name, hit.lat, hit.lon, 'osm', { displayName: hit.displayName });
            } else {
                /* Failures are NOT cached — a transient outage must not poison the cache. */
                out[i] = geoMakePlace(name, null, null, 'osm', { error: 'not-found' });
            }
        }

        return out;
    }

    /* ── Distance matrix ── */
    function geoZeroMatrix(n) {
        const m = new Array(n);
        for (let i = 0; i < n; i++) {
            m[i] = new Array(n);
            for (let j = 0; j < n; j++) m[i][j] = 0;
        }
        return m;
    }

    /*
     * Coordinates actually used for maths: unresolved (or out-of-range) places borrow
     * the centroid of the resolved ones — see the strategy note in the file header.
     */
    function geoEffectiveCoords(places) {
        const n = places.length;
        const eff = new Array(n);
        let sumLat = 0, sumLon = 0, count = 0;

        for (let i = 0; i < n; i++) {
            const p = places[i] || {};
            const lat = geoCoordNum(p.lat);
            const lon = geoCoordNum(p.lon);
            const ok = geoValidLatLon(lat, lon) && p.resolved !== false;
            eff[i] = ok ? { lat: lat, lon: lon, real: true } : null;
            if (ok) { sumLat += lat; sumLon += lon; count++; }
        }

        const centroid = count > 0
            ? { lat: sumLat / count, lon: sumLon / count }
            : { lat: 0, lon: 0 };

        for (let i = 0; i < n; i++) {
            if (!eff[i]) eff[i] = { lat: centroid.lat, lon: centroid.lon, real: false };
        }
        return eff;
    }

    function geoHaversineCell(eff, i, j, cfg) {
        const km = haversineKm(eff[i].lat, eff[i].lon, eff[j].lat, eff[j].lon) * cfg.roadFactor;
        const min = (km / cfg.speedKmh) * 60;
        return { km: geoRound(km, 2), min: geoRound(min, 1) };
    }

    function geoOsrmTableUrl(coords, cfg) {
        const parts = coords.map(function (c) { return c.lon + ',' + c.lat; }).join(';');
        return cfg.osrmBase + '/table/v1/driving/' + parts + '?annotations=duration,distance';
    }

    /*
     * A grid is only usable when it is exactly n x n. Wrong dimensions mean the rows do
     * not correspond to the coordinates we asked about, so the values cannot be trusted
     * even where they look numeric — a 5x5 answer to a 3-place question is rejected
     * outright rather than silently consumed as road data.
     */
    function geoGridStatus(grid, n) {
        if (grid === undefined || grid === null) return 'absent';
        if (!Array.isArray(grid) || grid.length !== n) return 'bad';
        for (let i = 0; i < n; i++) {
            if (!Array.isArray(grid[i]) || grid[i].length !== n) return 'bad';
        }
        return 'ok';
    }

    /*
     * Only a number, or a non-empty numeric string, is road data. Booleans, arrays and
     * objects are refused outright — Number(true) is 1 and Number([]) is 0, so a loose
     * coercion would quietly turn junk into a plausible-looking 1 metre or 0 minute leg.
     */
    function geoTableValue(grid, i, j, divisor) {
        if (!Array.isArray(grid) || !Array.isArray(grid[i])) return NaN;
        const v = grid[i][j];
        const isNumber = typeof v === 'number';
        const isNumericString = typeof v === 'string' && v.trim() !== '';
        if (!isNumber && !isNumericString) return NaN;
        const n = Number(v);
        if (!isFinite(n) || n < 0) return NaN;
        return n / divisor;
    }

    /* Average the two directions OSRM reports; accept a single direction if only one is valid. */
    function geoSymmetric(a, b) {
        const aOk = isFinite(a);
        const bOk = isFinite(b);
        if (aOk && bOk) return (a + b) / 2;
        if (aOk) return a;
        if (bOk) return b;
        return NaN;
    }

    /*
     * distanceMatrix(places, opts) -> Promise<Matrix>
     * Guarantees, on BOTH paths: square, index-aligned, zero diagonal, symmetric,
     * and every cell a finite non-negative number (never null / NaN / Infinity).
     * `source` describes the whole matrix — see the header note.
     */
    async function distanceMatrix(places, opts) {
        const cfg = geoOptions(opts);
        const list = Array.isArray(places) ? places : [];
        const n = list.length;

        const km = geoZeroMatrix(n);
        const min = geoZeroMatrix(n);
        if (n < 2) return { km: km, min: min, source: 'haversine', osrmCells: 0, filledCells: 0 };

        const eff = geoEffectiveCoords(list);

        /* Which places may be sent to OSRM — real coordinates only. */
        const realIdx = [];
        for (let i = 0; i < n; i++) if (eff[i].real) realIdx.push(i);

        let table = null;
        if (realIdx.length >= 2 && realIdx.length <= cfg.maxTablePlaces) {
            const coords = realIdx.map(function (i) { return eff[i]; });
            const data = await geoFetchJson(geoOsrmTableUrl(coords, cfg), cfg);
            if (data && (data.code === undefined || data.code === 'Ok')) {
                const dStatus = geoGridStatus(data.distances, coords.length);
                const tStatus = geoGridStatus(data.durations, coords.length);
                const usable = dStatus !== 'bad' && tStatus !== 'bad' &&
                               (dStatus === 'ok' || tStatus === 'ok');
                if (usable) {
                    table = {
                        distances: dStatus === 'ok' ? data.distances : null,
                        durations: tStatus === 'ok' ? data.durations : null
                    };
                }
            }
        }

        /* Position of each place inside the OSRM sub-matrix (-1 = not sent). */
        const sub = new Array(n);
        for (let i = 0; i < n; i++) sub[i] = -1;
        for (let k = 0; k < realIdx.length; k++) sub[realIdx[k]] = k;

        let osrmPairs = 0;
        let filledPairs = 0;

        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                let cellKm = NaN;
                let cellMin = NaN;

                if (table && sub[i] >= 0 && sub[j] >= 0) {
                    const a = sub[i], b = sub[j];
                    cellKm = geoSymmetric(
                        geoTableValue(table.distances, a, b, 1000),
                        geoTableValue(table.distances, b, a, 1000)
                    );
                    cellMin = geoSymmetric(
                        geoTableValue(table.durations, a, b, 60),
                        geoTableValue(table.durations, b, a, 60)
                    );
                }

                /* Per-cell fallback: keep the real values, fill only the broken cells.
                   A cell counts as road data only when BOTH km and min are real. */
                if (isFinite(cellKm) && isFinite(cellMin)) {
                    osrmPairs++;
                    cellKm = geoRound(cellKm, 2);
                    cellMin = geoRound(cellMin, 1);
                } else {
                    const hav = geoHaversineCell(eff, i, j, cfg);
                    if (isFinite(cellKm)) {
                        /* distance survived, duration did not (or vice versa) */
                        cellKm = geoRound(cellKm, 2);
                        cellMin = hav.min;
                    } else if (isFinite(cellMin)) {
                        cellKm = hav.km;
                        cellMin = geoRound(cellMin, 1);
                    } else {
                        cellKm = hav.km;
                        cellMin = hav.min;
                    }
                    filledPairs++;
                }

                if (!isFinite(cellKm) || cellKm < 0) cellKm = 0;
                if (!isFinite(cellMin) || cellMin < 0) cellMin = 0;

                km[i][j] = km[j][i] = cellKm;
                min[i][j] = min[j][i] = cellMin;
            }
            km[i][i] = 0;
            min[i][i] = 0;
        }

        /* The flag describes the whole matrix, not one lucky cell. */
        let source;
        if (osrmPairs === 0) source = 'haversine';
        else if (filledPairs === 0) source = 'osrm';
        else source = 'mixed';

        /* Reported per off-diagonal cell (both directions), matching the engine. */
        return {
            km: km,
            min: min,
            source: source,
            osrmCells: osrmPairs * 2,
            filledCells: filledPairs * 2
        };
    }

    /* ── Polyline (Google/OSRM "polyline5") decoding — no dependencies ── */
    function decodePolyline(encoded, precision) {
        const points = [];
        if (typeof encoded !== 'string' || encoded.length === 0) return points;
        const factor = Math.pow(10, geoIsFiniteNumber(precision) ? precision : 5);
        const len = encoded.length;
        let index = 0, lat = 0, lon = 0;

        while (index < len) {
            let result = 0, shift = 0, byte = 0;
            do {
                byte = encoded.charCodeAt(index++) - 63;
                result |= (byte & 0x1f) << shift;
                shift += 5;
            } while (byte >= 0x20 && index < len);
            lat += (result & 1) ? ~(result >> 1) : (result >> 1);

            result = 0; shift = 0; byte = 0;
            do {
                byte = encoded.charCodeAt(index++) - 63;
                result |= (byte & 0x1f) << shift;
                shift += 5;
            } while (byte >= 0x20 && index < len);
            lon += (result & 1) ? ~(result >> 1) : (result >> 1);

            const pLat = lat / factor;
            const pLon = lon / factor;
            if (isFinite(pLat) && isFinite(pLon)) points.push([pLat, pLon]);
        }
        return points;
    }

    /* ── Route geometry ── */
    function geoOsrmRouteUrl(coords, cfg) {
        const parts = coords.map(function (c) { return c.lon + ',' + c.lat; }).join(';');
        return cfg.osrmBase + '/route/v1/driving/' + parts + '?overview=full&geometries=polyline';
    }

    /*
     * routeGeometry(places, opts) -> Promise<[lat,lon][]>
     * OSRM overview polyline decoded to points. On any failure returns the resolved
     * place coordinates in order, i.e. straight segments between places.
     * The returned array carries a NON-ENUMERABLE `source` marker
     * ('osrm' | 'straight' | 'none') for the UI — it stays a plain Array for every
     * consumer (deep-equality, JSON.stringify, map libraries).
     */
    function geoTagSource(arr, source) {
        try {
            Object.defineProperty(arr, 'source', { value: source, enumerable: false, configurable: true });
        } catch (e) { /* ignore */ }
        return arr;
    }

    async function routeGeometry(places, opts) {
        const cfg = geoOptions(opts);
        const list = Array.isArray(places) ? places : [];

        const coords = [];
        for (let i = 0; i < list.length; i++) {
            const p = list[i] || {};
            const lat = geoCoordNum(p.lat);
            const lon = geoCoordNum(p.lon);
            if (geoValidLatLon(lat, lon) && p.resolved !== false) coords.push({ lat: lat, lon: lon });
        }

        const straight = coords.map(function (c) { return [c.lat, c.lon]; });

        if (coords.length < 2) {
            return geoTagSource(straight, coords.length ? 'straight' : 'none');
        }
        if (coords.length > cfg.maxTablePlaces) {
            return geoTagSource(straight, 'straight');
        }

        const data = await geoFetchJson(geoOsrmRouteUrl(coords, cfg), cfg);
        if (data && (data.code === undefined || data.code === 'Ok') && Array.isArray(data.routes) && data.routes[0]) {
            const geom = data.routes[0].geometry;
            if (typeof geom === 'string') {
                const points = decodePolyline(geom, 5);
                if (points.length >= 2) {
                    return geoTagSource(points, 'osrm');
                }
            } else if (geom && Array.isArray(geom.coordinates)) {
                /* geometries=geojson — [lon,lat] pairs */
                const points = [];
                for (let i = 0; i < geom.coordinates.length; i++) {
                    const c = geom.coordinates[i];
                    if (Array.isArray(c) && isFinite(Number(c[0])) && isFinite(Number(c[1]))) {
                        points.push([Number(c[1]), Number(c[0])]);
                    }
                }
                if (points.length >= 2) {
                    return geoTagSource(points, 'osrm');
                }
            }
        }

        return geoTagSource(straight, 'straight');
    }

    /* ── Exports ── only the documented API leaves this scope ── */
    const api = {
        geocodePlaces: geocodePlaces,
        distanceMatrix: distanceMatrix,
        routeGeometry: routeGeometry,
        decodePolyline: decodePolyline,
        haversineKm: haversineKm,
        normalisePlaceName: normalisePlaceName,
        clearGeoCache: clearGeoCache,
        resetGeoRateLimit: resetGeoRateLimit,
        GEO_MIN_INTERVAL_MS: GEO_MIN_INTERVAL_MS,
        GEO_ROAD_FACTOR: GEO_ROAD_FACTOR,
        GEO_SPEED_KMH: GEO_SPEED_KMH
    };

    if (typeof window !== 'undefined') {
        window.TravioGeo = api;
        /* Same eight documented functions bound directly, for the UI wiring. */
        window.geocodePlaces      = geocodePlaces;
        window.distanceMatrix     = distanceMatrix;
        window.routeGeometry      = routeGeometry;
        window.decodePolyline     = decodePolyline;
        window.haversineKm        = haversineKm;
        window.normalisePlaceName = normalisePlaceName;
        window.clearGeoCache      = clearGeoCache;
        window.resetGeoRateLimit  = resetGeoRateLimit;
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})();
