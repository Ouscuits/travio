/* ── Tests: js/geo-provider.js ── NETWORK-FREE (every fetch is stubbed) ── */
/* Run: node --test tests/geo-provider.test.js   (or node --test tests/) */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PROVIDER_PATH = path.join(__dirname, '..', 'js', 'geo-provider.js');
const geo = require(PROVIDER_PATH);

const {
    geocodePlaces, distanceMatrix, routeGeometry,
    decodePolyline, haversineKm, normalisePlaceName,
    clearGeoCache, resetGeoRateLimit
} = geo;

/* ── Test doubles ── */

/* Response-like object; `status` drives ok/failure. */
function jsonResponse(body, status) {
    const code = typeof status === 'number' ? status : 200;
    return {
        ok: code >= 200 && code < 300,
        status: code,
        json: async function () {
            if (body instanceof Error) throw body;
            return body;
        }
    };
}

/*
 * handler(url, init, callIndex) may return:
 *   - a plain object/array  -> 200 JSON body
 *   - a Response-like       -> used as-is
 *   - an Error instance     -> thrown (network failure)
 */
function makeFetch(handler) {
    const f = async function (url, init) {
        const idx = f.calls.length;
        f.calls.push(String(url));
        f.inFlight++;
        f.maxInFlight = Math.max(f.maxInFlight, f.inFlight);
        f.log.push('start:' + idx);
        try {
            await Promise.resolve();     // force a real async gap
            const r = await handler(String(url), init, idx);
            if (r instanceof Error) throw r;
            if (r && typeof r.json === 'function') return r;
            return jsonResponse(r);
        } finally {
            f.inFlight--;
            f.log.push('end:' + idx);
        }
    };
    f.calls = [];
    f.log = [];
    f.inFlight = 0;
    f.maxInFlight = 0;
    return f;
}

function makeStorage(seed) {
    const data = new Map();
    if (seed) for (const k in seed) data.set(k, seed[k]);
    return {
        getItem: function (k) { return data.has(k) ? data.get(k) : null; },
        setItem: function (k, v) { data.set(k, String(v)); },
        removeItem: function (k) { data.delete(k); },
        key: function (i) { const keys = Array.from(data.keys()); return i < keys.length ? keys[i] : null; },
        get length() { return data.size; },
        _data: data
    };
}

/* Controllable clock: sleepImpl advances it, so no test ever waits in real time. */
function makeClock(startAt) {
    const c = {
        t: typeof startAt === 'number' ? startAt : 1000000,
        sleeps: [],
        now: function () { return c.t; },
        sleep: function (ms) { c.sleeps.push(ms); c.t += ms; return Promise.resolve(); },
        advance: function (ms) { c.t += ms; }
    };
    return c;
}

/* Default opts for geocoding tests: never touches the real clock or network. */
function geoOpts(extra) {
    const base = { sleepImpl: function () { return Promise.resolve(); }, storage: null };
    if (extra) for (const k in extra) base[k] = extra[k];
    return base;
}

function nominatimHit(lat, lon, name) {
    return [{ lat: String(lat), lon: String(lon), display_name: name || 'Somewhere' }];
}

function cacheKeyFor(name) {
    return 'travio.geo.v1.' + normalisePlaceName(name);
}

function place(name, lat, lon) {
    return { name: name, lat: lat, lon: lon, resolved: lat !== null && lon !== null, source: 'osm' };
}

/* ── Shared invariant checker (the guarantee the engine depends on) ── */
function assertMatrixInvariants(m, n, label) {
    assert.ok(m && Array.isArray(m.km) && Array.isArray(m.min), label + ': matrix shape');
    assert.strictEqual(m.km.length, n, label + ': km rows');
    assert.strictEqual(m.min.length, n, label + ': min rows');
    assert.ok(m.source === 'osrm' || m.source === 'mixed' || m.source === 'haversine',
        label + ': source flag is one of osrm|mixed|haversine');

    /* D1: the flag must describe the WHOLE matrix, and the counts are contract fields.
       Counts are per off-diagonal CELL (both directions), matching the engine's
       dim*(dim-1) denominator — the matrix is symmetric, so pairs contribute two.
       They are NOT a partition: osrmCells counts cells carrying at least one road-graph
       value, filledCells cells carrying at least one estimated value, and a half-real
       cell (OSRM answered with distances but no durations) is in both. What IS pinned:
       filledCells === 0 <=> 'osrm', osrmCells === 0 <=> 'haversine', and every
       off-diagonal cell is in at least one bucket. */
    const offDiagonal = n < 2 ? 0 : n * (n - 1);
    assert.strictEqual(typeof m.osrmCells, 'number', label + ': osrmCells is a contract field');
    assert.strictEqual(typeof m.filledCells, 'number', label + ': filledCells is a contract field');
    assert.ok(m.osrmCells >= 0 && m.osrmCells <= offDiagonal, label + ': osrmCells in range');
    assert.ok(m.filledCells >= 0 && m.filledCells <= offDiagonal, label + ': filledCells in range');
    assert.ok(m.osrmCells + m.filledCells >= offDiagonal,
        label + ': every off-diagonal cell is accounted for at least once');
    assert.strictEqual(m.osrmCells % 2, 0, label + ': osrmCells counts both directions');
    assert.strictEqual(m.filledCells % 2, 0, label + ': filledCells counts both directions');
    if (m.source === 'osrm') {
        assert.strictEqual(m.filledCells, 0, label + ": 'osrm' means NOTHING was guessed");
        assert.strictEqual(m.osrmCells, offDiagonal, label + ": 'osrm' means every cell is road data");
    } else if (m.source === 'mixed') {
        assert.ok(m.osrmCells > 0, label + ": 'mixed' means some road data reached the matrix");
        assert.ok(m.filledCells > 0, label + ": 'mixed' means something was estimated");
    } else {
        assert.strictEqual(m.osrmCells, 0, label + ": 'haversine' means no road data at all");
        assert.strictEqual(m.filledCells, offDiagonal, label + ": 'haversine' means every cell is estimated");
    }
    for (let i = 0; i < n; i++) {
        assert.strictEqual(m.km[i].length, n, label + ': km square row ' + i);
        assert.strictEqual(m.min[i].length, n, label + ': min square row ' + i);
        assert.strictEqual(m.km[i][i], 0, label + ': km zero diagonal ' + i);
        assert.strictEqual(m.min[i][i], 0, label + ': min zero diagonal ' + i);
        for (let j = 0; j < n; j++) {
            for (const [grid, tag] of [[m.km, 'km'], [m.min, 'min']]) {
                const v = grid[i][j];
                assert.strictEqual(typeof v, 'number', label + ': ' + tag + '[' + i + '][' + j + '] is a number');
                assert.ok(!Number.isNaN(v), label + ': ' + tag + '[' + i + '][' + j + '] not NaN');
                assert.ok(Number.isFinite(v), label + ': ' + tag + '[' + i + '][' + j + '] finite');
                assert.ok(v >= 0, label + ': ' + tag + '[' + i + '][' + j + '] non-negative');
                assert.strictEqual(grid[i][j], grid[j][i], label + ': ' + tag + ' symmetric ' + i + ',' + j);
            }
        }
    }
}

/* ══════════════════════════════════════════════════════════════════════════
   Load-time safety
   ══════════════════════════════════════════════════════════════════════════ */

test('load: module loads in Node with no window and no localStorage', function () {
    assert.strictEqual(typeof globalThis.window, 'undefined', 'no window in the test env');
    assert.strictEqual(typeof globalThis.localStorage, 'undefined', 'no localStorage in the test env');
    assert.strictEqual(typeof geocodePlaces, 'function');
    assert.strictEqual(typeof distanceMatrix, 'function');
    assert.strictEqual(typeof routeGeometry, 'function');
});

test('load: fresh process with window/localStorage/fetch all absent does not throw and still returns a matrix', function () {
    const script = [
        'globalThis.fetch = undefined;',
        'globalThis.window = undefined;',
        'globalThis.localStorage = undefined;',
        'const g = require(' + JSON.stringify(PROVIDER_PATH) + ');',
        'if (typeof g.geocodePlaces !== "function") { process.exit(2); }',
        'g.distanceMatrix([',
        '  {name:"a",lat:40,lon:-3,resolved:true},',
        '  {name:"b",lat:41,lon:2,resolved:true}',
        ']).then(function (m) {',
        '  if (m.source !== "haversine") process.exit(3);',
        '  if (!isFinite(m.km[0][1]) || m.km[0][1] <= 0) process.exit(4);',
        '  return g.geocodePlaces(["x"]);',
        '}).then(function (p) {',
        '  if (p.length !== 1 || p[0].resolved !== false) process.exit(5);',
        '  console.log("ok");',
        '}).catch(function (e) { console.error(e); process.exit(6); });'
    ].join('\n');
    const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    assert.strictEqual(out.trim(), 'ok');
});

/* ══════════════════════════════════════════════════════════════════════════
   geocodePlaces
   ══════════════════════════════════════════════════════════════════════════ */

test('geocode: resolves places, preserves input order and index alignment', async function () {
    resetGeoRateLimit();
    const fetchImpl = makeFetch(function (url) {
        if (url.indexOf('Madrid') !== -1) return nominatimHit(40.4168, -3.7038, 'Madrid');
        if (url.indexOf('Sevilla') !== -1) return nominatimHit(37.3891, -5.9845, 'Sevilla');
        return nominatimHit(41.3874, 2.1686, 'Barcelona');
    });
    const out = await geocodePlaces(['Madrid', 'Barcelona', 'Sevilla'], geoOpts({ fetchImpl: fetchImpl }));

    assert.strictEqual(out.length, 3);
    assert.deepStrictEqual(out.map(p => p.name), ['Madrid', 'Barcelona', 'Sevilla']);
    assert.strictEqual(out[0].lat, 40.4168);
    assert.strictEqual(out[1].lon, 2.1686);
    assert.strictEqual(out[2].lat, 37.3891);
    out.forEach(function (p) {
        assert.strictEqual(p.resolved, true);
        assert.strictEqual(p.source, 'osm');
    });
    assert.strictEqual(fetchImpl.calls.length, 3);
    assert.ok(fetchImpl.calls[0].indexOf('format=jsonv2') !== -1, 'uses jsonv2');
    assert.ok(fetchImpl.calls[0].indexOf('limit=1') !== -1, 'uses limit=1');
});

test('geocode: cache hit avoids a second fetch', async function () {
    resetGeoRateLimit();
    const storage = makeStorage();
    const fetchImpl = makeFetch(function () { return nominatimHit(40.4168, -3.7038, 'Madrid'); });
    const opts = geoOpts({ fetchImpl: fetchImpl, storage: storage });

    const first = await geocodePlaces(['Madrid'], opts);
    assert.strictEqual(first[0].source, 'osm');
    assert.strictEqual(fetchImpl.calls.length, 1);
    assert.ok(storage._data.has(cacheKeyFor('Madrid')), 'entry written under the normalised key');

    /* Different casing / spacing / accents must hit the SAME cache entry. */
    const second = await geocodePlaces(['  MADRID '], opts);
    assert.strictEqual(fetchImpl.calls.length, 1, 'no second network call');
    assert.strictEqual(second[0].source, 'cache');
    assert.strictEqual(second[0].resolved, true);
    assert.strictEqual(second[0].lat, 40.4168);
    assert.strictEqual(second[0].name, '  MADRID ', 'the caller name is preserved verbatim');
});

test('geocode: repeated name inside one call is fetched once', async function () {
    resetGeoRateLimit();
    const fetchImpl = makeFetch(function () { return nominatimHit(1, 2, 'Dup'); });
    const out = await geocodePlaces(['Dup', 'dup', 'DUP'], geoOpts({ fetchImpl: fetchImpl }));
    assert.strictEqual(fetchImpl.calls.length, 1);
    assert.strictEqual(out.length, 3);
    assert.strictEqual(out[0].source, 'osm');
    assert.strictEqual(out[1].source, 'cache');
    assert.strictEqual(out[2].source, 'cache');
    out.forEach(p => assert.strictEqual(p.lat, 1));
});

test('geocode: expired cache entry is discarded and refetched', async function () {
    resetGeoRateLimit();
    const clock = makeClock(5000000);
    const seed = {};
    seed[cacheKeyFor('Lisboa')] = JSON.stringify({ lat: 1, lon: 1, ts: 0 });   // ancient
    const storage = makeStorage(seed);
    const fetchImpl = makeFetch(function () { return nominatimHit(38.72, -9.14, 'Lisboa'); });

    const out = await geocodePlaces(['Lisboa'], geoOpts({
        fetchImpl: fetchImpl, storage: storage, now: clock.now, sleepImpl: clock.sleep, cacheTtlMs: 1000
    }));
    assert.strictEqual(fetchImpl.calls.length, 1, 'stale entry forced a refetch');
    assert.strictEqual(out[0].lat, 38.72);
    assert.strictEqual(out[0].source, 'osm');
});

/* ── D3: the cache path validates exactly like the network path ── */

test('geocode D3: out-of-range cached coordinates are rejected, not served', async function () {
    /* Reported repro: a poisoned localStorage entry bypassed geoParseNominatim's range
       check and its coordinates went straight into the OSRM URL. */
    resetGeoRateLimit();
    const seed = {};
    seed[cacheKeyFor('T')] = JSON.stringify({ lat: 9999, lon: -77777, ts: Date.now() });
    const storage = makeStorage(seed);
    const fetchImpl = makeFetch(function () { return nominatimHit(41.9, 12.5, 'Real place'); });

    const out = await geocodePlaces(['T'], geoOpts({ fetchImpl: fetchImpl, storage: storage }));
    assert.strictEqual(fetchImpl.calls.length, 1, 'the poisoned entry did not short-circuit the lookup');
    assert.strictEqual(out[0].lat, 41.9, 'the network answer replaced it');
    assert.strictEqual(out[0].source, 'osm');
    assert.strictEqual(storage._data.get(cacheKeyFor('T')) !== undefined, true, 'a valid entry replaced it');
    assert.ok(String(storage._data.get(cacheKeyFor('T'))).indexOf('9999') === -1, 'poison evicted');
});

test('geocode D3: every out-of-range shape is refused by the cache', async function () {
    const bad = [
        { lat: 91, lon: 0 }, { lat: -91, lon: 0 }, { lat: 0, lon: 181 }, { lat: 0, lon: -181 },
        { lat: 'abc', lon: 0 }, { lat: null, lon: 3 }, { lat: 1 }, { lon: 1 },
        /* Number(true) is 1 and Number([]) is 0 — loose coercion would invent a point. */
        { lat: true, lon: true }, { lat: [], lon: [] }, { lat: [40], lon: [-3] },
        { lat: '', lon: '' }, { lat: {}, lon: {} }
    ];
    for (let i = 0; i < bad.length; i++) {
        resetGeoRateLimit();
        const name = 'Bad' + i;
        const seed = {};
        seed[cacheKeyFor(name)] = JSON.stringify(Object.assign({ ts: Date.now() }, bad[i]));
        const storage = makeStorage(seed);
        const fetchImpl = makeFetch(function () { return nominatimHit(10, 10, 'ok'); });
        const out = await geocodePlaces([name], geoOpts({ fetchImpl: fetchImpl, storage: storage }));
        assert.strictEqual(fetchImpl.calls.length, 1, JSON.stringify(bad[i]) + ' must not be served from cache');
        assert.strictEqual(out[0].lat, 10);
    }
});

test('geocode D3: a future-dated cache entry is treated as expired, not immortal', async function () {
    /* (now - ts) > ttl is false forever when ts = 9e15, so the entry would never expire. */
    resetGeoRateLimit();
    const clock = makeClock(1700000000000);
    const seed = {};
    seed[cacheKeyFor('Future')] = JSON.stringify({ lat: 1, lon: 1, ts: 9e15 });
    const storage = makeStorage(seed);
    const fetchImpl = makeFetch(function () { return nominatimHit(48.85, 2.35, 'Paris'); });

    const out = await geocodePlaces(['Future'], geoOpts({
        fetchImpl: fetchImpl, storage: storage, now: clock.now, sleepImpl: clock.sleep
    }));
    assert.strictEqual(fetchImpl.calls.length, 1, 'the immortal entry was refetched');
    assert.strictEqual(out[0].lat, 48.85);
    assert.strictEqual(out[0].source, 'osm');
});

test('geocode D3: a small clock skew is tolerated, a large one is not', async function () {
    const clock = makeClock(1700000000000);
    const fresh = function (tsOffset) {
        const seed = {};
        seed[cacheKeyFor('Skew')] = JSON.stringify({ lat: 2, lon: 2, ts: clock.now() + tsOffset });
        return makeStorage(seed);
    };

    resetGeoRateLimit();
    const tolerated = makeFetch(function () { return nominatimHit(9, 9, 'net'); });
    const a = await geocodePlaces(['Skew'], geoOpts({
        fetchImpl: tolerated, storage: fresh(60 * 1000), now: clock.now, sleepImpl: clock.sleep
    }));
    assert.strictEqual(tolerated.calls.length, 0, '1 minute of drift still serves the cache');
    assert.strictEqual(a[0].source, 'cache');

    resetGeoRateLimit();
    const refused = makeFetch(function () { return nominatimHit(9, 9, 'net'); });
    const b = await geocodePlaces(['Skew'], geoOpts({
        fetchImpl: refused, storage: fresh(60 * 60 * 1000), now: clock.now, sleepImpl: clock.sleep
    }));
    assert.strictEqual(refused.calls.length, 1, 'an hour in the future is not credible');
    assert.strictEqual(b[0].source, 'osm');
});

test('geocode D3: out-of-range network answers are refused too (unchanged behaviour)', async function () {
    resetGeoRateLimit();
    const fetchImpl = makeFetch(function () { return [{ lat: '9999', lon: '-77777', display_name: 'Nowhere' }]; });
    const storage = makeStorage();
    const out = await geocodePlaces(['Bogus'], geoOpts({ fetchImpl: fetchImpl, storage: storage }));
    assert.strictEqual(out[0].resolved, false);
    assert.strictEqual(out[0].lat, null);
    assert.strictEqual(storage._data.size, 0, 'nothing invalid was ever written');
});

test('geocode: corrupt cache entry is ignored, not fatal', async function () {
    resetGeoRateLimit();
    const seed = {};
    seed[cacheKeyFor('Oporto')] = '{not json';
    const storage = makeStorage(seed);
    const fetchImpl = makeFetch(function () { return nominatimHit(41.15, -8.61, 'Porto'); });
    const out = await geocodePlaces(['Oporto'], geoOpts({ fetchImpl: fetchImpl, storage: storage }));
    assert.strictEqual(out[0].resolved, true);
    assert.strictEqual(fetchImpl.calls.length, 1);
});

test('geocode: rate limiting serialises requests >=1100ms apart (stubbed clock)', async function () {
    resetGeoRateLimit();
    const clock = makeClock(2000000);
    const starts = [];
    const fetchImpl = makeFetch(function () {
        starts.push(clock.now());
        clock.advance(25);                       // simulated network latency
        return nominatimHit(10, 20, 'x');
    });

    await geocodePlaces(['A', 'B', 'C'], {
        fetchImpl: fetchImpl, storage: null, now: clock.now, sleepImpl: clock.sleep
    });

    assert.strictEqual(fetchImpl.calls.length, 3);
    assert.strictEqual(fetchImpl.maxInFlight, 1, 'never more than one request in flight');
    assert.deepStrictEqual(
        fetchImpl.log,
        ['start:0', 'end:0', 'start:1', 'end:1', 'start:2', 'end:2'],
        'requests do not overlap'
    );
    assert.strictEqual(clock.sleeps.length, 2, 'slept before request 2 and 3, not before the first');
    clock.sleeps.forEach(function (ms) { assert.ok(ms > 0, 'a real wait was requested'); });
    for (let i = 1; i < starts.length; i++) {
        assert.ok(starts[i] - starts[i - 1] >= 1100,
            'spacing ' + (starts[i] - starts[i - 1]) + 'ms >= 1100ms');
    }
});

test('geocode: concurrent calls still share the serial queue', async function () {
    resetGeoRateLimit();
    const clock = makeClock(3000000);
    const fetchImpl = makeFetch(function () { clock.advance(5); return nominatimHit(1, 1, 'y'); });
    const opts = { fetchImpl: fetchImpl, storage: null, now: clock.now, sleepImpl: clock.sleep };

    await Promise.all([
        geocodePlaces(['P1', 'P2'], opts),
        geocodePlaces(['P3', 'P4'], opts)
    ]);

    assert.strictEqual(fetchImpl.calls.length, 4);
    assert.strictEqual(fetchImpl.maxInFlight, 1, 'one in flight across concurrent callers');
});

test('geocode: failures keep index alignment and resolved:false, and never throw', async function () {
    resetGeoRateLimit();
    const fetchImpl = makeFetch(function (url, init, i) {
        if (i === 0) return nominatimHit(40, -3, 'Ok place');
        if (i === 1) return new Error('socket hang up');       // network failure
        if (i === 2) return jsonResponse([], 500);             // HTTP failure
        if (i === 3) return [];                                // empty result set
        return { garbage: true };                              // malformed body
    });

    const names = ['Good', 'NetworkDead', 'ServerError', 'NoResults', 'Malformed'];
    const out = await geocodePlaces(names, geoOpts({ fetchImpl: fetchImpl }));

    assert.strictEqual(out.length, names.length);
    assert.deepStrictEqual(out.map(p => p.name), names, 'order and every entry preserved');
    assert.strictEqual(out[0].resolved, true);
    for (let i = 1; i < out.length; i++) {
        assert.strictEqual(out[i].resolved, false, names[i] + ' unresolved');
        assert.strictEqual(out[i].lat, null);
        assert.strictEqual(out[i].lon, null);
        assert.ok(typeof out[i].source === 'string' && out[i].source.length > 0);
    }
});

test('geocode: failures are not cached', async function () {
    resetGeoRateLimit();
    const storage = makeStorage();
    let calls = 0;
    const fetchImpl = makeFetch(function () {
        calls++;
        return calls === 1 ? new Error('offline') : nominatimHit(5, 6, 'Later');
    });
    const opts = geoOpts({ fetchImpl: fetchImpl, storage: storage });

    const first = await geocodePlaces(['Flaky'], opts);
    assert.strictEqual(first[0].resolved, false);
    assert.strictEqual(storage._data.size, 0, 'nothing cached for a failed lookup');

    const second = await geocodePlaces(['Flaky'], opts);
    assert.strictEqual(second[0].resolved, true, 'retry succeeds after a transient failure');
});

test('geocode: works with no localStorage and with a throwing storage', async function () {
    resetGeoRateLimit();
    const fetchImpl = makeFetch(function () { return nominatimHit(1, 2, 'z'); });

    const noStore = await geocodePlaces(['Nowhere'], geoOpts({ fetchImpl: fetchImpl, storage: null, minIntervalMs: 0 }));
    assert.strictEqual(noStore[0].resolved, true);

    const hostile = {
        getItem: function () { throw new Error('SecurityError'); },
        setItem: function () { throw new Error('QuotaExceeded'); },
        removeItem: function () { throw new Error('nope'); }
    };
    const out = await geocodePlaces(['Nowhere 2'], geoOpts({ fetchImpl: fetchImpl, storage: hostile }));
    assert.strictEqual(out[0].resolved, true, 'storage errors are swallowed');
});

test('geocode: degenerate input does not throw', async function () {
    resetGeoRateLimit();
    const fetchImpl = makeFetch(function () { return nominatimHit(1, 1, 'q'); });
    const opts = geoOpts({ fetchImpl: fetchImpl });

    assert.deepStrictEqual(await geocodePlaces([], opts), []);
    assert.deepStrictEqual(await geocodePlaces(null, opts), []);

    const blanks = await geocodePlaces(['', '   ', null, undefined], opts);
    assert.strictEqual(blanks.length, 4);
    blanks.forEach(function (p) { assert.strictEqual(p.resolved, false); });
    assert.strictEqual(fetchImpl.calls.length, 0, 'blank names are never sent to Nominatim');
});

/* ══════════════════════════════════════════════════════════════════════════
   distanceMatrix
   ══════════════════════════════════════════════════════════════════════════ */

const MADRID = place('Madrid', 40.4168, -3.7038);
const BARCELONA = place('Barcelona', 41.3874, 2.1686);
const VALENCIA = place('Valencia', 39.4699, -0.3763);

test('matrix: OSRM success path parses distances and durations correctly', async function () {
    const fetchImpl = makeFetch(function (url) {
        assert.ok(url.indexOf('/table/v1/driving/') !== -1, 'uses the table service');
        assert.ok(url.indexOf('annotations=duration,distance') !== -1, 'requests both annotations');
        assert.ok(url.indexOf('-3.7038,40.4168') !== -1, 'lon,lat order');
        return {
            code: 'Ok',
            distances: [[0, 620000], [620000, 0]],   // metres
            durations: [[0, 21600], [21600, 0]]      // seconds
        };
    });

    const m = await distanceMatrix([MADRID, BARCELONA], { fetchImpl: fetchImpl, storage: null, minIntervalMs: 0 });
    assertMatrixInvariants(m, 2, 'osrm');
    assert.strictEqual(m.source, 'osrm');
    assert.strictEqual(m.km[0][1], 620);
    assert.strictEqual(m.min[0][1], 360);
    assert.strictEqual(m.filledCells, 0);
    assert.strictEqual(fetchImpl.calls.length, 1);
});

test('matrix: asymmetric OSRM values are symmetrised by averaging', async function () {
    /* Madrid-Barcelona: the two directions differ, and both are physically possible
       (the pair must clear the plausibility floor, or D2 would fill it instead). */
    const fetchImpl = makeFetch(function () {
        return {
            code: 'Ok',
            distances: [[0, 600000], [610000, 0]],     // -> 605 km
            durations: [[0, 21000], [21600, 0]]        // -> 355 min = 102 km/h
        };
    });
    const m = await distanceMatrix([MADRID, BARCELONA], { fetchImpl: fetchImpl, storage: null, minIntervalMs: 0 });
    assertMatrixInvariants(m, 2, 'symmetrised');
    assert.strictEqual(m.source, 'osrm');
    assert.strictEqual(m.km[0][1], 605);
    assert.strictEqual(m.min[0][1], 355);
});

test('matrix: total OSRM failure falls back to haversine with the source flag', async function () {
    const cases = [
        ['network error', function () { return new Error('ECONNRESET'); }],
        ['http 503', function () { return jsonResponse({}, 503); }],
        ['bad json', function () { return jsonResponse(new Error('Unexpected token')); }],
        ['osrm NoTable', function () { return { code: 'NoTable' }; }],
        ['missing grids', function () { return { code: 'Ok' }; }]
    ];

    for (const [label, handler] of cases) {
        const fetchImpl = makeFetch(handler);
        const m = await distanceMatrix([MADRID, BARCELONA, VALENCIA], { fetchImpl: fetchImpl, storage: null, minIntervalMs: 0 });
        assertMatrixInvariants(m, 3, label);
        assert.strictEqual(m.source, 'haversine', label + ': source flag');
        assert.strictEqual(m.osrmCells, 0, label + ': no osrm cells');
        assert.ok(m.km[0][1] > 500 && m.km[0][1] < 800, label + ': Madrid-Barcelona plausible (' + m.km[0][1] + ' km)');
        /* haversine * 1.25 at 90 km/h (calibrated — see the D2 fixture test below) */
        const expectedKm = haversineKm(40.4168, -3.7038, 41.3874, 2.1686) * 1.25;
        assert.ok(Math.abs(m.km[0][1] - expectedKm) < 0.02, label + ': road factor applied');
        assert.ok(Math.abs(m.min[0][1] - (expectedKm / 90) * 60) < 0.2, label + ': 90 km/h applied');
    }
});

test('matrix: partial null cells are filled per-cell, real values kept', async function () {
    const fetchImpl = makeFetch(function () {
        return {
            code: 'Ok',
            distances: [
                [0, 620000, null],
                [620000, 0, 350000],
                [null, 350000, 0]
            ],
            durations: [
                [0, 21600, null],
                [21600, 0, 12600],
                [null, 12600, 0]
            ]
        };
    });

    const m = await distanceMatrix([MADRID, BARCELONA, VALENCIA], { fetchImpl: fetchImpl, storage: null, minIntervalMs: 0 });
    assertMatrixInvariants(m, 3, 'partial');
    /* D1: 2 of 3 cells are real — that is 'mixed', NOT 'osrm'. The engine only warns
       when the flag admits the guessing, so 'osrm' here would silently hide it. */
    assert.strictEqual(m.source, 'mixed', 'partial road data must not claim to be osrm');
    assert.strictEqual(m.km[0][1], 620, 'real OSRM value kept');
    assert.strictEqual(m.min[1][2], 210, 'real OSRM value kept');
    assert.strictEqual(m.osrmCells, 4);
    assert.strictEqual(m.filledCells, 2, 'exactly the broken pair was filled');

    const expected = haversineKm(40.4168, -3.7038, 39.4699, -0.3763) * 1.25;
    assert.ok(Math.abs(m.km[0][2] - expected) < 0.02, 'null cell filled from haversine');
    assert.ok(m.min[0][2] > 0);
});

test('matrix: numeric strings are accepted; non-numeric and negative cells are broken and filled', async function () {
    /* Numeric strings ARE valid JSON numbers in disguise — Number('620000') is exact,
       so they are consumed as road data. Only genuinely unusable cells are filled. */
    const good = makeFetch(function () {
        return {
            code: 'Ok',
            distances: [[0, '620000'], ['620000', 0]],
            durations: [[0, '21600'], ['21600', 0]]
        };
    });
    const accepted = await distanceMatrix([MADRID, BARCELONA], { fetchImpl: good, storage: null, minIntervalMs: 0 });
    assertMatrixInvariants(accepted, 2, 'numeric strings');
    assert.strictEqual(accepted.source, 'osrm');
    assert.strictEqual(accepted.km[0][1], 620);
    assert.strictEqual(accepted.min[0][1], 360);
    assert.strictEqual(accepted.filledCells, 0);

    /* Non-numeric text, negatives, NaN, Infinity and objects are not usable. */
    const poisons = [
        ['non-numeric text', 'oops'],
        ['negative', -5],
        ['NaN', NaN],
        ['Infinity', Infinity],
        ['object', { km: 1 }],
        ['boolean', true]
    ];
    for (const [label, poison] of poisons) {
        const fetchImpl = makeFetch(function () {
            return {
                code: 'Ok',
                distances: [[0, poison], [poison, 0]],
                durations: [[0, poison], [poison, 0]]
            };
        });
        const m = await distanceMatrix([MADRID, BARCELONA], { fetchImpl: fetchImpl, storage: null, minIntervalMs: 0 });
        assertMatrixInvariants(m, 2, 'poison:' + label);
        assert.strictEqual(m.source, 'haversine', label + ' must not count as road data');
        assert.strictEqual(m.filledCells, 2, label + ' cell was filled');
    }
});

/* ── D1: the source flag describes the whole matrix ── */

test('matrix D1: source flag is osrm only when nothing was guessed', async function () {
    const allReal = makeFetch(function () {
        return {
            code: 'Ok',
            distances: [[0, 620000, 355000], [620000, 0, 350000], [355000, 350000, 0]],
            durations: [[0, 21600, 12600], [21600, 0, 12000], [12600, 12000, 0]]
        };
    });
    const m = await distanceMatrix([MADRID, BARCELONA, VALENCIA], { fetchImpl: allReal, storage: null, minIntervalMs: 0 });
    assertMatrixInvariants(m, 3, 'all real');
    assert.strictEqual(m.source, 'osrm');
    assert.strictEqual(m.osrmCells, 6);
    assert.strictEqual(m.filledCells, 0);
});

test('matrix D1: island repro — 3 of 10 real cells reports mixed, never osrm', async function () {
    /* The exact reported failure: OSRM cannot route to the Balearics, so every
       mainland<->island and island<->island pair comes back null. 7 of 10 cells are
       straight lines across open sea; claiming 'osrm' would suppress the engine warning
       and present "Palma -> Ibiza 161 km by road" as a driving distance. */
    const PALMA = place('Palma', 39.5696, 2.6502);
    const IBIZA = place('Ibiza', 38.9067, 1.4206);
    const places = [MADRID, BARCELONA, VALENCIA, PALMA, IBIZA];
    const N = 5;

    const fetchImpl = makeFetch(function () {
        const dist = [], dur = [];
        for (let i = 0; i < N; i++) {
            dist.push([]); dur.push([]);
            for (let j = 0; j < N; j++) {
                const island = i >= 3 || j >= 3;
                if (i === j) { dist[i].push(0); dur[i].push(0); }
                else if (island) { dist[i].push(null); dur[i].push(null); }
                /* 600 km in 360 min = 100 km/h: clears the D2 plausibility floor for
                   every mainland pair, the longest of which is 505 km as the crow flies. */
                else { dist[i].push(600000); dur[i].push(21600); }
            }
        }
        return { code: 'Ok', distances: dist, durations: dur };
    });

    const m = await distanceMatrix(places, { fetchImpl: fetchImpl, storage: null, minIntervalMs: 0 });
    assertMatrixInvariants(m, N, 'islands');
    assert.strictEqual(m.source, 'mixed', 'a 30%-real matrix must report mixed');
    assert.strictEqual(m.osrmCells, 6, 'the three mainland pairs are real (6 cells)');
    assert.strictEqual(m.filledCells, 14, 'the seven island pairs are straight-line guesses (14 cells)');
    assert.ok(m.km[3][4] > 0 && Number.isFinite(m.km[3][4]), 'Palma-Ibiza is still finite');
});

test('matrix D1: a single good cell in a sea of nulls does not earn the osrm flag', async function () {
    const fetchImpl = makeFetch(function () {
        return {
            code: 'Ok',
            distances: [[0, 620000, null], [620000, 0, null], [null, null, 0]],
            durations: [[0, 21600, null], [21600, 0, null], [null, null, 0]]
        };
    });
    const m = await distanceMatrix([MADRID, BARCELONA, VALENCIA], { fetchImpl: fetchImpl, storage: null, minIntervalMs: 0 });
    assertMatrixInvariants(m, 3, 'one good cell');
    assert.strictEqual(m.source, 'mixed');
    assert.strictEqual(m.osrmCells, 2);
    assert.strictEqual(m.filledCells, 4);
});

test('matrix D1: a half-real cell is mixed — the flag may not contradict the values', async function () {
    /* Reported repro. `source` used to lie in the SAFE-LOOKING direction: the exact
       road-graph distance was kept in km[0][1] and the matrix was flagged 'haversine',
       so the engine told the user "no road data at all — every distance is a
       straight-line estimate" about a number straight out of the road graph.
       A guessed duration means the cell is not clean, so it is NOT 'osrm'; a real
       distance means road data did reach the matrix, so it is NOT 'haversine'. */
    const fetchImpl = makeFetch(function () {
        return {
            code: 'Ok',
            distances: [[0, 620000], [620000, 0]],
            durations: [[0, null], [null, 0]]
        };
    });
    const m = await distanceMatrix([MADRID, BARCELONA], { fetchImpl: fetchImpl, storage: null, minIntervalMs: 0 });
    assertMatrixInvariants(m, 2, 'half a cell');
    assert.strictEqual(m.km[0][1], 620, 'the real distance is kept');
    assert.strictEqual(m.source, 'mixed', 'road data reached the matrix — this is not haversine');
    assert.strictEqual(m.osrmCells, 2, 'both directions carry a road-graph distance');
    assert.strictEqual(m.filledCells, 2, 'both directions carry an estimated duration');
    /* The estimated half is derived from the REAL road distance, not from the great
       circle — 620 km at the calibrated speed, not 505 x 1.25 at the calibrated speed. */
    assert.ok(Math.abs(m.min[0][1] - (620 / geo.GEO_SPEED_KMH) * 60) < 0.2,
        'duration estimated from the real road distance, got ' + m.min[0][1]);
});

test('matrix D1: a distances-only OSRM answer is mixed, not haversine', async function () {
    /* No `durations` key at all — the grid is absent rather than null-filled. */
    const fetchImpl = makeFetch(function () {
        return {
            code: 'Ok',
            distances: [[0, 616520, 355000], [616520, 0, 350000], [355000, 350000, 0]]
        };
    });
    const m = await distanceMatrix([MADRID, BARCELONA, VALENCIA], { fetchImpl: fetchImpl, storage: null, minIntervalMs: 0 });
    assertMatrixInvariants(m, 3, 'distances only');
    assert.strictEqual(m.km[0][1], 616.52, 'the exact road-graph distance survives');
    assert.strictEqual(m.source, 'mixed');
    assert.strictEqual(m.osrmCells, 6, 'every cell carries a road-graph distance');
    assert.strictEqual(m.filledCells, 6, 'every cell carries an estimated duration');
});

test('matrix D1: a durations-only OSRM answer is mixed, not haversine', async function () {
    /* This is the REACHABLE case: durations are OSRM's default /table annotation, so a
       server that ignores `annotations=duration,distance` produces exactly this. */
    const fetchImpl = makeFetch(function () {
        return {
            code: 'Ok',
            durations: [[0, 21600, 12600], [21600, 0, 12000], [12600, 12000, 0]]
        };
    });
    const m = await distanceMatrix([MADRID, BARCELONA, VALENCIA], { fetchImpl: fetchImpl, storage: null, minIntervalMs: 0 });
    assertMatrixInvariants(m, 3, 'durations only');
    assert.strictEqual(m.min[0][1], 360, 'the exact road-graph duration survives');
    assert.strictEqual(m.source, 'mixed');
    assert.strictEqual(m.osrmCells, 6, 'every cell carries a road-graph duration');
    assert.strictEqual(m.filledCells, 6, 'every cell carries an estimated distance');
    /* The missing half is the great circle x road factor — geometry we actually know,
       which beats back-solving a distance out of the duration. */
    const expected = haversineKm(40.4168, -3.7038, 41.3874, 2.1686) * 1.25;
    assert.ok(Math.abs(m.km[0][1] - expected) < 0.02, 'distance estimated from geometry');
});

/* ── D2: fallback speed calibration ── */

/*
 * Fixtures: published motorway road distances between Spanish city pairs, and the
 * reference OSRM duration band implied by the live measurement recorded in
 * docs/ENGINE_CONTRACT.md ("real long-haul average is 87-92 km/h"). The engine enforces
 * maxDriveMinPerDay on `min`, so a pessimistic fallback speed invents over-cap warnings
 * and over-splits days. Durations are DERIVED from the road distance and that measured
 * band — they are not independently measured here (this suite is network-free).
 */
const CALIBRATION = [
    { from: 'Madrid',    to: 'Barcelona', a: [40.4168, -3.7038], b: [41.3874,  2.1686], roadKm: 621 },
    { from: 'Madrid',    to: 'Sevilla',   a: [40.4168, -3.7038], b: [37.3891, -5.9845], roadKm: 531 },
    { from: 'Madrid',    to: 'Valencia',  a: [40.4168, -3.7038], b: [39.4699, -0.3763], roadKm: 356 },
    { from: 'Barcelona', to: 'Valencia',  a: [41.3874,  2.1686], b: [39.4699, -0.3763], roadKm: 350 },
    { from: 'Madrid',    to: 'Bilbao',    a: [40.4168, -3.7038], b: [43.2630, -2.9350], roadKm: 395 },
    { from: 'Madrid',    to: 'Malaga',    a: [40.4168, -3.7038], b: [36.7213, -4.4213], roadKm: 530 },
    { from: 'Barcelona', to: 'Zaragoza',  a: [41.3874,  2.1686], b: [41.6488, -0.8891], roadKm: 314 }
];

const OSRM_SPEED_LO = 87;   // measured long-haul band, docs/ENGINE_CONTRACT.md
const OSRM_SPEED_HI = 92;

async function fallbackLeg(fx, speedKmh) {
    const dead = makeFetch(function () { return new Error('offline'); });
    const opts = { fetchImpl: dead, storage: null, minIntervalMs: 0 };
    if (speedKmh) opts.speedKmh = speedKmh;
    const m = await distanceMatrix([
        place(fx.from, fx.a[0], fx.a[1]),
        place(fx.to, fx.b[0], fx.b[1])
    ], opts);
    assert.strictEqual(m.source, 'haversine');
    return { km: m.km[0][1], min: m.min[0][1] };
}

test('matrix D2: offline fallback distance stays within 10% of real road distance', async function () {
    let sumSigned = 0;
    for (const fx of CALIBRATION) {
        const leg = await fallbackLeg(fx);
        const errPct = (leg.km - fx.roadKm) / fx.roadKm * 100;
        sumSigned += errPct;
        assert.ok(Math.abs(errPct) <= 10,
            fx.from + '-' + fx.to + ' distance ' + leg.km.toFixed(0) + ' km vs road ' +
            fx.roadKm + ' km = ' + errPct.toFixed(1) + '% (the 1.25 road factor)');
    }
    const meanSigned = sumSigned / CALIBRATION.length;
    assert.ok(Math.abs(meanSigned) <= 5, 'mean signed distance error ' + meanSigned.toFixed(1) + '% is unbiased');
});

test('matrix D2: offline fallback duration lands inside the measured 87-92 km/h band', async function () {
    for (const fx of CALIBRATION) {
        const leg = await fallbackLeg(fx);
        const bandFast = fx.roadKm / OSRM_SPEED_HI * 60;   // shortest plausible OSRM duration
        const bandSlow = fx.roadKm / OSRM_SPEED_LO * 60;   // longest plausible OSRM duration
        assert.ok(leg.min >= bandFast * 0.90 && leg.min <= bandSlow * 1.10,
            fx.from + '-' + fx.to + ' fallback ' + leg.min.toFixed(0) + ' min vs OSRM band ' +
            bandFast.toFixed(0) + '-' + bandSlow.toFixed(0) + ' min (+/-10%)');
    }
});

test('matrix D2: 90 km/h roughly halves the error that 75 km/h produced', async function () {
    /* Regression guard for the recalibration itself: at 75 km/h every fixture was
       ~20% pessimistic, which is what manufactured false overDriveCap warnings. */
    let err90 = 0, err75 = 0;
    for (const fx of CALIBRATION) {
        const mid = fx.roadKm / ((OSRM_SPEED_LO + OSRM_SPEED_HI) / 2) * 60;
        const now = await fallbackLeg(fx);
        const old = await fallbackLeg(fx, 75);
        err90 += Math.abs(now.min - mid) / mid * 100;
        err75 += Math.abs(old.min - mid) / mid * 100;
    }
    err90 /= CALIBRATION.length;
    err75 /= CALIBRATION.length;
    assert.ok(err90 < 8, 'mean duration error at the calibrated speed is ' + err90.toFixed(1) + '%');
    assert.ok(err75 > 15, 'mean duration error at the old 75 km/h was ' + err75.toFixed(1) + '%');
    assert.ok(err90 < err75 / 2, 'the recalibration more than halved the error');
});

/* ── D4: OSRM response dimensions must match the request ── */

test('matrix D4: a table whose dimensions do not match the request is rejected', async function () {
    const cases = [
        ['5x5 answer to a 3-place question', function () {
            const g = [];
            for (let i = 0; i < 5; i++) {
                g.push([]);
                for (let j = 0; j < 5; j++) g[i].push(i === j ? 0 : 100000);
            }
            return { code: 'Ok', distances: g, durations: g };
        }],
        ['2x2 answer to a 3-place question', function () {
            return { code: 'Ok', distances: [[0, 1000], [1000, 0]], durations: [[0, 60], [60, 0]] };
        }],
        ['ragged rows', function () {
            return {
                code: 'Ok',
                distances: [[0, 1000, 2000], [1000, 0], [2000, 3000, 0]],
                durations: [[0, 60, 120], [60, 0, 180], [120, 180, 0]]
            };
        }],
        ['rows are not arrays', function () {
            return { code: 'Ok', distances: [0, 1, 2], durations: [0, 1, 2] };
        }],
        ['distances is an object', function () {
            return { code: 'Ok', distances: { '0': [0, 1, 2] }, durations: [[0, 60, 120], [60, 0, 180], [120, 180, 0]] };
        }]
    ];

    for (const [label, handler] of cases) {
        const fetchImpl = makeFetch(handler);
        const m = await distanceMatrix([MADRID, BARCELONA, VALENCIA], { fetchImpl: fetchImpl, storage: null, minIntervalMs: 0 });
        assertMatrixInvariants(m, 3, 'dims:' + label);
        assert.strictEqual(m.source, 'haversine', label + ' must be rejected, not consumed');
        assert.strictEqual(m.osrmCells, 0, label);
        /* And the values are the honest straight-line estimate, not the bogus grid. */
        const expected = haversineKm(40.4168, -3.7038, 41.3874, 2.1686) * 1.25;
        assert.ok(Math.abs(m.km[0][1] - expected) < 0.02, label + ': haversine values used');
    }
});

test('matrix D4: correct dimensions after unresolved places are excluded', async function () {
    /* 4 places, 1 unresolved -> OSRM is asked about 3, so a 3x3 answer is correct
       and a 4x4 answer (matching the input, not the request) must be rejected. */
    const ghost = place('Atlantis', null, null);

    const right = makeFetch(function () {
        return {
            code: 'Ok',
            distances: [[0, 620000, 355000], [620000, 0, 350000], [355000, 350000, 0]],
            durations: [[0, 21600, 12600], [21600, 0, 12000], [12600, 12000, 0]]
        };
    });
    const ok = await distanceMatrix([MADRID, ghost, BARCELONA, VALENCIA], { fetchImpl: right, storage: null, minIntervalMs: 0 });
    assertMatrixInvariants(ok, 4, 'ghost 3x3');
    assert.strictEqual(ok.source, 'mixed');
    assert.strictEqual(ok.osrmCells, 6, 'the three resolved pairs are real (6 cells)');
    assert.strictEqual(ok.km[0][2], 620);

    const wrong = makeFetch(function () {
        const g = [];
        for (let i = 0; i < 4; i++) {
            g.push([]);
            for (let j = 0; j < 4; j++) g[i].push(i === j ? 0 : 100000);
        }
        return { code: 'Ok', distances: g, durations: g };
    });
    const bad = await distanceMatrix([MADRID, ghost, BARCELONA, VALENCIA], { fetchImpl: wrong, storage: null, minIntervalMs: 0 });
    assertMatrixInvariants(bad, 4, 'ghost 4x4');
    assert.strictEqual(bad.source, 'haversine', 'a 4x4 answer to a 3-place request is misaligned');
});

test('matrix: unresolved places still get finite cells (centroid strategy) and are not sent to OSRM', async function () {
    const ghost = place('Atlantis', null, null);
    const fetchImpl = makeFetch(function (url) {
        const coords = url.split('/driving/')[1].split('?')[0].split(';');
        assert.strictEqual(coords.length, 2, 'only the two resolved places are sent');
        assert.ok(url.indexOf('Atlantis') === -1);
        return { code: 'Ok', distances: [[0, 620000], [620000, 0]], durations: [[0, 21600], [21600, 0]] };
    });

    const m = await distanceMatrix([MADRID, ghost, BARCELONA], { fetchImpl: fetchImpl, storage: null, minIntervalMs: 0 });
    assertMatrixInvariants(m, 3, 'unresolved');
    /* Two of three cells are centroid guesses, so the matrix is 'mixed' — an unresolved
       place can never leave the matrix flagged as pure road data. */
    assert.strictEqual(m.source, 'mixed');
    assert.strictEqual(m.km[0][2], 620, 'the resolved pair keeps its road distance');
    assert.ok(Number.isFinite(m.km[0][1]) && m.km[0][1] > 0, 'ghost row is finite and positive');
    assert.ok(Number.isFinite(m.min[1][2]) && m.min[1][2] > 0);
    /* The ghost sits at the centroid of Madrid+Barcelona: both of its legs are
       about half the direct distance and within a few km of each other. */
    const direct = haversineKm(40.4168, -3.7038, 41.3874, 2.1686) * 1.25;
    assert.ok(Math.abs(m.km[0][1] - m.km[1][2]) < 5, 'both ghost legs are near-equal');
    assert.ok(Math.abs(m.km[0][1] - direct / 2) < 5, 'ghost leg is ~half the direct distance');
});

test('matrix: every place unresolved yields a zero but finite matrix', async function () {
    const fetchImpl = makeFetch(function () { throw new Error('must not be called'); });
    const m = await distanceMatrix(
        [place('A', null, null), place('B', null, null), place('C', null, null)],
        { fetchImpl: fetchImpl, storage: null, minIntervalMs: 0 }
    );
    assertMatrixInvariants(m, 3, 'all unresolved');
    assert.strictEqual(m.source, 'haversine');
    assert.strictEqual(fetchImpl.calls.length, 0, 'no request without usable coordinates');
    assert.strictEqual(m.km[0][1], 0);
    assert.strictEqual(m.min[2][0], 0);
});

test('matrix: degenerate sizes and oversized inputs skip the network', async function () {
    const fetchImpl = makeFetch(function () { throw new Error('must not be called'); });

    const empty = await distanceMatrix([], { fetchImpl: fetchImpl, storage: null, minIntervalMs: 0 });
    assertMatrixInvariants(empty, 0, 'empty');
    const one = await distanceMatrix([MADRID], { fetchImpl: fetchImpl, storage: null, minIntervalMs: 0 });
    assertMatrixInvariants(one, 1, 'single');
    const notArray = await distanceMatrix(null, { fetchImpl: fetchImpl, storage: null, minIntervalMs: 0 });
    assertMatrixInvariants(notArray, 0, 'null input');

    const many = [];
    for (let i = 0; i < 40; i++) many.push(place('P' + i, 40 + i * 0.1, -3 + i * 0.1));
    const big = await distanceMatrix(many, { fetchImpl: fetchImpl, storage: null, minIntervalMs: 0 });
    assertMatrixInvariants(big, 40, 'oversized');
    assert.strictEqual(big.source, 'haversine', 'too many places for the table service');
    assert.strictEqual(fetchImpl.calls.length, 0);
});

test('matrix: invariants hold on a larger mixed input (resolved + unresolved, partial OSRM)', async function () {
    const places = [
        place('A', 40.0, -3.0),
        place('B', null, null),
        place('C', 41.0, 2.0),
        place('D', 39.0, -0.4),
        place('E', null, null)
    ];
    const fetchImpl = makeFetch(function () {
        return {
            code: 'Ok',
            distances: [[0, 500000, null], [500000, 0, 350000], [null, 350000, 0]],
            durations: [[0, 18000, 30000], [18000, 0, null], [30000, null, 0]]
        };
    });
    const m = await distanceMatrix(places, { fetchImpl: fetchImpl, storage: null, minIntervalMs: 0 });
    assertMatrixInvariants(m, 5, 'mixed');
    assert.strictEqual(m.source, 'mixed');
    assert.ok(m.osrmCells >= 1, 'some real road data survived');
    assert.ok(m.filledCells >= 1, 'the rest was filled');
});

/* ── Hostile fuzz: the matrix guarantee and the flag law must survive anything ── */

test('matrix: 600 hostile OSRM responses keep every invariant and an honest flag', async function () {
    /* Deterministic LCG so a failure is reproducible from the seed alone. */
    let seed = 20260806;
    const rnd = function () { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const pick = function (arr) { return arr[Math.floor(rnd() * arr.length) % arr.length]; };

    const POISON = [null, undefined, NaN, Infinity, -Infinity, -1, 'x', '', {}, [], true, false, 1e308 * 10];
    let sawOsrm = 0, sawMixed = 0, sawHaversine = 0;

    for (let iter = 0; iter < 600; iter++) {
        const n = 2 + Math.floor(rnd() * 5);           // 2..6 places
        const places = [];
        for (let i = 0; i < n; i++) {
            const r = rnd();
            if (r < 0.15) places.push(place('ghost' + i, null, null));
            else if (r < 0.2) places.push({ name: 'weird' + i, lat: 9999, lon: -77777, resolved: true });
            else places.push(place('p' + i, -85 + rnd() * 170, -175 + rnd() * 350));
        }

        const realPlaces = places.filter(function (p) {
            return p.resolved && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;
        });
        const realCount = realPlaces.length;

        const mode = rnd();
        /* Whole-response mode: sometimes every cell is a physically credible road value,
           so the 'osrm' state is still reachable now that D2 rejects impossible numbers.
           A uniformly random metre count between two random points on Earth almost never
           IS a road distance, which is the whole point of the plausibility floor. */
        const credible = rnd() < 0.35;
        const fetchImpl = makeFetch(function () {
            if (mode < 0.1) return new Error('boom');
            if (mode < 0.2) return jsonResponse({}, 500);
            if (mode < 0.25) return { code: 'NoTable' };
            if (mode < 0.3) return null;
            /* Sometimes answer with the wrong dimensions on purpose. */
            const dim = mode < 0.4 ? Math.max(1, realCount + (rnd() < 0.5 ? 1 : -1)) : realCount;
            const dist = [], dur = [];
            for (let i = 0; i < dim; i++) {
                dist.push([]); dur.push([]);
                for (let j = 0; j < dim; j++) {
                    if (i === j) { dist[i].push(0); dur[i].push(0); continue; }
                    if (credible && dim === realCount) {
                        const a = realPlaces[i], b = realPlaces[j];
                        const roadKm = haversineKm(a.lat, a.lon, b.lat, b.lon) * (1.2 + rnd() * 0.3);
                        const kmh = 60 + rnd() * 60;
                        dist[i].push(Math.round(roadKm * 1000));
                        dur[i].push(Math.round(roadKm / kmh * 3600));
                        continue;
                    }
                    dist[i].push(rnd() < 0.5 ? Math.floor(rnd() * 900000) : pick(POISON));
                    dur[i].push(rnd() < 0.5 ? Math.floor(rnd() * 40000) : pick(POISON));
                }
            }
            return { code: 'Ok', distances: dist, durations: dur };
        });

        const m = await distanceMatrix(places, { fetchImpl: fetchImpl, storage: null, minIntervalMs: 0 });
        assertMatrixInvariants(m, n, 'fuzz#' + iter);
        if (m.source === 'osrm') sawOsrm++;
        else if (m.source === 'mixed') sawMixed++;
        else sawHaversine++;
    }

    assert.ok(sawOsrm > 0 && sawMixed > 0 && sawHaversine > 0,
        'all three source states were exercised (osrm=' + sawOsrm + ', mixed=' + sawMixed +
        ', haversine=' + sawHaversine + ')');
});

/* ══════════════════════════════════════════════════════════════════════════
   routeGeometry + polyline decoding
   ══════════════════════════════════════════════════════════════════════════ */

test('polyline: decodes the canonical fixture exactly', function () {
    /* Google's reference example: (38.5,-120.2) (40.7,-120.95) (43.252,-126.453) */
    const pts = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    assert.deepStrictEqual(pts, [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]);
});

test('polyline: handles empty and garbage input without throwing', function () {
    assert.deepStrictEqual(decodePolyline(''), []);
    assert.deepStrictEqual(decodePolyline(null), []);
    assert.deepStrictEqual(decodePolyline(undefined), []);
    assert.ok(Array.isArray(decodePolyline('????')));
    assert.ok(Array.isArray(decodePolyline('~~~~~~~~')));
});

test('geometry: OSRM route polyline is decoded', async function () {
    const fetchImpl = makeFetch(function (url) {
        assert.ok(url.indexOf('/route/v1/driving/') !== -1);
        assert.ok(url.indexOf('overview=full') !== -1);
        assert.ok(url.indexOf('geometries=polyline') !== -1);
        return { code: 'Ok', routes: [{ geometry: '_p~iF~ps|U_ulLnnqC_mqNvxq`@' }] };
    });
    const pts = await routeGeometry([MADRID, BARCELONA], { fetchImpl: fetchImpl, storage: null, minIntervalMs: 0 });
    assert.strictEqual(pts.length, 3);
    assert.deepStrictEqual(pts[0], [38.5, -120.2]);
    assert.strictEqual(pts.source, 'osrm');
});

test('geometry: falls back to straight segments between places', async function () {
    const failures = [
        function () { return new Error('down'); },
        function () { return jsonResponse({}, 404); },
        function () { return { code: 'NoRoute' }; },
        function () { return { code: 'Ok', routes: [] }; },
        function () { return { code: 'Ok', routes: [{ geometry: '' }] }; }
    ];
    for (const handler of failures) {
        const fetchImpl = makeFetch(handler);
        const pts = await routeGeometry([MADRID, BARCELONA, VALENCIA], { fetchImpl: fetchImpl, storage: null, minIntervalMs: 0 });
        assert.deepStrictEqual(pts, [
            [40.4168, -3.7038], [41.3874, 2.1686], [39.4699, -0.3763]
        ]);
        assert.strictEqual(pts.source, 'straight');
    }
});

test('geometry: unresolved places are skipped and thin input needs no request', async function () {
    const fetchImpl = makeFetch(function () { throw new Error('must not be called'); });
    const none = await routeGeometry([], { fetchImpl: fetchImpl, storage: null, minIntervalMs: 0 });
    assert.deepStrictEqual(none, []);
    assert.strictEqual(none.source, 'none');

    const one = await routeGeometry([MADRID, place('Ghost', null, null)], { fetchImpl: fetchImpl, storage: null, minIntervalMs: 0 });
    assert.deepStrictEqual(one, [[40.4168, -3.7038]]);
    assert.strictEqual(one.source, 'straight');
    assert.strictEqual(fetchImpl.calls.length, 0);
});

/* ══════════════════════════════════════════════════════════════════════════
   D5: browser surface — IIFE, no helper leakage, safe to load twice
   ══════════════════════════════════════════════════════════════════════════ */

/* D5b: `resetGeoRateLimit` is deliberately NOT here — it is a Node-only test seam and
   a way to break the OSM usage policy from the page. See the D5b test below. */
const DOCUMENTED_GLOBALS = [
    'TravioGeo', 'geocodePlaces', 'distanceMatrix', 'routeGeometry', 'decodePolyline',
    'haversineKm', 'normalisePlaceName', 'clearGeoCache'
];

function loadInFakeBrowser(times) {
    const fs = require('node:fs');
    const vm = require('node:vm');
    const src = fs.readFileSync(PROVIDER_PATH, 'utf8');
    const win = {};
    const ctx = vm.createContext({ window: win, setTimeout: setTimeout, clearTimeout: clearTimeout });
    for (let i = 0; i < (times || 1); i++) {
        vm.runInContext(src, ctx, { filename: 'geo-provider.js' });
    }
    return { win: win, ctx: ctx };
}

test('D5: browser load exposes only the documented API, no geo* helpers', function () {
    const loaded = loadInFakeBrowser(1);
    const keys = Object.keys(loaded.win).sort();
    assert.deepStrictEqual(keys, DOCUMENTED_GLOBALS.slice().sort(),
        'exactly the documented names are exposed');
    const leaked = keys.filter(function (k) { return /^geo[A-Z]/.test(k) || /^GEO_/.test(k); });
    assert.deepStrictEqual(leaked, [], 'no internal helper or constant leaked');
    assert.strictEqual(typeof loaded.win.TravioGeo.distanceMatrix, 'function', 'namespace object works');
    assert.strictEqual(loaded.win.TravioGeo.GEO_SPEED_KMH, 90, 'calibrated speed is published');
});

test('D5: a duplicated <script> tag re-runs without throwing', function () {
    assert.doesNotThrow(function () { loadInFakeBrowser(3); },
        'no "Identifier ... has already been declared"');
    const loaded = loadInFakeBrowser(2);
    assert.strictEqual(typeof loaded.win.geocodePlaces, 'function', 'still usable after a second load');
});

test('D5: the browser build degrades to haversine when fetch is absent', async function () {
    const loaded = loadInFakeBrowser(1);
    const m = await loaded.win.distanceMatrix(
        [{ name: 'a', lat: 40, lon: -3, resolved: true }, { name: 'b', lat: 41, lon: 2, resolved: true }],
        { storage: null }
    );
    assert.strictEqual(m.source, 'haversine');
    assert.ok(Number.isFinite(m.km[0][1]) && m.km[0][1] > 0);
});

/* ══════════════════════════════════════════════════════════════════════════
   D6: plausibility floor — a number is road data only if it could physically be one
   ══════════════════════════════════════════════════════════════════════════ */

const MAD_BCN_HAV_KM = haversineKm(40.4168, -3.7038, 41.3874, 2.1686) * 1.25;

test('matrix D6: physically impossible OSRM pairs are refused, never shipped as road data', async function () {
    /* Reported repro: 617 km in 1 second arrived as km 617 / min 0 / speed Infinity,
       source 'osrm', zero warnings — and because the engine caps days on `min`, a
       zero-minute leg packs the trip into fewer days. That is the day-splitting bug.
       An all-zero grid shipped 0 km between cities 505 km apart, also as clean 'osrm'. */
    const cases = [
        ['617 km in 1 second',        [[0, 617000], [617000, 0]], [[0, 1], [1, 0]]],
        ['all-zero grid',             [[0, 0], [0, 0]],           [[0, 0], [0, 0]]],
        ['real distance, zero time',  [[0, 620000], [620000, 0]], [[0, 0], [0, 0]]],
        ['620 km at 0.6 km/h',        [[0, 620000], [620000, 0]], [[0, 3600000], [3600000, 0]]],
        ['620 km in 30 minutes',      [[0, 620000], [620000, 0]], [[0, 1800], [1800, 0]]]
    ];

    for (const [label, distances, durations] of cases) {
        const fetchImpl = makeFetch(function () {
            return { code: 'Ok', distances: distances, durations: durations };
        });
        const m = await distanceMatrix([MADRID, BARCELONA], { fetchImpl: fetchImpl, storage: null, minIntervalMs: 0 });
        assertMatrixInvariants(m, 2, 'D6:' + label);
        assert.strictEqual(m.source, 'haversine', label + ' is not road data');
        assert.strictEqual(m.osrmCells, 0, label + ': nothing from that response was kept');
        assert.strictEqual(m.filledCells, 2, label + ': the cell was filled');
        assert.ok(Math.abs(m.km[0][1] - MAD_BCN_HAV_KM) < 0.02,
            label + ': the honest estimate replaced it, got ' + m.km[0][1] + ' km');
        assert.ok(m.min[0][1] > 0, label + ': a real trip never takes zero minutes');
        const kmh = m.km[0][1] / (m.min[0][1] / 60);
        assert.ok(kmh >= 5 && kmh <= 200, label + ': the shipped cell implies ' + kmh.toFixed(1) + ' km/h');
    }
});

test('matrix D6: a distance shorter than the great circle discredits the whole cell', async function () {
    /* 5 km between Madrid and Barcelona cannot be a road, and 360 minutes on its own
       could be a drive — but the two arrive together, and the mechanism that produces a
       too-short distance is endpoint mis-snapping, which corrupts both halves equally.
       Measured: asking OSRM for Algeciras -> Ceuta (30 km across the strait) snapped the
       Ceuta endpoint 22.5 km away onto the Spanish coast and answered 12 km / 18 min —
       a real journey, just not the one requested. Keeping that duration would present a
       measurement of somewhere else as road data.
       (Round 4 asserted the duration should be kept here, on the reasoning that
       discarding only the broken half is more honest. The snapping measurement above
       showed the halves are not independent.) */
    const fetchImpl = makeFetch(function () {
        return {
            code: 'Ok',
            distances: [[0, 5000], [5000, 0]],
            durations: [[0, 21600], [21600, 0]]
        };
    });
    const m = await distanceMatrix([MADRID, BARCELONA], { fetchImpl: fetchImpl, storage: null, minIntervalMs: 0 });
    assertMatrixInvariants(m, 2, 'D6 mis-snapped');
    assert.notStrictEqual(m.km[0][1], 5, 'the impossible distance never reaches the matrix');
    assert.ok(Math.abs(m.km[0][1] - MAD_BCN_HAV_KM) < 0.02, 'geometry replaced it');
    assert.strictEqual(m.source, 'haversine', 'the answer was about a different pair of points');
    assert.strictEqual(m.osrmCells, 0);

    /* A distance rejected by the DETOUR CEILING is a different matter — nothing about it
       says the endpoints were wrong — so the duration keeps its own separate hearing. */
    const tooLong = makeFetch(function () {
        return {
            code: 'Ok',
            distances: [[0, 6000000], [6000000, 0]],          // 6000 km, above the x10 ceiling
            durations: [[0, 21600], [21600, 0]]               // 360 min, credible on its own
        };
    });
    const far = await distanceMatrix([MADRID, BARCELONA], { fetchImpl: tooLong, storage: null, minIntervalMs: 0 });
    assertMatrixInvariants(far, 2, 'D6 over-ceiling');
    assert.ok(Math.abs(far.km[0][1] - MAD_BCN_HAV_KM) < 0.02, 'the x12 distance was refused');
    assert.strictEqual(far.min[0][1], 360, 'the credible duration survived on its own merits');
    assert.strictEqual(far.source, 'mixed');
});

test('matrix D6: plausible short legs are NOT churned by the floor', async function () {
    /* The floor must not become a second bug. A 400 m hop in 2 minutes (12 km/h) is
       exempt because rounding noise dominates below 1 km; a 3 km city leg in 12 minutes
       (15 km/h) is slow but entirely real, and both must survive as road data. */
    const NEAR = place('Near', 40.4195, -3.7038);       // ~300 m from Madrid
    const CITY = place('City', 40.4366, -3.7038);       // ~2.2 km from Madrid

    const hop = makeFetch(function () {
        return { code: 'Ok', distances: [[0, 400], [400, 0]], durations: [[0, 120], [120, 0]] };
    });
    const a = await distanceMatrix([MADRID, NEAR], { fetchImpl: hop, storage: null, minIntervalMs: 0 });
    assertMatrixInvariants(a, 2, 'D6 sub-km hop');
    assert.strictEqual(a.source, 'osrm', 'a sub-kilometre leg is exempt, not rejected');
    assert.strictEqual(a.km[0][1], 0.4);
    assert.strictEqual(a.min[0][1], 2);

    const city = makeFetch(function () {
        return { code: 'Ok', distances: [[0, 3000], [3000, 0]], durations: [[0, 720], [720, 0]] };
    });
    const b = await distanceMatrix([MADRID, CITY], { fetchImpl: city, storage: null, minIntervalMs: 0 });
    assertMatrixInvariants(b, 2, 'D6 slow city leg');
    assert.strictEqual(b.source, 'osrm', '15 km/h in traffic is real road data');
    assert.strictEqual(b.km[0][1], 3);
    assert.strictEqual(b.min[0][1], 12);
});

/* ══════════════════════════════════════════════════════════════════════════
   D10: an ESTIMATE is never the reference for validating a MEASUREMENT
   ══════════════════════════════════════════════════════════════════════════ */

/* Two places 9.25 km apart as the crow flies with a 112 km / 140 min road between them
   — a x12 detour, and entirely real (a bay, a mountain, a one-way valley). */
const DETOUR_A = place('DetourA', 40.4168, -3.7038);
const DETOUR_B = place('DetourB', 40.5000, -3.7038);
const DETOUR_CROW_KM = haversineKm(40.4168, -3.7038, 40.5000, -3.7038);

test('matrix D10: a durations-only reply keeps the real duration on a high-detour leg', async function () {
    /* Reported repro. When only `durations` comes back, km is the haversine ESTIMATE,
       and the old speed check charged that estimate's error against the real duration:
       11.56 km / 140 min implied a fake 4.95 km/h, under the 5 km/h floor, so the whole
       cell reverted to an estimate. The 140-minute duration became 7.7 — 18x too small,
       with NO warning, understating drive time, which is the day-splitting bug class. */
    assert.ok(DETOUR_CROW_KM > 9 && DETOUR_CROW_KM < 9.5, 'fixture crow distance');

    /* Control: with both grids the pair validates itself and is clean road data. */
    const both = makeFetch(function () {
        return {
            code: 'Ok',
            distances: [[0, 112000], [112000, 0]],
            durations: [[0, 8400], [8400, 0]]
        };
    });
    const full = await distanceMatrix([DETOUR_A, DETOUR_B], { fetchImpl: both, storage: null, minIntervalMs: 0 });
    assertMatrixInvariants(full, 2, 'D10 control');
    assert.strictEqual(full.source, 'osrm', 'a x12 detour at 48 km/h is real road data');
    assert.strictEqual(full.km[0][1], 112);
    assert.strictEqual(full.min[0][1], 140);

    /* The same leg, durations only: the measurement must survive the missing half. */
    const durOnly = makeFetch(function () {
        return { code: 'Ok', durations: [[0, 8400], [8400, 0]] };
    });
    const half = await distanceMatrix([DETOUR_A, DETOUR_B], { fetchImpl: durOnly, storage: null, minIntervalMs: 0 });
    assertMatrixInvariants(half, 2, 'D10 durations only');
    assert.strictEqual(half.min[0][1], 140, 'the measured duration is kept, not recomputed');
    assert.strictEqual(half.source, 'mixed');
    assert.strictEqual(half.osrmCells, 2);
    assert.strictEqual(half.filledCells, 2);
});

test('matrix D10: there is no duration cliff on a durations-only reply', async function () {
    /* The old floor kept everything up to 135 min and discarded everything from 140 min
       on — a cliff produced entirely by the estimate, not by the data. The credible band
       for this pair runs to 3165 min: the longest road that could join two points 9.25 km
       apart is 142.5 km, and 48 h + 142.5/30 h = 52.75 h.
       (Round 4 asserted here that 600 min must be REJECTED, derived from the old
       minimum-speed floor. Live measurement then found Athens-Mykonos doing 176 km in
       28.9 h, so 10 hours over a road of at most 142 km is ordinary for a ferry hop and
       that assertion was wrong — in the same direction as every other gap in this file.) */
    for (const mins of [30, 60, 90, 120, 135, 138, 140, 150, 200, 300, 450, 600, 1440, 3000]) {
        const fetchImpl = makeFetch(function () {
            return { code: 'Ok', durations: [[0, mins * 60], [mins * 60, 0]] };
        });
        const m = await distanceMatrix([DETOUR_A, DETOUR_B], { fetchImpl: fetchImpl, storage: null, minIntervalMs: 0 });
        assertMatrixInvariants(m, 2, 'D10 sweep ' + mins);
        assert.strictEqual(m.min[0][1], mins, mins + ' min was discarded — the cliff is back');
        assert.strictEqual(m.source, 'mixed', mins + ' min: road data reached the matrix');
    }

    /* The outer bound still exists — the test is one-sided, not absent. */
    const absurd = makeFetch(function () { return { code: 'Ok', durations: [[0, 4000 * 60], [4000 * 60, 0]] }; });
    const m = await distanceMatrix([DETOUR_A, DETOUR_B], { fetchImpl: absurd, storage: null, minIntervalMs: 0 });
    assert.strictEqual(m.source, 'haversine',
        '66 hours to cover 9.25 km as the crow flies is beyond any credible road');
});

test('matrix D10: a durations-only reply is still rejected when NO road could produce it', async function () {
    /* The fix must not become a blanket "skip the check when one half is an estimate":
       that would let 1 second between Madrid and Barcelona through the half-response
       path. Geometry still pins the duration down from both sides — too fast even along
       the great circle, or too slow even along the detour ceiling. */
    const impossible = [
        ['1 second for 505 km', 1],
        ['12 seconds for 505 km', 12],
        ['zero seconds', 0],
        ['40 days for 505 km', 40 * 24 * 3600]
    ];
    for (const [label, seconds] of impossible) {
        const fetchImpl = makeFetch(function () {
            return { code: 'Ok', durations: [[0, seconds], [seconds, 0]] };
        });
        const m = await distanceMatrix([MADRID, BARCELONA], { fetchImpl: fetchImpl, storage: null, minIntervalMs: 0 });
        assertMatrixInvariants(m, 2, 'D10 impossible:' + label);
        assert.strictEqual(m.source, 'haversine', label + ' must not survive as road data');
        assert.strictEqual(m.osrmCells, 0, label);
        const kmh = m.km[0][1] / (m.min[0][1] / 60);
        assert.ok(kmh > 5 && kmh < 200, label + ': the replacement is drivable (' + kmh.toFixed(1) + ' km/h)');
    }

    /* ...and a long-but-credible duration on the same pair is still kept. */
    const slow = makeFetch(function () { return { code: 'Ok', durations: [[0, 36000], [36000, 0]] }; });
    const m = await distanceMatrix([MADRID, BARCELONA], { fetchImpl: slow, storage: null, minIntervalMs: 0 });
    assert.strictEqual(m.min[0][1], 600, '10 hours Madrid-Barcelona is slow but possible');
    assert.strictEqual(m.source, 'mixed');
});

/* ══════════════════════════════════════════════════════════════════════════
   D11: the detour ceiling and the length-scaled speed floor
   ══════════════════════════════════════════════════════════════════════════ */

test('matrix D11: an absurd detour is refused however well its duration matches it', async function () {
    /* Reported repro: 30 305.78 km between Madrid and Barcelona (a x60 detour on a
       505 km crow line) was accepted as clean 'osrm' with no warning, because there was
       no upper bound on distance at all — only a lower one. */
    const fetchImpl = makeFetch(function () {
        return {
            code: 'Ok',
            distances: [[0, 30305780], [30305780, 0]],
            durations: [[0, 20204 * 60], [20204 * 60, 0]]     // 30 305 km at 90 km/h
        };
    });
    const m = await distanceMatrix([MADRID, BARCELONA], { fetchImpl: fetchImpl, storage: null, minIntervalMs: 0 });
    assertMatrixInvariants(m, 2, 'D11 x60 detour');
    assert.strictEqual(m.source, 'haversine', 'a x60 detour is not a road');
    assert.strictEqual(m.osrmCells, 0);
    assert.ok(m.km[0][1] < 700, 'the honest estimate replaced it, got ' + m.km[0][1] + ' km');
});

test('matrix D11: the ceiling clears every observed real detour', async function () {
    /* Thresholds from measurement, not taste. Observed detours: x1.15-x1.36 across the
       seven Spanish calibration fixtures, ~x2 at the top of the reviewer's sweep, and
       x12.11 for the 9.25 km / 112 km leg above, which is real road data. A x5 ceiling
       was proposed and is provably too tight — 5 x 9.25 = 46 km would reject that 112 km
       road — so the ceiling is x10 + 50 km. */
    const cases = [
        ['x1.36, the calibration maximum', MADRID, BARCELONA, 505 * 1.36, 90],
        ['x2, the sweep maximum',          MADRID, BARCELONA, 505 * 2.0,  90],
        ['x4, rainforest geography',       MADRID, BARCELONA, 505 * 4.0,  90],
        ['x8, fjord geography',            MADRID, BARCELONA, 505 * 8.0,  90],
        ['x12.11 on a short leg',          DETOUR_A, DETOUR_B, 112,       48]
    ];
    for (const [label, from, to, roadKm, kmh] of cases) {
        const minutes = roadKm / kmh * 60;
        const fetchImpl = makeFetch(function () {
            return {
                code: 'Ok',
                distances: [[0, Math.round(roadKm * 1000)], [Math.round(roadKm * 1000), 0]],
                durations: [[0, Math.round(minutes * 60)], [Math.round(minutes * 60), 0]]
            };
        });
        const m = await distanceMatrix([from, to], { fetchImpl: fetchImpl, storage: null, minIntervalMs: 0 });
        assertMatrixInvariants(m, 2, 'D11 keep:' + label);
        assert.strictEqual(m.source, 'osrm', label + ' is real road data and must survive');
        assert.ok(Math.abs(m.km[0][1] - roadKm) < 1, label + ': the measured distance is kept');
    }
});

test('matrix D11: the slow side is bounded by duration, not by average speed', async function () {
    /* 6 km/h is ordinary over 2 km of city traffic and absurd sustained over 620 km, so
       the slow side is real. But average speed cannot express it — see D12 for the live
       measurements proving the real and junk distributions overlap. The bound is a
       duration ceiling instead: 48 h of scheduled-service wait plus km / 30 km/h. */
    const CITY_A = place('CityA', 40.4168, -3.7038);
    const CITY_B = place('CityB', 40.4348, -3.7038);           // ~2 km

    const urban = makeFetch(function () {
        return { code: 'Ok', distances: [[0, 2400], [2400, 0]], durations: [[0, 1440], [1440, 0]] };
    });
    const city = await distanceMatrix([CITY_A, CITY_B], { fetchImpl: urban, storage: null, minIntervalMs: 0 });
    assertMatrixInvariants(city, 2, 'D11 urban 6 km/h');
    assert.strictEqual(city.source, 'osrm', '2.4 km in 24 min is normal city traffic');
    assert.strictEqual(city.km[0][1], 2.4);
    assert.strictEqual(city.min[0][1], 24);

    const crawl = makeFetch(function () {
        return { code: 'Ok', distances: [[0, 620000], [620000, 0]], durations: [[0, 84 * 3600], [84 * 3600, 0]] };
    });
    const long = await distanceMatrix([MADRID, BARCELONA], { fetchImpl: crawl, storage: null, minIntervalMs: 0 });
    assertMatrixInvariants(long, 2, 'D11 long-haul 84 hours');
    assert.strictEqual(long.source, 'haversine',
        '84 h for 620 km exceeds the ceiling of 48 h + 620/30 h = 68.7 h');
    assert.strictEqual(long.osrmCells, 0);

    /* And the far end of the slow side stays rejected. */
    for (const hours of [100, 207, 1000]) {
        const fetchImpl = makeFetch(function () {
            return {
                code: 'Ok',
                distances: [[0, 620000], [620000, 0]],
                durations: [[0, hours * 3600], [hours * 3600, 0]]
            };
        });
        const m = await distanceMatrix([MADRID, BARCELONA], { fetchImpl: fetchImpl, storage: null, minIntervalMs: 0 });
        assert.strictEqual(m.source, 'haversine', hours + ' h for 620 km is not a road journey');
    }

    /* The ceiling must not creep down on genuinely slow long legs: 356 km of mountain
       road at 40 km/h is real, and so is 621 km at 35 km/h in holiday traffic. */
    const slowButReal = [
        [MADRID, VALENCIA, 356, 40],
        [MADRID, BARCELONA, 621, 35]
    ];
    for (const [from, to, roadKm, kmh] of slowButReal) {
        const minutes = roadKm / kmh * 60;
        const fetchImpl = makeFetch(function () {
            return {
                code: 'Ok',
                distances: [[0, roadKm * 1000], [roadKm * 1000, 0]],
                durations: [[0, Math.round(minutes * 60)], [Math.round(minutes * 60), 0]]
            };
        });
        const m = await distanceMatrix([from, to], { fetchImpl: fetchImpl, storage: null, minIntervalMs: 0 });
        assertMatrixInvariants(m, 2, 'D11 slow ' + kmh);
        assert.strictEqual(m.source, 'osrm', roadKm + ' km at ' + kmh + ' km/h is slow but real');
        assert.strictEqual(m.km[0][1], roadKm);
    }
});

/* ══════════════════════════════════════════════════════════════════════════
   D12: real ferry routes, measured live, must survive the plausibility floor
   ══════════════════════════════════════════════════════════════════════════ */

/*
 * 22 routes measured live against router.project-osrm.org over the worst geography a
 * European road trip can reach: Balearics, Aegean, Tyrrhenian, Baltic, the Norwegian
 * coast, Iceland and the Outer Hebrides. These are OSRM's own answers — not schedules,
 * not estimates — i.e. the exact numbers this provider receives in production.
 * [name, aLat, aLon, bLat, bLon, roadKm, minutes]
 */
const FERRY_ROUTES = [
    ['Barcelona-Palma',      41.3874, 2.1686,   39.5696, 2.6502,    263,  450],
    ['Valencia-Ibiza',       39.4699, -0.3763,  38.9067, 1.4206,    229,  252],
    ['Barcelona-Ibiza',      41.3874, 2.1686,   38.9067, 1.4206,    586,  486],
    ['Denia-Palma',          38.8409, 0.1077,   39.5696, 2.6502,    722,  750],
    ['Barcelona-Mahon',      41.3874, 2.1686,   39.8885, 4.2650,    262,  354],
    ['Valencia-Palma',       39.4699, -0.3763,  39.5696, 2.6502,    608,  672],
    ['Athens-Iraklio',       37.9838, 23.7275,  35.3387, 25.1442,   644, 1110],
    ['Athens-Rhodes',        37.9838, 23.7275,  36.4341, 28.2176,  1663, 1182],
    ['Athens-Santorini',     37.9838, 23.7275,  36.4167, 25.4315,   290, 2268],
    ['Athens-Mykonos',       37.9838, 23.7275,  37.4467, 25.3289,   176, 1734],
    ['Athens-Chios',         37.9838, 23.7275,  38.3680, 26.1361,  1400, 1032],
    ['Naples-Palermo',       40.8518, 14.2681,  38.1157, 13.3615,   715,  528],
    ['Genoa-Cagliari',       44.4056, 8.9463,   39.2238, 9.1217,    929, 1104],
    ['Civitavecchia-Olbia',  42.0924, 11.7963,  40.9236, 9.5000,   1100, 1200],
    ['Helsinki-Stockholm',   60.1699, 24.9384,  59.3293, 18.0686,  1762, 1356],
    ['Stockholm-Visby',      59.3293, 18.0686,  57.6348, 18.2948,   460,  450],
    ['Bodo-Svolvaer',        67.2804, 14.4049,  68.2342, 14.5683,   339,  372],
    ['Oslo-Copenhagen',      59.9139, 10.7522,  55.6761, 12.5683,   605,  438],
    ['Bergen-Stavanger',     60.3913, 5.3221,   58.9700, 5.7331,    288,  330],
    ['Reykjavik-Vestmann',   64.1466, -21.9426, 63.4427, -20.2734,  151,  162],
    ['Ullapool-Stornoway',   57.8955, -5.1590,  58.2090, -6.3890,   321,  330]
];

test('matrix D12: every live-measured ferry route survives as clean road data', async function () {
    /* Reported repro: the old 30 km/h long-haul floor cut Athens-Iraklio off at exactly
       30.0 km/h, only 16% below its live 34.8 km/h. A slower sailing turned 1290 real
       minutes into 266.8 — a 4.8x understatement of drive time, silent, which is the bug
       class this branch exists to kill. Barcelona-Palma and Valencia-Ibiza are ordinary
       requests for a Spanish trip planner, so this is not exotic input. */
    for (const [name, aLat, aLon, bLat, bLon, roadKm, minutes] of FERRY_ROUTES) {
        const fetchImpl = makeFetch(function () {
            return {
                code: 'Ok',
                distances: [[0, roadKm * 1000], [roadKm * 1000, 0]],
                durations: [[0, minutes * 60], [minutes * 60, 0]]
            };
        });
        const m = await distanceMatrix(
            [place('A', aLat, aLon), place('B', bLat, bLon)],
            { fetchImpl: fetchImpl, storage: null, minIntervalMs: 0 });
        assertMatrixInvariants(m, 2, 'D12 ' + name);
        assert.strictEqual(m.source, 'osrm',
            name + ' (' + roadKm + ' km in ' + (minutes / 60).toFixed(1) + ' h = ' +
            (roadKm / (minutes / 60)).toFixed(1) + ' km/h) is real OSRM output');
        assert.strictEqual(m.km[0][1], roadKm, name + ': measured distance kept');
        assert.strictEqual(m.min[0][1], minutes, name + ': measured duration kept');
    }
});

test('matrix D12: the same routes survive when only the durations come back', async function () {
    /* The half-response path must not reimpose a bound the pair path does not have. */
    for (const [name, aLat, aLon, bLat, bLon, roadKm, minutes] of FERRY_ROUTES) {
        const fetchImpl = makeFetch(function () {
            return { code: 'Ok', durations: [[0, minutes * 60], [minutes * 60, 0]] };
        });
        const m = await distanceMatrix(
            [place('A', aLat, aLon), place('B', bLat, bLon)],
            { fetchImpl: fetchImpl, storage: null, minIntervalMs: 0 });
        assertMatrixInvariants(m, 2, 'D12 half ' + name);
        assert.strictEqual(m.min[0][1], minutes, name + ': measured duration kept without a distance');
        assert.strictEqual(m.source, 'mixed', name + ': road data reached the matrix');
    }
});

test('matrix D12: no average-speed threshold could have separated these from junk', async function () {
    /* The measurement that killed the speed floor: the slowest REAL route is SLOWER than
       the junk the review requires to be rejected. Any floor low enough to keep
       Athens-Mykonos also keeps 620 km in 84 h; any floor high enough to reject that junk
       also rejects the ferry. This pins the overlap so nobody reintroduces a
       minimum-speed test believing a gentler asymptote can work. */
    const slowestReal = 176 / (1734 / 60);          // Athens-Mykonos, live
    const junkSpeed = 620 / 84;                     // Madrid-Barcelona in 84 hours
    assert.ok(slowestReal < junkSpeed,
        'real ' + slowestReal.toFixed(1) + ' km/h is slower than junk ' + junkSpeed.toFixed(1) +
        ' km/h — no speed threshold separates them');

    /* Both are nevertheless classified correctly, because the bound is on duration. */
    const ferry = makeFetch(function () {
        return {
            code: 'Ok',
            distances: [[0, 176000], [176000, 0]],
            durations: [[0, 1734 * 60], [1734 * 60, 0]]
        };
    });
    const real = await distanceMatrix(
        [place('Athens', 37.9838, 23.7275), place('Mykonos', 37.4467, 25.3289)],
        { fetchImpl: ferry, storage: null, minIntervalMs: 0 });
    assert.strictEqual(real.source, 'osrm', '6.1 km/h over 176 km is a real Aegean ferry');
    assert.strictEqual(real.min[0][1], 1734);

    const junk = makeFetch(function () {
        return {
            code: 'Ok',
            distances: [[0, 620000], [620000, 0]],
            durations: [[0, 84 * 3600], [84 * 3600, 0]]
        };
    });
    const bogus = await distanceMatrix([MADRID, BARCELONA], { fetchImpl: junk, storage: null, minIntervalMs: 0 });
    assert.strictEqual(bogus.source, 'haversine', '7.4 km/h over 620 km is not a road journey');
});

test('matrix D12: the 22nd measured route is correctly refused — OSRM answered elsewhere', async function () {
    /* Algeciras -> Ceuta was the one measured pair that must NOT be trusted, and it is
       the evidence behind the whole-cell rule in D6. Live: the crow line is 30 km across
       the Strait of Gibraltar, OSRM answered 12 km / 18 min, and /route reveals why —
       waypoint 1 snapped 22 489 m away, onto the Spanish coast at 36.07N, nowhere near
       Ceuta at 35.89N. Both numbers describe that other journey. */
    const fetchImpl = makeFetch(function () {
        return {
            code: 'Ok',
            distances: [[0, 11800], [11800, 0]],
            durations: [[0, 942], [942, 0]]
        };
    });
    const m = await distanceMatrix(
        [place('Algeciras', 36.1408, -5.4526), place('Ceuta', 35.8894, -5.3213)],
        { fetchImpl: fetchImpl, storage: null, minIntervalMs: 0 });
    assertMatrixInvariants(m, 2, 'D12 Algeciras-Ceuta');
    assert.strictEqual(m.source, 'haversine', 'a 12 km road under a 30 km crow line is somewhere else');
    assert.strictEqual(m.osrmCells, 0, 'the duration goes with the distance');
    assert.notStrictEqual(m.min[0][1], 15.7, 'the mis-snapped duration never reaches the matrix');
    assert.ok(m.km[0][1] > 30, 'the estimate at least describes the requested pair, got ' + m.km[0][1]);
});

test('matrix D12: the x10 detour ceiling still clears every measured route', async function () {
    /* Live measurement found a worse real detour than the review did: Athens-Chios is
       215 km as the crow flies and 1400 km by road, x6.51 — not the x4.45 of
       Helsinki-Stockholm. The x10 + 50 km ceiling still holds, but the true headroom is
       x1.57, not x2.2, so this test records where the real edge is. */
    let worstRatio = 0, worstName = '';
    for (const [name, aLat, aLon, bLat, bLon, roadKm] of FERRY_ROUTES) {
        const crow = haversineKm(aLat, aLon, bLat, bLon);
        const ratio = roadKm / crow;
        if (ratio > worstRatio) { worstRatio = ratio; worstName = name; }
        assert.ok(roadKm <= crow * 10 + 50,
            name + ' detour x' + ratio.toFixed(2) + ' must clear the ceiling');
    }
    assert.ok(worstRatio > 6 && worstRatio < 7,
        'worst measured detour is ' + worstName + ' at x' + worstRatio.toFixed(2));
});

/* ══════════════════════════════════════════════════════════════════════════
   D7: ALL THREE network entry points share the serial queue and the rate limit
   ══════════════════════════════════════════════════════════════════════════ */

test('matrix D7: distanceMatrix and routeGeometry are throttled, not just geocoding', async function () {
    /* Reported repro: 4 concurrent distanceMatrix calls fired 4 OSRM requests at 0 ms
       offsets, maxInFlight 4, whole span 36 ms — against a public demo server, while the
       file header claimed "one in flight". Only geocoding went through the queue. */
    resetGeoRateLimit();
    const clock = makeClock(7000000);
    const starts = [];
    const fetchImpl = makeFetch(function (url) {
        starts.push(clock.now());
        clock.advance(10);
        if (url.indexOf('/route/v1/') !== -1) {
            return { code: 'Ok', routes: [{ geometry: '_p~iF~ps|U_ulLnnqC_mqNvxq`@' }] };
        }
        if (url.indexOf('/table/v1/') !== -1) {
            return { code: 'Ok', distances: [[0, 620000], [620000, 0]], durations: [[0, 21600], [21600, 0]] };
        }
        return nominatimHit(40, -3, 'x');
    });
    const opts = { fetchImpl: fetchImpl, storage: null, now: clock.now, sleepImpl: clock.sleep };

    await Promise.all([
        distanceMatrix([MADRID, BARCELONA], opts),
        distanceMatrix([MADRID, VALENCIA], opts),
        routeGeometry([MADRID, BARCELONA], opts),
        routeGeometry([BARCELONA, VALENCIA], opts),
        geocodePlaces(['Somewhere'], opts)
    ]);

    assert.strictEqual(fetchImpl.calls.length, 5, 'every call really hit the network stub');
    assert.strictEqual(fetchImpl.maxInFlight, 1, 'never more than one request in flight');
    assert.strictEqual(starts.length, 5);
    for (let i = 1; i < starts.length; i++) {
        assert.ok(starts[i] - starts[i - 1] >= 1100,
            'request ' + i + ' left ' + (starts[i] - starts[i - 1]) + 'ms after the previous (policy: 1100)');
    }
    /* And the queue is genuinely shared: geocoding, table and route interleave in it. */
    const kinds = fetchImpl.calls.map(function (u) {
        return u.indexOf('/table/') !== -1 ? 'table' : (u.indexOf('/route/') !== -1 ? 'route' : 'geo');
    });
    assert.strictEqual(kinds.filter(function (k) { return k === 'table'; }).length, 2);
    assert.strictEqual(kinds.filter(function (k) { return k === 'route'; }).length, 2);
    assert.strictEqual(kinds.filter(function (k) { return k === 'geo'; }).length, 1);
});

/* ══════════════════════════════════════════════════════════════════════════
   D8: a fetch that ignores AbortSignal must not deadlock the global queue
   ══════════════════════════════════════════════════════════════════════════ */

test('matrix D8: a never-settling fetch releases on the deadline and does not wedge the queue', async function () {
    /* Reported repro: AbortController is a request, not a guarantee. A fetch polyfill
       that ignores `signal` left the awaiting task unsettled forever; timeoutMs released
       nothing and the only escape was a page reload. The WAIT itself is now guarded. */
    resetGeoRateLimit();
    let sawAbort = false;
    const hung = function (url, init) {
        if (init && init.signal && typeof init.signal.addEventListener === 'function') {
            init.signal.addEventListener('abort', function () { sawAbort = true; });
        }
        return new Promise(function () { /* never settles, and ignores the signal */ });
    };
    const good = makeFetch(function () {
        return { code: 'Ok', distances: [[0, 620000], [620000, 0]], durations: [[0, 21600], [21600, 0]] };
    });

    const t0 = Date.now();
    const stuck = await distanceMatrix([MADRID, BARCELONA],
        { fetchImpl: hung, storage: null, timeoutMs: 40, minIntervalMs: 0 });
    assertMatrixInvariants(stuck, 2, 'D8 hung');
    assert.strictEqual(stuck.source, 'haversine', 'the deadline released the call and it fell back');

    /* The next request must still work — that is the deadlock the reload used to fix. */
    const after = await distanceMatrix([MADRID, BARCELONA],
        { fetchImpl: good, storage: null, timeoutMs: 40, minIntervalMs: 0 });
    assert.strictEqual(after.source, 'osrm', 'the queue advanced past the hung request');

    /* Geocoding shares the same queue, so it must be unblocked too. */
    const geoGood = makeFetch(function () { return nominatimHit(41.9, 12.5, 'Roma'); });
    const places = await geocodePlaces(['Roma'],
        { fetchImpl: geoGood, storage: null, timeoutMs: 40, minIntervalMs: 0 });
    assert.strictEqual(places[0].resolved, true, 'geocoding is not blocked either');

    assert.ok(Date.now() - t0 < 3000, 'the whole sequence finished promptly, not never');
    assert.ok(sawAbort, 'the abort was still signalled — the deadline is belt AND braces');
});

/* ══════════════════════════════════════════════════════════════════════════
   D9: the rate-limit seam must not be usable from the browser
   ══════════════════════════════════════════════════════════════════════════ */

test('D9: resetGeoRateLimit is not published on the browser surface', function () {
    const loaded = loadInFakeBrowser(1);
    assert.strictEqual(typeof loaded.win.resetGeoRateLimit, 'undefined', 'not a direct window global');
    assert.strictEqual(typeof loaded.win.TravioGeo.resetGeoRateLimit, 'undefined',
        'not reachable through the namespace object either');
    assert.strictEqual(Object.keys(loaded.win).indexOf('resetGeoRateLimit'), -1);
    /* The Node suite still has it — it is a test seam, and this file depends on it. */
    assert.strictEqual(typeof resetGeoRateLimit, 'function', 'still exported for Node');
    assert.strictEqual(resetGeoRateLimit(), true, 'and it still works where there is no window');
});

test('D9: a captured reference to the seam is inert while a window exists', async function () {
    /* Reported repro: calling it mid-flight dropped the spacing between two Nominatim
       requests to 33 ms. Load the file into a context that has BOTH `window` and
       `module`, so the seam escapes through module.exports, and prove it cannot bite. */
    const fs = require('node:fs');
    const vm = require('node:vm');
    const src = fs.readFileSync(PROVIDER_PATH, 'utf8');
    const mod = { exports: {} };
    const ctx = vm.createContext({
        window: {}, module: mod, setTimeout: setTimeout, clearTimeout: clearTimeout
    });
    vm.runInContext(src, ctx, { filename: 'geo-provider.js' });

    const seam = mod.exports.resetGeoRateLimit;
    assert.strictEqual(typeof seam, 'function', 'the seam did escape through module.exports');
    assert.strictEqual(seam(), false, 'but it reports that it did nothing');

    const clock = makeClock(9000000);
    const starts = [];
    const fetchImpl = makeFetch(function () {
        starts.push(clock.now());
        seam();                                  // hostile: try to reset mid-flight
        clock.advance(5);
        return nominatimHit(10, 20, 'x');
    });
    await mod.exports.geocodePlaces(['A', 'B', 'C'], {
        fetchImpl: fetchImpl, storage: null, now: clock.now, sleepImpl: clock.sleep
    });

    assert.strictEqual(fetchImpl.calls.length, 3);
    assert.strictEqual(fetchImpl.maxInFlight, 1, 'still one in flight');
    for (let i = 1; i < starts.length; i++) {
        assert.ok(starts[i] - starts[i - 1] >= 1100,
            'spacing held at ' + (starts[i] - starts[i - 1]) + 'ms despite the reset attempts');
    }
});

/* ══════════════════════════════════════════════════════════════════════════
   Utilities
   ══════════════════════════════════════════════════════════════════════════ */

test('utils: haversineKm is sane and safe', function () {
    const madBcn = haversineKm(40.4168, -3.7038, 41.3874, 2.1686);
    assert.ok(madBcn > 495 && madBcn < 515, 'Madrid-Barcelona ~505 km, got ' + madBcn);
    assert.strictEqual(haversineKm(10, 10, 10, 10), 0);
    assert.strictEqual(haversineKm(null, 1, 2, 3), 0, 'invalid input degrades to 0, never NaN');
    assert.ok(Number.isFinite(haversineKm('a', 'b', 'c', 'd')));
});

test('utils: normalisePlaceName strips case, accents and extra spacing', function () {
    assert.strictEqual(normalisePlaceName('  Málaga   Centro '), 'malaga centro');
    assert.strictEqual(normalisePlaceName('MÁLAGA centro'), 'malaga centro');
    assert.strictEqual(normalisePlaceName(null), '');
    assert.strictEqual(normalisePlaceName(undefined), '');
});

test('utils: clearGeoCache removes only Travio keys and tolerates no storage', function () {
    const seed = {};
    seed[cacheKeyFor('Madrid')] = JSON.stringify({ lat: 1, lon: 1, ts: Date.now() });
    seed['unrelated.key'] = 'keep me';
    const storage = makeStorage(seed);
    const removed = clearGeoCache({ storage: storage });
    assert.strictEqual(removed, 1);
    assert.strictEqual(storage._data.has('unrelated.key'), true);
    assert.strictEqual(storage._data.has(cacheKeyFor('Madrid')), false);
    assert.strictEqual(clearGeoCache({ storage: null }), 0);
});
