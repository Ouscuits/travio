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
    /* limit=1 made ambiguity invisible: the module could not report that 'Leon' has five
       candidates because it never asked for them. Same request, same rate limit. */
    assert.ok(fetchImpl.calls[0].indexOf('limit=5') !== -1, 'asks for several candidates');
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

/* Encoder for building geographically coherent fixtures. The canonical Google polyline
   describes a line in California; feeding it to a Madrid->Barcelona request was exactly
   the "geometry about somewhere else" case D17 now rejects, so integration fixtures have
   to encode the route actually being asked for. decodePolyline keeps the canonical
   fixture in its own unit test above, where no geography is involved. */
function encodePolyline(points, precision) {
    const factor = Math.pow(10, typeof precision === 'number' ? precision : 5);
    const chunk = function (v) {
        v = v < 0 ? ~(v << 1) : (v << 1);
        let s = '';
        while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
        return s + String.fromCharCode(v + 63);
    };
    let out = '', prevLat = 0, prevLon = 0;
    for (const p of points) {
        const lat = Math.round(p[0] * factor), lon = Math.round(p[1] * factor);
        out += chunk(lat - prevLat) + chunk(lon - prevLon);
        prevLat = lat; prevLon = lon;
    }
    return out;
}

/* A plausible Madrid -> Barcelona line, used by the geometry tests below. */
const MAD_BCN_LINE = [[40.4168, -3.7038], [41.0, -1.5], [41.6488, -0.8891], [41.3874, 2.1686]];

test('geometry: the test encoder round-trips through decodePolyline', function () {
    const decoded = decodePolyline(encodePolyline(MAD_BCN_LINE, 5), 5);
    assert.strictEqual(decoded.length, MAD_BCN_LINE.length);
    decoded.forEach(function (p, i) {
        assert.ok(Math.abs(p[0] - MAD_BCN_LINE[i][0]) < 1e-5, 'lat ' + i);
        assert.ok(Math.abs(p[1] - MAD_BCN_LINE[i][1]) < 1e-5, 'lon ' + i);
    });
});

test('geometry: OSRM route polyline is decoded', async function () {
    const fetchImpl = makeFetch(function (url) {
        assert.ok(url.indexOf('/route/v1/driving/') !== -1);
        assert.ok(url.indexOf('overview=full') !== -1);
        assert.ok(url.indexOf('geometries=polyline') !== -1);
        return { code: 'Ok', routes: [{ geometry: encodePolyline(MAD_BCN_LINE, 5) }] };
    });
    const pts = await routeGeometry([MADRID, BARCELONA], { fetchImpl: fetchImpl, storage: null, minIntervalMs: 0 });
    assert.strictEqual(pts.length, 4);
    assert.ok(Math.abs(pts[0][0] - 40.4168) < 1e-5 && Math.abs(pts[0][1] - (-3.7038)) < 1e-5);
    assert.ok(Math.abs(pts[3][0] - 41.3874) < 1e-5 && Math.abs(pts[3][1] - 2.1686) < 1e-5);
    assert.strictEqual(pts.source, 'osrm');
});

test('geometry: a geojson route is decoded and validated the same way', async function () {
    const fetchImpl = makeFetch(function () {
        return {
            code: 'Ok',
            routes: [{ geometry: { coordinates: MAD_BCN_LINE.map(function (p) { return [p[1], p[0]]; }) } }]
        };
    });
    const pts = await routeGeometry([MADRID, BARCELONA], { fetchImpl: fetchImpl, storage: null, minIntervalMs: 0 });
    assert.strictEqual(pts.source, 'osrm');
    assert.strictEqual(pts.length, 4);
    assert.deepStrictEqual(pts[0], [40.4168, -3.7038]);

    /* ...and a geojson line about somewhere else is refused, like the polyline one. */
    const elsewhere = makeFetch(function () {
        return { code: 'Ok', routes: [{ geometry: { coordinates: [[-120.2, 38.5], [-120.95, 40.7]] } }] };
    });
    const bad = await routeGeometry([MADRID, BARCELONA], { fetchImpl: elsewhere, storage: null, minIntervalMs: 0 });
    assert.strictEqual(bad.source, 'straight', 'a California line is not a Madrid-Barcelona route');
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

/* ══════════════════════════════════════════════════════════════════════════
   D17: the geometry path gets the guards the matrix path spent nine rounds getting
   ══════════════════════════════════════════════════════════════════════════ */

test('geometry D17: a mis-snapped waypoint cannot produce measured geometry', async function () {
    /* Reported repro: the SAME Melilla waypoint, two paths in one module.
       distanceMatrix condemned the cell on sources[].distance = 155 760 m, while
       routeGeometry never read waypoints[].distance and returned source 'osrm' — a
       polyline starting near Almeria, tagged as real road geometry. The map builder's
       provenance flag would have been wired to that. */
    const MELILLA = place('Melilla', 35.2923, -2.9381);
    const line = encodePolyline([[36.84, -2.45], [38.5, -3.0], [40.4168, -3.7038]], 5);

    const misSnapped = makeFetch(function () {
        return {
            code: 'Ok',
            waypoints: [{ distance: 155760 }, { distance: 90 }],
            routes: [{ geometry: line }]
        };
    });
    const g = await routeGeometry([MELILLA, MADRID], { fetchImpl: misSnapped, storage: null, minIntervalMs: 0 });
    assert.strictEqual(g.source, 'straight', 'a 155.76 km snap is a route through somewhere else');
    assert.deepStrictEqual(g, [[35.2923, -2.9381], [40.4168, -3.7038]],
        'it falls back to the requested places, not the polyline');

    /* The two paths in this module must now agree about the same waypoint. */
    const m = await distanceMatrix([MELILLA, MADRID], {
        fetchImpl: makeFetch(function () {
            return {
                code: 'Ok',
                distances: [[0, 556000], [556000, 0]],
                durations: [[0, 23100], [23100, 0]],
                sources: [{ distance: 155760 }, { distance: 90 }],
                destinations: [{ distance: 155760 }, { distance: 90 }]
            };
        }), storage: null, minIntervalMs: 0
    });
    assert.strictEqual(m.source, 'haversine');
    assert.ok(m.source !== 'osrm' && g.source !== 'osrm',
        'neither path may claim road provenance for a waypoint answered about elsewhere');

    /* The threshold is shared: a legitimately remote place still yields real geometry. */
    const remote = makeFetch(function () {
        return {
            code: 'Ok',
            waypoints: [{ distance: 4440 }, { distance: 80 }],      // Mont Blanc summit
            routes: [{ geometry: encodePolyline(MAD_BCN_LINE, 5) }]
        };
    });
    const ok = await routeGeometry([MADRID, BARCELONA], { fetchImpl: remote, storage: null, minIntervalMs: 0 });
    assert.strictEqual(ok.source, 'osrm', 'a 4.44 km snap is still the honest answer');
});

test('geometry D17: a garbage or degenerate decode is not measured geometry', async function () {
    /* Reported repro: '????????????????' decodes to eight copies of [0,0] and shipped as
       source 'osrm' — a map line through Null Island, labelled measured. `length >= 2`
       was the only test it had to pass. */
    const cases = [
        ['null island', '????????????????'],
        ['long garbage', '~~~~~~~~~~~~~~~~'],
        ['a line in California', '_p~iF~ps|U_ulLnnqC_mqNvxq`@']
    ];
    for (const [label, geometry] of cases) {
        const fetchImpl = makeFetch(function () { return { code: 'Ok', routes: [{ geometry: geometry }] }; });
        const g = await routeGeometry([MADRID, BARCELONA], { fetchImpl: fetchImpl, storage: null, minIntervalMs: 0 });
        assert.strictEqual(g.source, 'straight', label + ' must not claim to be measured');
        assert.deepStrictEqual(g, [[40.4168, -3.7038], [41.3874, 2.1686]], label + ': honest fallback');
    }

    /* Out-of-range points are refused even when the endpoints would match. */
    const outOfRange = makeFetch(function () {
        return {
            code: 'Ok',
            routes: [{ geometry: { coordinates: [[-3.7038, 40.4168], [999, 500], [2.1686, 41.3874]] } }]
        };
    });
    const g = await routeGeometry([MADRID, BARCELONA], { fetchImpl: outOfRange, storage: null, minIntervalMs: 0 });
    assert.strictEqual(g.source, 'straight', 'a point off the planet invalidates the line');
});

test('geometry D17: missing waypoint data condemns nothing', async function () {
    /* Same rule as the matrix path: never condemn on absent evidence, because a proxy or
       an older OSRM may not report the field. */
    const noWaypoints = makeFetch(function () {
        return { code: 'Ok', routes: [{ geometry: encodePolyline(MAD_BCN_LINE, 5) }] };
    });
    const a = await routeGeometry([MADRID, BARCELONA], { fetchImpl: noWaypoints, storage: null, minIntervalMs: 0 });
    assert.strictEqual(a.source, 'osrm', 'absent waypoints[] is not evidence of anything');

    for (const junk of [null, undefined, 'x', {}, [], true, NaN, -5, Infinity]) {
        const fetchImpl = makeFetch(function () {
            return {
                code: 'Ok',
                waypoints: [{ distance: junk }, { distance: junk }],
                routes: [{ geometry: encodePolyline(MAD_BCN_LINE, 5) }]
            };
        });
        const g = await routeGeometry([MADRID, BARCELONA], { fetchImpl: fetchImpl, storage: null, minIntervalMs: 0 });
        assert.strictEqual(g.source, 'osrm', String(junk) + ' in waypoints[].distance proves nothing');
    }
});

test('geometry D17: real measured geometry is not newly rejected', async function () {
    /* Live-measured offsets between the first/last polyline point and the requested
       coordinate: 0.09, 0.00, 0.01, 0.18, 0.06, 4.43 (Mont Blanc), 2.47 (Preikestolen).
       All must survive the maxSnapKm + 1 km tolerance. */
    const offsets = [0.0, 0.01, 0.09, 0.18, 1.35, 2.47, 4.43];
    for (const offsetKm of offsets) {
        const dLat = offsetKm / 111.195;
        const line = [[40.4168 + dLat, -3.7038], [41.0, -1.5], [41.3874, 2.1686]];
        const fetchImpl = makeFetch(function () {
            return {
                code: 'Ok',
                waypoints: [{ distance: offsetKm * 1000 }, { distance: 20 }],
                routes: [{ geometry: encodePolyline(line, 5) }]
            };
        });
        const g = await routeGeometry([MADRID, BARCELONA], { fetchImpl: fetchImpl, storage: null, minIntervalMs: 0 });
        assert.strictEqual(g.source, 'osrm',
            'a geometry starting ' + offsetKm + ' km from the request is real and must survive');
        assert.strictEqual(g.length, 3);
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
    'TravioGeo', 'geocodePlaces', 'geocodeOutliers', 'distanceMatrix', 'routeGeometry',
    'decodePolyline', 'haversineKm', 'normalisePlaceName', 'clearGeoCache'
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

    /* A distance refused by the DETOUR CEILING condemns the cell too, for the same
       reason: one path computation produced both halves. Round 5 kept the duration here,
       which left an asymmetry — a x60 detour was refused while a 202-hour duration beside
       it was trusted, and 30305/202 = 150 km/h shows that duration is CORROBORATING the
       absurd path, not contradicting it. Only an ABSENT distance leaves the duration to
       stand alone (D10). */
    const corroborating = makeFetch(function () {
        return {
            code: 'Ok',
            distances: [[0, 30305780], [30305780, 0]],        // x60 detour, refused
            durations: [[0, 202 * 3600], [202 * 3600, 0]]     // 202 h at 150 km/h along it
        };
    });
    const far = await distanceMatrix([MADRID, BARCELONA], { fetchImpl: corroborating, storage: null, minIntervalMs: 0 });
    assertMatrixInvariants(far, 2, 'D6 over-ceiling');
    assert.ok(Math.abs(far.km[0][1] - MAD_BCN_HAV_KM) < 0.02, 'the x60 distance was refused');
    assert.strictEqual(far.source, 'haversine', 'the duration timed the same absurd path');
    assert.strictEqual(far.osrmCells, 0);
    assert.ok(far.min[0][1] < 600, '202 hours never reaches the matrix, got ' + far.min[0][1]);

    /* Incoherent halves are refused whole as well: 6000 km in 360 min is 1000 km/h. */
    const incoherent = makeFetch(function () {
        return {
            code: 'Ok',
            distances: [[0, 6000000], [6000000, 0]],
            durations: [[0, 21600], [21600, 0]]
        };
    });
    const bad = await distanceMatrix([MADRID, BARCELONA], { fetchImpl: incoherent, storage: null, minIntervalMs: 0 });
    assertMatrixInvariants(bad, 2, 'D6 incoherent');
    assert.strictEqual(bad.source, 'haversine');
    assert.strictEqual(bad.osrmCells, 0);
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
       for this pair runs to 470 min: the longest road that could join two points 9.25 km
       apart is 142.5 km, and the stoppage allowance a 9.25 km crow line earns is
       min(48 h, 9.25/3 h) = 3.08 h, so 3.08 + 142.5/30 = 7.83 h.
       (Round 5 swept up to 3000 min here, because the 48 h allowance was then granted
       unconditionally. That was the round-6 bug showing through a test: no scheduled
       crossing is plausible over 9.25 km, so a 50-hour leg is not credible and the sweep
       had no business asserting it.) */
    for (const mins of [30, 60, 90, 120, 135, 138, 140, 150, 200, 300, 450]) {
        const fetchImpl = makeFetch(function () {
            return { code: 'Ok', durations: [[0, mins * 60], [mins * 60, 0]] };
        });
        const m = await distanceMatrix([DETOUR_A, DETOUR_B], { fetchImpl: fetchImpl, storage: null, minIntervalMs: 0 });
        assertMatrixInvariants(m, 2, 'D10 sweep ' + mins);
        assert.strictEqual(m.min[0][1], mins, mins + ' min was discarded — the cliff is back');
        assert.strictEqual(m.source, 'mixed', mins + ' min: road data reached the matrix');
    }

    /* The outer bound still exists — the test is one-sided, not absent. It is DERIVED,
       not independent: with no distance in the reply the road is bounded by the detour
       ceiling, so this boundary moves whenever that ceiling does. It has moved three
       times (3165 min under the flat allowance, 470 once the allowance was scaled, 840
       now that the ceiling is 30x). Each move is a consequence of a bound elsewhere, not
       a new judgement about this pair — which is why only clearly-absurd values are
       asserted here rather than a value near the edge. */
    for (const mins of [1440, 4000, 20000]) {
        const absurd = makeFetch(function () { return { code: 'Ok', durations: [[0, mins * 60], [mins * 60, 0]] }; });
        const m = await distanceMatrix([DETOUR_A, DETOUR_B], { fetchImpl: absurd, storage: null, minIntervalMs: 0 });
        assert.strictEqual(m.source, 'haversine',
            (mins / 60).toFixed(1) + ' h to cover 9.25 km as the crow flies is beyond any credible road');
    }
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
    ['Ullapool-Stornoway',   57.8955, -5.1590,  58.2090, -6.3890,   321,  330],
    /* Round 6: the short-crow crossings that stress a crow-scaled allowance, plus the
       two routes the reviewer cited, measured here rather than taken on trust. */
    ['Messina-VillaSGiov',   38.1938, 15.5540,  38.2200, 15.6360,    10,   48],
    ['Portsmouth-Ryde',      50.8198, -1.0880,  50.7290, -1.1600,    21,   60],
    ['Split-Supetar',        43.5081, 16.4402,  43.3833, 16.5500,    19,   66],
    ['Oban-Craignure',       56.4152, -5.4714,  56.4700, -5.7080,   120,  132],
    ['SantaTeresa-Bonifacio', 41.2400, 9.1900,  41.3874, 9.1600,     20,   66],
    ['Ibiza-Formentera',     38.9067, 1.4206,   38.7333, 1.4167,     25,   36],
    ['Piombino-Portoferraio', 42.9236, 10.5247, 42.8135, 10.3167,    45,   60],
    ['Naples-Ischia',        40.8518, 14.2681,  40.7314, 13.9503,    51,  282],
    ['Naples-Capri',         40.8518, 14.2681,  40.5532, 14.2222,    66,   84],
    ['Piraeus-Aegina',       37.9420, 23.6465,  37.7470, 23.4280,    34,   72],
    ['Dover-Calais',         51.1279, 1.3134,   50.9513, 1.8587,     87,   66],
    ['Helsinki-Tallinn',     60.1699, 24.9384,  59.4370, 24.7536,    87,  132],
    ['Palermo-Lampedusa',    38.1157, 13.3615,  35.4999, 12.6068,   355, 2814],
    ['Cagliari-Palermo',     39.2238, 9.1217,   38.1157, 13.3615,  2323, 2028],
    /* Round 7: NARROW slow crossings. The fixture had none — 14 short hops had been
       measured but all across wide water — and the crow-scaled allowance was therefore
       fitted to a hole in the data. Fjord and estuary ferries are the missing class. */
    ['Lavik-Oppedal',        61.1030, 5.5330,   61.0770, 5.5220,   9.08, 73.2],
    ['Oanes-Lauvvik',        58.9200, 6.0300,   58.9250, 6.0100,     12, 80.4],
    ['Woolwich-Ferry',       51.4990, 0.0680,   51.4960, 0.0690,   2.67, 16.2],
    ['Helsingor-Helsingborg', 56.0320, 12.6150, 56.0450, 12.6930,  8.37,   66],
    ['Hella-Dragsvik',       61.2050, 6.5940,   61.2350, 6.5560,   4.76,   13],
    ['Vangsnes-Hella',       61.1750, 6.6350,   61.2050, 6.5940,   4.74, 20.1],
    ['Anda-Lote',            61.8830, 6.1200,   61.8930, 6.1180,    0.6,  1.4],
    ['Halhjem-Sandvikvag',   60.1430, 5.4230,   59.9330, 5.4930,  101.87, 126.4],
    ['Corran-Ardgour',       56.7245, -5.2360,  56.7260, -5.2450,   1.3,    6],
    ['Cromarty-Nigg',        57.6810, -4.0370,  57.7000, -4.0230,  2.77, 18.8],
    ['Sandbanks-Studland',   50.6845, -1.9450,  50.6790, -1.9500,  0.79,  4.7],
    ['KingHarry-Fal',        50.2205, -5.0290,  50.2210, -5.0240,  0.09,  0.2],
    ['Dartmouth-Kingswear',  50.3510, -3.5800,  50.3505, -3.5720,  1.38,  6.6],
    ['Torpoint-Devonport',   50.3745, -4.1940,  50.3720, -4.1830,  2.19, 11.5],
    /* Round 8: ENCLOSED SEAS — the exact complement of round 7's hole. Here the crossing
       is short but OSRM declines the ferry and drives around the whole sea, so the
       highest detour ratios occur at LONG crow lines, not short ones. The Baltic and the
       Adriatic were absent from the fixture as crossings entirely, which is why a x10
       ceiling looked safe while destroying three of these. */
    ['Gedser-Rostock',       54.5740, 11.9260,  54.1780, 12.0930,   629,  426],
    ['Brindisi-Igoumenitsa', 40.6420, 17.9460,  39.5040, 20.2650,  2601, 1626],
    ['Hirtshals-Kristiansand', 57.5880, 9.9600, 58.1460, 7.9950,   1375,  972],
    ['Naantali-Kapellskar',  60.4680, 22.0250,  59.7200, 19.0700,  1805, 1434],
    ['Bari-Durres',          41.1280, 16.8670,  41.3230, 19.4560,  1914, 1404],
    ['Frederikshavn-Goteborg', 57.4410, 10.5360, 57.7089, 11.9746,  785,  510],
    ['Trelleborg-Sassnitz',  55.3720, 13.1570,  54.5150, 13.6430,   788,  498],
    ['Umea-Vaasa',           63.8258, 20.2630,  63.0960, 21.6160,   838,  672],
    ['Stockholm-Tallinn',    59.3293, 18.0686,  59.4370, 24.7536,  2930, 1968],
    ['Turku-Stockholm',      60.4518, 22.2666,  59.3293, 18.0686,  1773, 1398],
    ['Piombino-Bastia',      42.9236, 10.5247,  42.7000, 9.4500,    694,  768],
    ['Klaipeda-Karlshamn',   55.7030, 21.1440,  56.1700, 14.8600,  2101, 1278],
    ['Ystad-Swinoujscie',    55.4290, 13.8200,  53.9100, 14.2470,   833,  546],
    ['Ancona-Split',         43.6160, 13.5190,  43.5081, 16.4402,   992,  654],
    ['Livorno-GolfoAranci',  43.5480, 10.3100,  40.9950, 9.6150,    869, 1032],
    ['Rodby-Puttgarden',     54.6540, 11.3560,  54.5050, 11.2280,    24,   60],
    ['Ystad-Ronne',          55.4290, 13.8200,  55.1000, 14.7000,     76,  90],
    ['Kiel-Goteborg',        54.3233, 10.1394,  57.7089, 11.9746,   708,  468]
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

/* ══════════════════════════════════════════════════════════════════════════
   D16: wrong-pair answers are detected from OSRM's own snap distance
   ══════════════════════════════════════════════════════════════════════════ */

function tableWithSnap(roadKm, minutes, snapAkm, snapBkm) {
    return makeFetch(function () {
        return {
            code: 'Ok',
            distances: [[0, roadKm * 1000], [roadKm * 1000, 0]],
            durations: [[0, minutes * 60], [minutes * 60, 0]],
            sources: [{ distance: snapAkm * 1000 }, { distance: snapBkm * 1000 }],
            destinations: [{ distance: snapAkm * 1000 }, { distance: snapBkm * 1000 }]
        };
    });
}

test('matrix D16: a far-snapped waypoint condemns every cell that touches it', async function () {
    /* Reported repro: Melilla is a Spanish exclave in North Africa. OSRM cannot reach it
       by road, snaps it 155.8 km ACROSS THE MEDITERRANEAN and answers about Almeria ->
       Madrid. The resulting 556 km against a 574 km great circle is x0.97, which sails
       through the shortfall guard, so it shipped as source 'osrm' with no warning — the
       user is told 6h25 for a journey that is a ~7 h ferry plus that drive.
       The signal was in the response all along: sources[].distance. */
    const cases = [
        /* label, aLat,aLon, bLat,bLon, roadKm, min, snapA, snapB, ratio-vs-crow */
        ['Melilla-Madrid',    35.2923, -2.9381, 40.4168, -3.7038, 556, 385, 155.76, 0.09],
        ['Ceuta-Madrid',      35.8894, -5.3213, 40.4168, -3.7038, 672, 470,  22.49, 0.09],
        ['Algeciras-Ceuta',   36.1408, -5.4526, 35.8894, -5.3213,  12,  18,   0.03, 22.49],
        ['Gibraltar-Tanger',  36.1408, -5.3536, 35.7595, -5.8340,  49,  45,   0.02, 33.99],
        ['Trapani-Tunis',     38.0176, 12.5365, 36.8065, 10.1815, 162, 120,   0.00, 155.73]
    ];
    for (const [label, aLat, aLon, bLat, bLon, roadKm, minutes, snapA, snapB] of cases) {
        const fetchImpl = tableWithSnap(roadKm, minutes, snapA, snapB);
        const m = await distanceMatrix([place('A', aLat, aLon), place('B', bLat, bLon)],
            { fetchImpl: fetchImpl, storage: null, minIntervalMs: 0 });
        assertMatrixInvariants(m, 2, 'D16 ' + label);
        assert.strictEqual(m.source, 'haversine',
            label + ' snapped ' + Math.max(snapA, snapB).toFixed(1) + ' km — a different place');
        assert.strictEqual(m.osrmCells, 0, label);
        assert.notStrictEqual(m.min[0][1], minutes, label + ': the wrong duration is not shipped');
    }

    /* Two of those clear the shortfall ratio outright, which is why the proxy failed.
       Note Ceuta appears in both directions: the SAME mis-snapped waypoint was caught
       one way (x0.39) and missed the other (x1.29). */
    const crowMelilla = haversineKm(35.2923, -2.9381, 40.4168, -3.7038);
    assert.ok(556 >= crowMelilla * 0.90, 'Melilla clears the shortfall guard (x' +
        (556 / crowMelilla).toFixed(2) + ') — only the snap distance catches it');
});

test('matrix D16: a legitimately remote place is NOT condemned', async function () {
    /* The threshold has to keep real answers. Measured legitimate snaps: ordinary town
       geocodes <= 0.5 km over 60+ routes, remote fjord quays 1.35 km, Ben Nevis summit
       2.16, Preikestolen 2.48, Mont Blanc summit 4.44 — where driving to the vicinity is
       genuinely the right answer for a road trip. */
    const keep = [
        ['Mont Blanc summit', 4.44],
        ['Preikestolen', 2.48],
        ['Ben Nevis', 2.16],
        ['remote fjord quay', 1.35],
        ['ordinary town', 0.09]
    ];
    for (const [label, snapKm] of keep) {
        const fetchImpl = tableWithSnap(617, 375, snapKm, 0.02);
        const m = await distanceMatrix([MADRID, BARCELONA],
            { fetchImpl: fetchImpl, storage: null, minIntervalMs: 0 });
        assertMatrixInvariants(m, 2, 'D16 keep ' + label);
        assert.strictEqual(m.source, 'osrm', label + ' (snap ' + snapKm + ' km) must survive');
        assert.strictEqual(m.km[0][1], 617);
    }
});

test('matrix D16: missing snap fields condemn nothing', async function () {
    /* Never condemn on absent evidence — a proxy, or an older OSRM, may not report it.
       Every fixture in this file omits sources/destinations, so this is also what keeps
       the other 70-odd tests meaningful. */
    const noFields = makeFetch(function () {
        return {
            code: 'Ok',
            distances: [[0, 617000], [617000, 0]],
            durations: [[0, 22500], [22500, 0]]
        };
    });
    const a = await distanceMatrix([MADRID, BARCELONA], { fetchImpl: noFields, storage: null, minIntervalMs: 0 });
    assert.strictEqual(a.source, 'osrm', 'absent snap fields are not evidence of anything');

    /* Junk in the fields is also not evidence. */
    for (const junk of [null, undefined, 'x', {}, [], true, NaN, -5, Infinity]) {
        const fetchImpl = makeFetch(function () {
            return {
                code: 'Ok',
                distances: [[0, 617000], [617000, 0]],
                durations: [[0, 22500], [22500, 0]],
                sources: [{ distance: junk }, { distance: junk }],
                destinations: [{ distance: junk }, { distance: junk }]
            };
        });
        const m = await distanceMatrix([MADRID, BARCELONA], { fetchImpl: fetchImpl, storage: null, minIntervalMs: 0 });
        assertMatrixInvariants(m, 2, 'D16 junk snap ' + String(junk));
        assert.strictEqual(m.source, 'osrm', String(junk) + ' in sources[].distance proves nothing');
    }
});

test('matrix D16: only the misplaced place loses its cells, not the whole matrix', async function () {
    /* The verdict is per WAYPOINT, so a three-place matrix with one exclave keeps the
       road data for the pair that is fine. */
    const fetchImpl = makeFetch(function () {
        return {
            code: 'Ok',
            distances: [[0, 617000, 556000], [617000, 0, 349000], [556000, 349000, 0]],
            durations: [[0, 22500, 23100], [22500, 0, 20940], [23100, 20940, 0]],
            sources: [{ distance: 90 }, { distance: 20 }, { distance: 155760 }],
            destinations: [{ distance: 90 }, { distance: 20 }, { distance: 155760 }]
        };
    });
    const m = await distanceMatrix([MADRID, BARCELONA, place('Melilla', 35.2923, -2.9381)],
        { fetchImpl: fetchImpl, storage: null, minIntervalMs: 0 });
    assertMatrixInvariants(m, 3, 'D16 partial');
    assert.strictEqual(m.source, 'mixed');
    assert.strictEqual(m.km[0][1], 617, 'Madrid-Barcelona is untouched');
    assert.strictEqual(m.osrmCells, 2, 'exactly the one good pair');
    assert.strictEqual(m.filledCells, 4, 'both pairs touching the exclave are filled');
});

test('matrix D16: every measured route survives with its real snap distances attached', async function () {
    /* The 69-route fixture with realistic snaps — none of the measured legitimate routes
       exceeded 1.35 km — must be entirely unaffected by the new guard. */
    for (const [name, aLat, aLon, bLat, bLon, roadKm, minutes] of FERRY_ROUTES) {
        const fetchImpl = tableWithSnap(roadKm, minutes, 1.35, 0.5);
        const m = await distanceMatrix([place('A', aLat, aLon), place('B', bLat, bLon)],
            { fetchImpl: fetchImpl, storage: null, minIntervalMs: 0 });
        assertMatrixInvariants(m, 2, 'D16 fixture ' + name);
        assert.strictEqual(m.source, 'osrm', name + ' must not be newly rejected');
        assert.strictEqual(m.min[0][1], minutes, name + ': duration kept');
    }
});

test('matrix D15: the detour ceiling is a loose sanity bound, not a fitted one', async function () {
    /* Reported repro: at x10 the ceiling destroyed real routes. Enclosed seas produce the
       HIGHEST ratios at LONG crow lines — the crossing is short but OSRM declines the
       ferry and drives around the whole sea — which is the opposite of what this suite
       previously assumed, and the +50 km slack is only 8% of a 629 km road so it cannot
       help. All three were silent understatements of drive time. */
    const casualties = [
        ['Gedser-Rostock (Baltic)',        [54.5740, 11.9260], [54.1780, 12.0930],  629,  426],
        ['Brindisi-Igoumenitsa (Adriatic)', [40.6420, 17.9460], [39.5040, 20.2650], 2601, 1626],
        ['Hirtshals-Kristiansand (Skagerrak)', [57.5880, 9.9600], [58.1460, 7.9950], 1375, 972]
    ];
    for (const [label, a, b, roadKm, minutes] of casualties) {
        const crow = haversineKm(a[0], a[1], b[0], b[1]);
        assert.ok(roadKm > crow * 10 + 50, label + ': fixture must be one the x10 ceiling killed');
        const fetchImpl = makeFetch(function () {
            return {
                code: 'Ok',
                distances: [[0, roadKm * 1000], [roadKm * 1000, 0]],
                durations: [[0, minutes * 60], [minutes * 60, 0]]
            };
        });
        const m = await distanceMatrix([place('A', a[0], a[1]), place('B', b[0], b[1])],
            { fetchImpl: fetchImpl, storage: null, minIntervalMs: 0 });
        assertMatrixInvariants(m, 2, 'D15 ' + label);
        assert.strictEqual(m.source, 'osrm',
            label + ' (x' + (roadKm / crow).toFixed(2) + ') is an ordinary drivable answer');
        assert.strictEqual(m.min[0][1], minutes, label + ': measured duration kept');
    }

    /* The ceiling's ONE unique job still gets done: a distance that is absurd AND
       internally consistent with its duration, which nothing downstream would catch. */
    const selfConsistent = makeFetch(function () {
        return {
            code: 'Ok',
            distances: [[0, 30305780], [30305780, 0]],
            durations: [[0, 202 * 3600], [202 * 3600, 0]]     // 150 km/h along it — in band
        };
    });
    const junk = await distanceMatrix([MADRID, BARCELONA], { fetchImpl: selfConsistent, storage: null, minIntervalMs: 0 });
    assertMatrixInvariants(junk, 2, 'D15 x60 self-consistent');
    assert.strictEqual(junk.source, 'haversine', 'the x60 case must still die on distance');
    assert.strictEqual(junk.osrmCells, 0);

    /* And everything else the ceiling used to catch is caught downstream anyway, which
       is what lets it be loose: these clear a 30x ceiling and die on the speed guard. */
    for (const [label, roadKm] of [['3000 km in 360 min', 3000], ['6000 km in 360 min', 6000]]) {
        assert.ok(roadKm <= 505 * 30 + 50, label + ' clears the 30x ceiling on distance');
        const fetchImpl = makeFetch(function () {
            return {
                code: 'Ok',
                distances: [[0, roadKm * 1000], [roadKm * 1000, 0]],
                durations: [[0, 21600], [21600, 0]]
            };
        });
        const m = await distanceMatrix([MADRID, BARCELONA], { fetchImpl: fetchImpl, storage: null, minIntervalMs: 0 });
        assert.strictEqual(m.source, 'haversine', label + ' is still rejected, by the 200 km/h guard');
    }
});

test('matrix D14: a narrow crossing is still a crossing', async function () {
    /* Reported repro: scaling the allowance by separation drove it to nothing across a
       narrow channel, so a slow short sailing was condemned and its measured duration
       replaced by an estimate up to 35x smaller — the same failure, same direction, that
       this suite already treats as disqualifying at long range (D12), reintroduced at
       short range and worse in degree. The cliff sat at about 2.9 km of separation. */
    const cases = [
        /* name, crow km, road km, minutes, cap under the unfloored rule */
        ['Woolwich Ferry (Thames)',   0.34,  2.67, 16.2, 12.2],
        ['Oanes-Lauvvik (Lysefjord)', 1.28, 12.00, 80.4, 49.5],
        ['Lavik-Oppedal at 2.00 km',  2.00,  9.91, 73.8, 59.8],
        ['Lavik-Oppedal at 2.56 km',  2.56,  9.91, 73.8, 71.0]
    ];
    for (const [label, crowKm, roadKm, minutes, oldCap] of cases) {
        assert.ok(minutes > oldCap, label + ': fixture must be one the old rule killed');
        const b = place('B', 40.4168 + crowKm / 111.195, -3.7038);
        const fetchImpl = makeFetch(function () {
            return {
                code: 'Ok',
                distances: [[0, Math.round(roadKm * 1000)], [Math.round(roadKm * 1000), 0]],
                durations: [[0, Math.round(minutes * 60)], [Math.round(minutes * 60), 0]]
            };
        });
        const m = await distanceMatrix([place('A', 40.4168, -3.7038), b],
            { fetchImpl: fetchImpl, storage: null, minIntervalMs: 0 });
        assertMatrixInvariants(m, 2, 'D14 ' + label);
        assert.strictEqual(m.source, 'osrm', label + ' is a real ferry and must survive');
        assert.ok(Math.abs(m.min[0][1] - minutes) < 0.1,
            label + ': the measured duration is kept, got ' + m.min[0][1] + ' not ' + minutes);
    }

    /* The floor must not become a new hole: a 2 km leg claiming 3 h is still refused. */
    const probe = makeFetch(function () {
        return { code: 'Ok', distances: [[0, 2000], [2000, 0]], durations: [[0, 3 * 3600], [3 * 3600, 0]] };
    });
    const junk = await distanceMatrix(
        [place('A', 40.4168, -3.7038), place('B', 40.4168 + 1.9 / 111.195, -3.7038)],
        { fetchImpl: probe, storage: null, minIntervalMs: 0 });
    assert.strictEqual(junk.source, 'haversine', '3 h for a 2 km leg is still not credible');
});

test('matrix D13: the stoppage allowance is earned by separation, not granted flat', async function () {
    /* Reported repro: the 48 h allowance was unconditional, so below ~100 km the cap was
       ~48 h regardless of distance — which removed the slow-side protection from exactly
       the legs a city itinerary is made of. Each of these shipped as source 'osrm', i.e.
       LABELLED AS MEASURED, which is the one thing this module's central law forbids. */
    const cases = [
        ['2 km city claimed at 40 h',   1.9,   2, 40],
        ['10 km city claimed at 47 h',  9.3,  10, 47],
        ['50 km claimed at 48 h',      45.9,  50, 48],
        ['100 km claimed at 50 h',     90.8, 100, 50]
    ];
    for (const [label, crowKm, roadKm, hours] of cases) {
        const b = place('B', 40.4168 + crowKm / 111.195, -3.7038);
        const fetchImpl = makeFetch(function () {
            return {
                code: 'Ok',
                distances: [[0, roadKm * 1000], [roadKm * 1000, 0]],
                durations: [[0, hours * 3600], [hours * 3600, 0]]
            };
        });
        const m = await distanceMatrix([place('A', 40.4168, -3.7038), b],
            { fetchImpl: fetchImpl, storage: null, minIntervalMs: 0 });
        assertMatrixInvariants(m, 2, 'D13 ' + label);
        assert.strictEqual(m.source, 'haversine',
            label + ' must not ship labelled as measured — no crossing is plausible over ' +
            crowKm + ' km');
        assert.strictEqual(m.osrmCells, 0, label);
        assert.ok(m.min[0][1] < hours * 60,
            label + ': the estimate replaced it, got ' + m.min[0][1] + ' min');
    }

    /* The same durations over a separation where a crossing IS plausible are kept —
       the allowance is earned by the crow line, not withheld from ferries. */
    const ferry = makeFetch(function () {
        return {
            code: 'Ok',
            distances: [[0, 176000], [176000, 0]],
            durations: [[0, 1734 * 60], [1734 * 60, 0]]        // Athens-Mykonos, 28.9 h
        };
    });
    const kept = await distanceMatrix(
        [place('Athens', 37.9838, 23.7275), place('Mykonos', 37.4467, 25.3289)],
        { fetchImpl: ferry, storage: null, minIntervalMs: 0 });
    assert.strictEqual(kept.source, 'osrm', '28.9 h across 153 km of Aegean is real');
    assert.strictEqual(kept.min[0][1], 1734);
});

test('matrix D12: a second, independent mis-snap is refused the same way', async function () {
    /* Mannheller -> Fodnes is a real 2.7 km Sognefjord ferry, but OSRM answered
       1.33 km / 1.2 min at 64 km/h. /route shows why: waypoint 0 snapped 2038 m away and
       BOTH waypoints landed on the same road, "Erdalsvegen", on the same shore. It is a
       land route along one bank, not the crossing. Same mechanism as Algeciras-Ceuta,
       found independently while measuring the narrow crossings for D14 — which is why a
       road shorter than the great circle condemns the whole cell rather than the
       distance alone. */
    const fetchImpl = makeFetch(function () {
        return { code: 'Ok', distances: [[0, 1330], [1330, 0]], durations: [[0, 72], [72, 0]] };
    });
    const m = await distanceMatrix(
        [place('Mannheller', 61.0870, 7.3480), place('Fodnes', 61.0730, 7.3900)],
        { fetchImpl: fetchImpl, storage: null, minIntervalMs: 0 });
    assertMatrixInvariants(m, 2, 'D12 Mannheller-Fodnes');
    assert.strictEqual(m.source, 'haversine', 'a 1.33 km road under a 2.74 km crow line is one shore');
    assert.strictEqual(m.osrmCells, 0, 'the duration goes with the distance');
    assert.ok(m.km[0][1] > 2.7, 'the estimate at least spans the fjord, got ' + m.km[0][1]);
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

test('matrix D12: the detour ceiling clears every measured route, with room to spare', async function () {
    /* The worst measured real ratio has grown EVERY time a new class of geography was
       measured: x4.45 Helsinki-Stockholm, x6.51 Athens-Chios, x7.73 Oban-Craignure,
       x9.38 Oanes-Lauvvik, x13.86 Gedser-Rostock. That is why the ceiling is no longer
       fitted to it — see D15. The assertion here is headroom, which is the operative
       quantity, but note what round 8 taught: headroom measured over a population that
       lacks the stressing class describes the wrong distribution. It said x5.23 when
       three real routes were in fact being destroyed, because no enclosed-sea crossing
       was in the fixture. The number is only as good as the fixture behind it. */
    let worstRatio = 0, worstName = '';
    let tightest = Infinity, tightestName = '';
    for (const [name, aLat, aLon, bLat, bLon, roadKm] of FERRY_ROUTES) {
        const crow = haversineKm(aLat, aLon, bLat, bLon);
        const ratio = roadKm / crow;
        const headroom = (crow * 30 + 50) / roadKm;
        if (ratio > worstRatio) { worstRatio = ratio; worstName = name; }
        if (headroom < tightest) { tightest = headroom; tightestName = name; }
        assert.ok(roadKm <= crow * 30 + 50,
            name + ' detour x' + ratio.toFixed(2) + ' must clear the ceiling');
    }
    assert.ok(tightest > 1.5, 'tightest ceiling headroom is ' + tightestName +
        ' at x' + tightest.toFixed(2) + ' (worst ratio: ' + worstName + ' x' + worstRatio.toFixed(2) + ')');
    /* The fixture must actually CONTAIN the enclosed-sea class, or the line above is
       measuring nothing. This is the guard the previous three rounds each lacked. */
    assert.ok(worstRatio > 13, 'the fixture must contain an enclosed-sea crossing; worst is ' +
        worstName + ' x' + worstRatio.toFixed(2));
});

test('matrix D12: every measured route clears the duration ceiling too', async function () {
    /* The other half of the same guarantee: not one of the 51 is rejected on time, and
       the tightest margin is still Palermo-Lampedusa — 46.9 h against a 59.8 h cap,
       unchanged by the 2 h floor, which only ever raises a cap. */
    let tightest = Infinity, tightestName = '';
    let tightestNarrow = Infinity, narrowName = '';
    for (const [name, aLat, aLon, bLat, bLon, roadKm, minutes] of FERRY_ROUTES) {
        const crow = haversineKm(aLat, aLon, bLat, bLon);
        const cap = Math.min(48 * 60, Math.max(120, crow * 20)) + (roadKm / 30) * 60;
        if (crow < 10 && cap / minutes < tightestNarrow) {
            tightestNarrow = cap / minutes; narrowName = name;
        }
        const headroom = cap / minutes;
        if (headroom < tightest) { tightest = headroom; tightestName = name; }
        assert.ok(minutes <= cap, name + ' (' + (minutes / 60).toFixed(1) + ' h) must clear its ' +
            (cap / 60).toFixed(1) + ' h cap');
    }
    assert.ok(tightest > 1.25 && tightest < 1.35,
        'tightest duration headroom is ' + tightestName + ' at x' + tightest.toFixed(2));
    assert.strictEqual(tightestName, 'Palermo-Lampedusa',
        'the 2 h floor must not have moved the binding case');
    /* The narrow crossings are the class the fixture used to lack, so pin their margin
       separately — it is the one the floor exists to protect. */
    assert.ok(tightestNarrow > 1.5,
        'tightest narrow-crossing headroom is ' + narrowName + ' at x' + tightestNarrow.toFixed(2));
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

/* ══════════════════════════════════════════════════════════════════════════
   G1-G4: geocoding provenance

   A real user typed `Santillana de Mar, Leon, Fisterra, Lugo` for a trip round
   northern Spain and got 24,179 km and 268 hours of driving. Nothing threw and
   nothing was numerically wrong: "Santillana de Mar" is a village in MEXICO and
   "Leon" is a county in TEXAS, and the engine faithfully planned the drive. Ten
   review rounds had validated what OSRM returns and none what Nominatim does.

   Every candidate list below is the LIVE reply from
   nominatim.openstreetmap.org/search?format=jsonv2&limit=5, measured 2026-08.
   Nothing here is invented, and nothing here touches the network.
   ══════════════════════════════════════════════════════════════════════════ */

const { geocodeOutliers } = geo;

/* [lat, lon, display_name] — exactly as Nominatim returned them, in its order. */
const LIVE = {
    'Santillana de Mar': [[22.1356454, -100.9519141, 'Santillana de Mar, Colonia Espanita, San Luis Potosi, Municipio de San Luis Potosi, San Luis Potosi, 78378, Mexico']],
    'Finisterre': [[48.2451153, -4.0440902, 'Finistere, Bretagne, France metropolitaine, France']],
    'Fisterra': [
        [42.9286659, -9.2626624, 'Fisterra, A Coruna, Galicia, Espana'],
        [42.8825, -9.2722222, 'Cabo Fisterra, Fisterra, A Coruna, Galicia, 15155, Espana'],
        [43.0046737, -9.1318361, 'Fisterra, A Coruna, Galicia, Espana']],
    'Leon': [
        [31.2715127, -95.9953382, 'Leon County, Texas, United States'],
        [30.4683062, -84.2549068, 'Leon County, Florida, United States'],
        [40.740465, -93.7465075, 'Leon, Decatur County, Iowa, 50144, United States'],
        [37.6902964, -96.7822508, 'Leon, Butler County, Kansas, United States'],
        [45.7578137, 4.8320114, 'Lyon, Metropole de Lyon, Rhone, Auvergne-Rhone-Alpes, France metropolitaine, France']],
    'Lugo': [
        [43.0395266, -7.4567985, 'Lugo, Galicia, Espana'],
        [42.9913123, -7.5908294, 'Lugo, Galicia, Espana'],
        [44.4765987, 11.89807, 'Lugo, Unione dei comuni della Bassa Romagna, Ravenna, Emilia-Romagna, 48022, Italia'],
        [42.961254, -7.5243782, 'Lugo, Galicia, Espana'],
        [45.3667996, 12.1333816, 'Lugo, Lughetto, Campagna Lupia, Venezia, Veneto, 30010, Italia']],
    'Oviedo': [
        [43.3533452, -5.8795096, 'Oviedo, Asturias / Asturies, Espana'],
        [28.6702526, -81.2084941, 'Oviedo, Seminole County, Florida, 32765, United States'],
        [17.8436883, -71.4284827, 'Oviedo, Pedernales, 21901, Republica Dominicana'],
        [43.3618625, -5.8483581, 'Oviedo / Uvieu, Oviedo, Asturias / Asturies, 33003, Espana'],
        [17.7901489, -71.4129089, 'oviedo, Oviedo, Pedernales, 21901, Republica Dominicana']],
    'Bilbao': [[43.2630018, -2.9350039, 'Bilbao, Bizkaia, Euskadi, Espana']],
    'Santander': [
        [43.4618932, -3.8100255, 'Santander, Cantabria, Espana'],
        [7.0000085, -73.2500086, 'Santander, RAP Gran Santander, Colombia'],
        [9.4170689, 123.3351935, 'Santander, Cebu, Central Visayas, 6026, Philippines']],
    'Gijon': [[43.5449422, -5.66275, 'Gijon / Xixon, Asturias / Asturies, Espana']],
    'Barcelona': [
        [41.3825802, 2.177073, 'Barcelona, Barcelones, Barcelona, Catalunya, Espana'],
        [41.75787, 2.031182, 'Barcelona, Catalunya, Espana']],
    'Santiago': [
        [9.8694792, -83.7980749, 'Santiago, Paraiso, Cartago, 30202, Costa Rica'],
        [-33.4376995, -70.6510671, 'Santiago, Provincia de Santiago, Region Metropolitana de Santiago, 8320000, Chile'],
        [20.0214263, -75.8294928, 'Santiago de Cuba, Distrito Antonio Maceo, Santiago de Cuba, Cuba'],
        [19.4508468, -70.6947386, 'Santiago, Republica Dominicana'],
        [-29.189675, -54.866624, 'Santiago, Rio Grande do Sul, Regiao Sul, Brasil']],
    'Guadalajara': [
        [20.6720375, -103.338396, 'Guadalajara, Region Centro, Jalisco, 44450, Mexico'],
        [40.7399963, -2.50593, 'Guadalajara, Castilla-La Mancha, Espana'],
        [40.6326979, -3.1646067, 'Guadalajara, Castilla-La Mancha, Espana'],
        [20.6782614, -103.3357646, 'Guadalajara, Region Centro, Jalisco, Mexico']],
    'Castellar del Valles': [
        [41.6183431, 2.0879423, 'Castellar del Valles, Valles Occidental, Barcelona, Catalunya, 08211, Espana']]
};

function liveBody(name) {
    const rows = LIVE[name];
    if (!rows) return [];
    return rows.map(function (r) {
        return { lat: String(r[0]), lon: String(r[1]), display_name: r[2] };
    });
}

/* Serves the live reply for whichever known name appears in the query string. */
function liveLookup(url) {
    const q = decodeURIComponent(String(url));
    /* longest first, so a shorter name can never shadow a longer one containing it */
    const names = Object.keys(LIVE).sort(function (a, b) { return b.length - a.length; });
    for (let i = 0; i < names.length; i++) {
        if (q.indexOf('q=' + names[i]) !== -1) return liveBody(names[i]);
    }
    return [];
}

function liveFetch() {
    return makeFetch(function (url) { return liveLookup(url); });
}

/* The exact trip that produced the bug report, plus the rest of the itinerary. */
const USER_TRIP = ['Santillana de Mar', 'Leon', 'Fisterra', 'Lugo',
                   'Oviedo', 'Bilbao', 'Santander', 'Gijon', 'Finisterre'];

function byName(places, name) {
    return places.filter(function (p) { return p.name === name; })[0];
}

/* ── G1: displayName — the signal that costs no heuristic at all ── */

test('G1: displayName carries the full label of what was actually chosen', async function () {
    resetGeoRateLimit();
    const fetchImpl = liveFetch();
    const out = await geocodePlaces(['Santillana de Mar'], geoOpts({ fetchImpl: fetchImpl }));

    assert.strictEqual(out[0].resolved, true, 'it resolved — nothing was ever broken');
    assert.ok(out[0].displayName.indexOf('Mexico') !== -1,
        'the label says Mexico: ' + out[0].displayName);
    assert.ok(out[0].displayName.indexOf('San Luis Potosi') !== -1, 'and names the town');
    /* This one field, and no heuristic whatsoever, is what would have shown the user
       in two seconds that his Cantabrian village was 8,700 km away. */
});

test('G1: displayName survives the cache round trip', async function () {
    resetGeoRateLimit();
    const storage = makeStorage();
    const fetchImpl = liveFetch();
    const opts = geoOpts({ fetchImpl: fetchImpl, storage: storage });

    const first = await geocodePlaces(['Santillana de Mar'], opts);
    assert.strictEqual(first[0].source, 'osm');

    const second = await geocodePlaces(['santillana de mar'], opts);
    assert.strictEqual(fetchImpl.calls.length, 1, 'served from cache');
    assert.strictEqual(second[0].source, 'cache');
    assert.strictEqual(second[0].displayName, first[0].displayName,
        'a cached place is not an anonymous coordinate pair');
    assert.strictEqual(second[0].candidates, first[0].candidates, 'and remembers the ambiguity');
});

test('G1: every Place carries the three provenance fields, always, with stable types', async function () {
    resetGeoRateLimit();
    const fetchImpl = makeFetch(function (url, init, i) {
        if (i === 0) return nominatimHit(40, -3, 'Somewhere, Espana');
        if (i === 1) return new Error('offline');
        return [];
    });
    const out = await geocodePlaces(['Good', 'Dead', 'Empty', '', null], geoOpts({ fetchImpl: fetchImpl }));

    assert.strictEqual(out.length, 5);
    out.forEach(function (p, i) {
        assert.strictEqual(typeof p.displayName, 'string', i + ': displayName is always a string');
        assert.strictEqual(typeof p.candidates, 'number', i + ': candidates is always a number');
        assert.strictEqual(typeof p.chosenByCluster, 'boolean', i + ': chosenByCluster is always a boolean');
    });
    assert.strictEqual(out[0].displayName, 'Somewhere, Espana');
    for (let i = 1; i < out.length; i++) {
        assert.strictEqual(out[i].resolved, false);
        assert.strictEqual(out[i].displayName, '',
            'nothing was chosen, so there is no label of what was chosen (not undefined)');
        assert.strictEqual(out[i].candidates, 0);
        assert.strictEqual(out[i].chosenByCluster, false);
    }
});

test('G1: a non-string or oversized display_name never reaches a Place', async function () {
    resetGeoRateLimit();
    const huge = new Array(5001).join('x');
    const fetchImpl = makeFetch(function (url, init, i) {
        if (i === 0) return [{ lat: '1', lon: '1', display_name: { toString: function () { return 'nope'; } } }];
        if (i === 1) return [{ lat: '2', lon: '2', display_name: 12345 }];
        if (i === 2) return [{ lat: '3', lon: '3' }];
        return [{ lat: '4', lon: '4', display_name: huge }];
    });
    const out = await geocodePlaces(['A', 'B', 'C', 'D'], geoOpts({ fetchImpl: fetchImpl }));

    assert.strictEqual(out[0].displayName, '', 'an object is not a label, and never "[object Object]"');
    assert.strictEqual(out[1].displayName, '', 'a number is not a label');
    assert.strictEqual(out[2].displayName, '', 'an absent label is an empty label');
    assert.ok(out[3].displayName.length <= 300 && out[3].displayName.length > 0,
        'an unbounded blob is capped before it can reach localStorage');
    out.forEach(function (p) { assert.strictEqual(p.resolved, true, 'the coordinates still work'); });
});

/* ── G2: candidates — "the choice was among several" ── */

test('G2: candidates reports how many the geocoder offered', async function () {
    resetGeoRateLimit();
    const fetchImpl = liveFetch();
    const out = await geocodePlaces(['Leon', 'Fisterra', 'Bilbao'], geoOpts({ fetchImpl: fetchImpl }));

    assert.strictEqual(out[0].candidates, 5, "'Leon' is ambiguous — five candidates");
    assert.strictEqual(out[1].candidates, 3, "'Fisterra' — three");
    assert.strictEqual(out[2].candidates, 1, "'Bilbao' — one, unambiguous");
    assert.ok(out[0].candidates > 1, 'candidates > 1 is the ambiguity signal the UI needs');
});

test('G2: ambiguity detection cannot save the case that caused the bug', async function () {
    /* The point of this test is the LIMIT of requirement 2, recorded so nobody later
       assumes candidates>1 covers the reported failure. It does not: Nominatim is not
       uncertain about "Santillana de Mar", it is confidently answering about Mexico,
       and it offers exactly one candidate for it. */
    resetGeoRateLimit();
    const fetchImpl = liveFetch();
    const out = await geocodePlaces(['Santillana de Mar', 'Finisterre'], geoOpts({ fetchImpl: fetchImpl }));

    assert.strictEqual(out[0].candidates, 1, 'one candidate: no ambiguity to detect');
    assert.strictEqual(out[1].candidates, 1, 'same for the Breton "Finisterre"');
    assert.strictEqual(out[0].chosenByCluster, false, 'and nothing to prefer either');
    /* Only displayName (G1) and geocodeOutliers (G4) reach this case. */
});

test('G2: results with unusable coordinates are dropped, not counted, not chosen', async function () {
    resetGeoRateLimit();
    const fetchImpl = makeFetch(function () {
        return [
            { lat: '999', lon: '0', display_name: 'Out of range' },
            { lat: true, lon: true, display_name: 'Number(true) is 1' },
            { lat: '43.26', lon: '-2.93', display_name: 'Bilbao, Espana' }
        ];
    });
    const out = await geocodePlaces(['Mixed'], geoOpts({ fetchImpl: fetchImpl }));

    assert.strictEqual(out[0].resolved, true, 'one usable result is enough');
    assert.strictEqual(out[0].lat, 43.26, 'the usable one was taken');
    assert.strictEqual(out[0].displayName, 'Bilbao, Espana');
    assert.strictEqual(out[0].candidates, 1,
        'candidates describes the set the choice was made from, not the size of the body');
});

test('G2: a candidate list survives the cache in a backwards-compatible entry', async function () {
    resetGeoRateLimit();
    const storage = makeStorage();
    const fetchImpl = liveFetch();
    const opts = geoOpts({ fetchImpl: fetchImpl, storage: storage });

    await geocodePlaces(['Leon'], opts);
    const raw = JSON.parse(storage._data.get(cacheKeyFor('Leon')));
    assert.strictEqual(raw.lat, 31.2715127, 'the old fields still describe the first candidate');
    assert.strictEqual(typeof raw.displayName, 'string');
    assert.strictEqual(raw.cands.length, 5, 'and the whole list is kept alongside them');

    const again = await geocodePlaces(['Leon'], opts);
    assert.strictEqual(fetchImpl.calls.length, 1, 'no second request');
    assert.strictEqual(again[0].candidates, 5, 'ambiguity is not forgotten by a cache hit');
});

test('G2: an entry written before candidate lists existed still reads, as one candidate', async function () {
    resetGeoRateLimit();
    const seed = {};
    seed[cacheKeyFor('Old')] = JSON.stringify({ lat: 43.26, lon: -2.93, displayName: 'Bilbao, Espana', ts: Date.now() });
    const storage = makeStorage(seed);
    const fetchImpl = liveFetch();
    const out = await geocodePlaces(['Old'], geoOpts({ fetchImpl: fetchImpl, storage: storage }));

    assert.strictEqual(fetchImpl.calls.length, 0, 'the old entry is still usable');
    assert.strictEqual(out[0].source, 'cache');
    assert.strictEqual(out[0].lat, 43.26);
    assert.strictEqual(out[0].displayName, 'Bilbao, Espana');
    assert.strictEqual(out[0].candidates, 1, 'one candidate is all that was ever stored');
});

test('G2: a poisoned candidate inside a cache entry is dropped, never served', async function () {
    resetGeoRateLimit();
    const seed = {};
    seed[cacheKeyFor('Poison')] = JSON.stringify({
        lat: 43.26, lon: -2.93, displayName: 'Bilbao', ts: Date.now(),
        cands: [[43.26, -2.93, 'Bilbao'], [9999, -77777, 'Injected'], [true, true, 'Coerced'], 'garbage']
    });
    const storage = makeStorage(seed);
    const out = await geocodePlaces(['Poison'], geoOpts({ fetchImpl: liveFetch(), storage: storage }));

    assert.strictEqual(out[0].candidates, 1, 'only the valid candidate survived');
    assert.strictEqual(out[0].lat, 43.26);
    /* The cache path gets exactly the validation the network path does — those
       coordinates would otherwise go straight into an OSRM URL. */
});

/* ── G3: cluster preference — allowed, but never silent ── */

test("G3: the user's real case — 'Leon' moves off Texas, and says so", async function () {
    resetGeoRateLimit();
    const fetchImpl = liveFetch();
    const out = await geocodePlaces(USER_TRIP, geoOpts({ fetchImpl: fetchImpl }));

    const leon = byName(out, 'Leon');
    assert.strictEqual(leon.chosenByCluster, true, 'a non-first candidate was preferred, and it is flagged');
    assert.ok(leon.displayName.indexOf('Lyon') !== -1,
        'the label names what was taken instead: ' + leon.displayName);
    assert.ok(Math.abs(leon.lat - 45.7578137) < 1e-6 && Math.abs(leon.lon - 4.8320114) < 1e-6);

    /* 7,700 km from the Spanish cluster before, ~850 km after. Still not what the user
       meant — the app cannot know that — but it is now a fact he can see and correct. */
    const before = haversineKm(31.2715127, -95.9953382, 43.4, -4.85);
    const after = haversineKm(leon.lat, leon.lon, 43.4, -4.85);
    assert.ok(before > 7000, 'Texas was ' + Math.round(before) + ' km from the trip');
    assert.ok(after < 1000 && after < before / 5, 'Lyon is ' + Math.round(after) + ' km from it');
});

test('G3: NOTHING is ever relocated silently', async function () {
    resetGeoRateLimit();
    const fetchImpl = liveFetch();
    const out = await geocodePlaces(USER_TRIP, geoOpts({ fetchImpl: fetchImpl }));

    /* The contract's rule: "Choosing a candidate nearer the cluster is allowed; doing it
       silently is not." Verified structurally — chosenByCluster is true for exactly
       those places whose chosen coordinates differ from the geocoder's FIRST answer. */
    let moves = 0;
    out.forEach(function (p) {
        const list = LIVE[p.name];
        if (!list) return;
        const first = list[0];
        const moved = Math.abs(p.lat - first[0]) > 1e-9 || Math.abs(p.lon - first[1]) > 1e-9;
        assert.strictEqual(p.chosenByCluster, moved,
            p.name + ': chosenByCluster must mean exactly "this is not the geocoder\'s first answer"');
        if (moved) {
            moves++;
            const taken = list.filter(function (c) { return Math.abs(c[0] - p.lat) < 1e-9; })[0];
            assert.strictEqual(p.displayName, taken[2],
                p.name + ': the label describes the candidate actually taken');
        }
    });
    assert.strictEqual(moves, 1, 'exactly one destination was relocated on this trip');
});

test('G3: another node of the SAME town is not a relocation and raises no flag', async function () {
    /* Nominatim returns three Fisterra nodes spanning 14 km and two Oviedo nodes 2.8 km
       apart, and one of them is marginally nearer the cluster centre. Flagging that
       would turn the signal into noise, and the user's destination did not move. */
    resetGeoRateLimit();
    const fetchImpl = liveFetch();
    const out = await geocodePlaces(USER_TRIP, geoOpts({ fetchImpl: fetchImpl }));

    ['Fisterra', 'Oviedo', 'Lugo', 'Santander'].forEach(function (name) {
        const p = byName(out, name);
        assert.strictEqual(p.chosenByCluster, false, name + ': same town, no flag');
        assert.strictEqual(p.lat, LIVE[name][0][0], name + ": kept the geocoder's own first answer");
        assert.ok(p.candidates > 1, name + ': but the ambiguity is still reported');
    });
});

test('G3: with too small a plurality, nothing is relocated at all', async function () {
    /* Three places, and the coherent group is Lugo + Bilbao — two, below the minimum.
       No plurality, no evidence, no decision. The floor matters because a WRONG pair is
       itself a coherent group (Mexico and Texas are only 1,200 km apart), so without it
       a three-place trip could be anchored on the two errors in it. */
    resetGeoRateLimit();
    const fetchImpl = liveFetch();
    const out = await geocodePlaces(['Leon', 'Lugo', 'Bilbao'], geoOpts({ fetchImpl: fetchImpl }));

    const leon = byName(out, 'Leon');
    assert.strictEqual(leon.chosenByCluster, false, 'two places are not a plurality worth acting on');
    assert.strictEqual(leon.lat, 31.2715127, 'Texas is still on show — and displayName says so');
    assert.ok(leon.displayName.indexOf('Texas') !== -1);
    assert.strictEqual(leon.candidates, 5, 'ambiguity is still reported to the UI');
});

test('G3: the choice does not depend on which name the user typed first', async function () {
    /* An incremental "prefer against the cluster so far" would answer differently for a
       reordered list — a decision varying with irrelevant input. The pure second pass
       cannot: every candidate is in hand before any choice is made. */
    resetGeoRateLimit();
    const forward = await geocodePlaces(USER_TRIP, geoOpts({ fetchImpl: liveFetch() }));
    resetGeoRateLimit();
    const backward = await geocodePlaces(USER_TRIP.slice().reverse(), geoOpts({ fetchImpl: liveFetch() }));

    const key = function (list) {
        return list.slice().sort(function (a, b) { return a.name < b.name ? -1 : 1; })
            .map(function (p) { return p.name + '@' + p.lat + ',' + p.lon + ',' + p.chosenByCluster; });
    };
    assert.deepStrictEqual(key(forward), key(backward), 'same answer, whatever the input order');
});

test('G3: the cluster pass costs no request, no spacing and no concurrency', async function () {
    /* The rate limiter and the single-flight guarantee cost a review round each. Asking
       for limit=5 means every candidate is already in hand when phase 2 runs, so phase 2
       issues nothing at all. */
    resetGeoRateLimit();
    const clock = makeClock(4000000);
    const fetchImpl = makeFetch(function (url) { clock.advance(20); return liveLookup(url); });
    const starts = [];
    const wrapped = function (url, init) { starts.push(clock.now()); return fetchImpl(url, init); };

    const out = await geocodePlaces(USER_TRIP, {
        fetchImpl: wrapped, storage: null, now: clock.now, sleepImpl: clock.sleep
    });

    assert.strictEqual(out.length, USER_TRIP.length, 'index alignment preserved');
    assert.strictEqual(fetchImpl.calls.length, USER_TRIP.length,
        'exactly one request per name — the cluster pass added none');
    assert.strictEqual(fetchImpl.maxInFlight, 1, 'never more than one request in flight');
    assert.deepStrictEqual(fetchImpl.log.slice(0, 4), ['start:0', 'end:0', 'start:1', 'end:1'],
        'requests do not overlap');
    for (let i = 1; i < starts.length; i++) {
        assert.ok(starts[i] - starts[i - 1] >= 1100,
            'spacing ' + (starts[i] - starts[i - 1]) + 'ms >= 1100ms');
    }
    /* And the flag still landed, so this really was a run of phase 2. */
    assert.strictEqual(byName(out, 'Leon').chosenByCluster, true);
});

test('G3: the cache stores the geocoder answer, never the trip-specific choice', async function () {
    /* A cluster choice depends on the OTHER places in the same request. Caching it would
       bake a decision made for one trip into every later trip naming the same place. */
    resetGeoRateLimit();
    const storage = makeStorage();
    const trip = await geocodePlaces(USER_TRIP, geoOpts({ fetchImpl: liveFetch(), storage: storage }));
    assert.strictEqual(byName(trip, 'Leon').chosenByCluster, true, 'relocated in this trip');

    const stored = JSON.parse(storage._data.get(cacheKeyFor('Leon')));
    assert.strictEqual(stored.lat, 31.2715127, 'but Texas — the raw first answer — is what was cached');
    assert.strictEqual(stored.cands.length, 5, 'the whole list, in the geocoder order');

    resetGeoRateLimit();
    const alone = await geocodePlaces(['Leon'], geoOpts({ fetchImpl: liveFetch(), storage: storage }));
    assert.strictEqual(alone[0].chosenByCluster, false, 'a later, different trip re-decides from scratch');
    assert.strictEqual(alone[0].lat, 31.2715127);
});

test('G3: a place with no candidates, and a malformed reply, do not disturb the cluster pass', async function () {
    resetGeoRateLimit();
    const fetchImpl = makeFetch(function (url) {
        const q = decodeURIComponent(String(url));
        if (q.indexOf('q=Nowhere') !== -1) return [];
        if (q.indexOf('q=Junk') !== -1) return { not: 'an array' };
        if (q.indexOf('q=Dead') !== -1) return new Error('socket hang up');
        return liveLookup(url);
    });
    const names = ['Bilbao', 'Nowhere', 'Gijon', 'Junk', 'Santillana de Mar', 'Leon', 'Finisterre', 'Dead'];
    const out = await geocodePlaces(names, geoOpts({ fetchImpl: fetchImpl }));

    assert.deepStrictEqual(out.map(function (p) { return p.name; }), names, 'nothing dropped or reordered');
    ['Nowhere', 'Junk', 'Dead'].forEach(function (n) {
        assert.strictEqual(byName(out, n).resolved, false, n + ' is unresolved');
        assert.strictEqual(byName(out, n).candidates, 0);
        assert.strictEqual(byName(out, n).displayName, '');
    });
    assert.strictEqual(byName(out, 'Leon').chosenByCluster, true, 'the cluster still formed from the rest');
});

test('G3: a duplicated name is one vote, not three', async function () {
    /* Bilbao three times plus Gijon looks like a coherent group of four but is only two
       distinct places, which is below the anchor minimum. Counting duplicates would let a
       user tilt the median simply by repeating a destination. */
    resetGeoRateLimit();
    const fetchImpl = liveFetch();
    const out = await geocodePlaces(['Bilbao', 'bilbao', 'BILBAO', 'Gijon', 'Leon'],
        geoOpts({ fetchImpl: fetchImpl }));

    assert.strictEqual(fetchImpl.calls.length, 3, 'the repeat was fetched once');
    assert.strictEqual(byName(out, 'Leon').chosenByCluster, false, 'two distinct anchors is not a cluster');
    assert.strictEqual(out[0].lat, out[1].lat, 'the duplicates still agree with each other');
    assert.strictEqual(out[1].lat, out[2].lat);
});

/* ── G4: geocodeOutliers — name the odd one out ── */

function pl(name, lat, lon, displayName) {
    return { name: name, lat: lat, lon: lon, resolved: true, source: 'osm',
             displayName: displayName || name, candidates: 1, chosenByCluster: false };
}

/* The itinerary as the user meant it. */
const N_SPAIN = [
    pl('Santillana del Mar', 43.391, -4.108), pl('Leon', 42.599, -5.567),
    pl('Fisterra', 42.929, -9.263), pl('Lugo', 43.012, -7.556),
    pl('Oviedo', 43.362, -5.849), pl('Bilbao', 43.263, -2.935),
    pl('Santander', 43.462, -3.810), pl('Gijon', 43.545, -5.663),
    pl('Ribadeo', 43.537, -7.041), pl('Cangas de Onis', 43.351, -5.128),
    pl('Potes', 43.153, -4.622), pl('A Coruna', 43.362, -8.412)
];
/* The itinerary as it was actually planned. */
const N_SPAIN_BROKEN = N_SPAIN.map(function (p) {
    return p.name === 'Santillana del Mar'
        ? pl('Santillana de Mar', 22.1356454, -100.9519141, LIVE['Santillana de Mar'][0][2])
        : p;
});
/* Four points a few km apart inside one city — the shape that destroys a ratio-only rule. */
function cityStops(prefix, lat, lon) {
    return [pl(prefix + ' 1', lat + 0.02, lon + 0.01), pl(prefix + ' 2', lat - 0.02, lon + 0.02),
            pl(prefix + ' 3', lat + 0.01, lon - 0.03), pl(prefix + ' 4', lat - 0.03, lon - 0.01)];
}

test("G4: the user's real case is named, with the label that explains it", function () {
    const found = geocodeOutliers(N_SPAIN_BROKEN);
    assert.strictEqual(found.length, 1, 'exactly one place is the odd one out');
    assert.strictEqual(found[0].name, 'Santillana de Mar');
    assert.ok(found[0].km > 8000, 'it is ' + Math.round(found[0].km) + ' km from the rest of the trip');
    assert.ok(found[0].displayName.indexOf('Mexico') !== -1,
        'and the note can say WHY: ' + found[0].displayName);
});

test('G4: the same itinerary, geocoded correctly, is silent', function () {
    assert.deepStrictEqual(geocodeOutliers(N_SPAIN), [], 'a coherent trip flags nothing');
});

test('G4: legitimately spread-out trips are NOT flagged', function () {
    /* The false-positive side is the one that makes the feature worthless. */
    const cases = [
        ['Lisbon-Berlin-Athens', [pl('Lisbon', 38.72, -9.14), pl('Berlin', 52.52, 13.40), pl('Athens', 37.98, 23.73)]],
        ['a genuine Lyon-Brittany run', [pl('Lyon', 45.76, 4.83), pl('Quimper', 47.996, -4.098)]],
        ['Lyon-Brittany-Paris', [pl('Lyon', 45.76, 4.83), pl('Quimper', 47.996, -4.098), pl('Paris', 48.857, 2.352)]],
        ['grand European tour', [pl('Lisbon', 38.72, -9.14), pl('Madrid', 40.42, -3.70), pl('Paris', 48.86, 2.35),
            pl('Berlin', 52.52, 13.40), pl('Rome', 41.90, 12.50), pl('Athens', 37.98, 23.73),
            pl('Istanbul', 41.01, 28.98), pl('Stockholm', 59.33, 18.07)]],
        ['Norway to the Arctic', [pl('Oslo', 59.91, 10.75), pl('Bergen', 60.39, 5.32), pl('Trondheim', 63.43, 10.40),
            pl('Tromso', 69.65, 18.96), pl('Kirkenes', 69.73, 30.05)]],
        ['Route 66', [pl('Chicago', 41.88, -87.63), pl('St Louis', 38.63, -90.20), pl('Oklahoma City', 35.47, -97.52),
            pl('Amarillo', 35.22, -101.83), pl('Albuquerque', 35.08, -106.65), pl('Flagstaff', 35.20, -111.65),
            pl('Los Angeles', 34.05, -118.24)]],
        ['Japan including Sapporo', [pl('Tokyo', 35.68, 139.69), pl('Kyoto', 35.01, 135.77), pl('Osaka', 34.69, 135.50),
            pl('Hiroshima', 34.39, 132.46), pl('Fukuoka', 33.59, 130.40), pl('Sapporo', 43.06, 141.35)]],
        ['Morocco by ferry', [pl('Madrid', 40.42, -3.70), pl('Granada', 37.18, -3.60), pl('Tarifa', 36.01, -5.60),
            pl('Tangier', 35.77, -5.80), pl('Fez', 34.03, -5.00), pl('Marrakech', 31.63, -8.01)]],
        ['USA coast to coast', [pl('New York', 40.71, -74.01), pl('Chicago', 41.88, -87.63), pl('Denver', 39.74, -104.99),
            pl('Las Vegas', 36.17, -115.14), pl('San Francisco', 37.77, -122.42)]],
        ['Canada Trans-Canada', [pl('Halifax', 44.65, -63.58), pl('Montreal', 45.50, -73.57), pl('Toronto', 43.65, -79.38),
            pl('Winnipeg', 49.90, -97.14), pl('Calgary', 51.05, -114.07), pl('Vancouver', 49.28, -123.12)]],
        ['Chile, long and thin', [pl('Arica', -18.48, -70.31), pl('Santiago', -33.45, -70.67),
            pl('Puerto Montt', -41.47, -72.94), pl('Punta Arenas', -53.16, -70.91)]],
        ['Silk Road', [pl('Istanbul', 41.01, 28.98), pl('Tehran', 35.69, 51.39), pl('Samarkand', 39.65, 66.98),
            pl('Kashgar', 39.47, 75.99), pl('Xian', 34.34, 108.94)]],
        ['trans-Africa', [pl('Cape Town', -33.92, 18.42), pl('Johannesburg', -26.20, 28.05),
            pl('Nairobi', -1.29, 36.82), pl('Cairo', 30.04, 31.24)]],
        ['Pan-American south', [pl('Ushuaia', -54.80, -68.30), pl('Buenos Aires', -34.60, -58.38),
            pl('Lima', -12.05, -77.04), pl('Bogota', 4.71, -74.07), pl('Panama', 8.98, -79.52)]]
    ];
    cases.forEach(function (c) {
        assert.deepStrictEqual(geocodeOutliers(c[1]), [], c[0] + ' must not be flagged');
    });
});

test('G4: a ratio alone would be worthless — hub-and-spoke trips are not flagged', function () {
    /* Four stops inside one city give a median spread of ~4 km, so the RATIO of an
       ordinary domestic destination explodes: x136 for Edinburgh, x230 for Sapporo,
       x470 for Miami, x740 for Sydney. Every one of these is a real itinerary, and this
       is the class the first threshold fixture did not contain — the exact mistake this
       file has recorded twice already under RETRACTED. */
    const cases = [
        ['London stops + Edinburgh', cityStops('London', 51.507, -0.128).concat([pl('Edinburgh', 55.953, -3.188)])],
        ['Barcelona stops + Madrid', cityStops('Barcelona', 41.385, 2.173).concat([pl('Madrid', 40.417, -3.704)])],
        ['Tokyo stops + Sapporo', cityStops('Tokyo', 35.682, 139.692).concat([pl('Sapporo', 43.062, 141.354)])],
        ['New York stops + Miami', cityStops('NYC', 40.713, -74.006).concat([pl('Miami', 25.762, -80.192)])],
        ['Sydney stops + Cairns', cityStops('Sydney', -33.868, 151.209).concat([pl('Cairns', -16.920, 145.771)])],
        ['Perth stops + Sydney', cityStops('Perth', -31.953, 115.857).concat([pl('Sydney', -33.868, 151.209)])],
        ['Madrid stops + Tenerife', cityStops('Madrid', 40.417, -3.704).concat([pl('Tenerife', 28.463, -16.252)])],
        ['Anchorage stops + Seattle', cityStops('Anchorage', 61.218, -149.900).concat([pl('Seattle', 47.606, -122.332)])],
        ['Lisbon stops + Azores', cityStops('Lisbon', 38.722, -9.139).concat([pl('Ponta Delgada', 37.741, -25.669)])],
        ['Moscow stops + Sochi', cityStops('Moscow', 55.755, 37.617).concat([pl('Sochi', 43.586, 39.723)])]
    ];
    cases.forEach(function (c) {
        assert.deepStrictEqual(geocodeOutliers(c[1]), [],
            c[0] + ': a legitimate hub-and-spoke trip must stay silent');
    });
});

test('G4: an absolute floor alone would be worthless too — real continental drives are not flagged', function () {
    /* Vladivostok is 6,099 km from the centre of a Moscow-St Petersburg-Kazan drive, well
       past the 5,000 km floor, and the trip is real. Only the ratio spares it. */
    const russia = [pl('Moscow', 55.75, 37.62), pl('St Petersburg', 59.94, 30.31),
                    pl('Kazan', 55.79, 49.12), pl('Vladivostok', 43.12, 131.89)];
    assert.deepStrictEqual(geocodeOutliers(russia), [], 'both tests must pass before anything is named');

    const transSiberian = [pl('Moscow', 55.75, 37.62), pl('Kazan', 55.79, 49.12),
        pl('Yekaterinburg', 56.84, 60.61), pl('Novosibirsk', 55.03, 82.92),
        pl('Irkutsk', 52.29, 104.28), pl('Vladivostok', 43.12, 131.89)];
    assert.deepStrictEqual(geocodeOutliers(transSiberian), []);
});

test('G4: both wrong-continent geocodes from the report are caught, at every trip size', function () {
    const texas = N_SPAIN.map(function (p) {
        return p.name === 'Leon' ? pl('Leon', 31.2715127, -95.9953382, 'Leon County, Texas, United States') : p;
    });
    const found = geocodeOutliers(texas);
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].name, 'Leon');
    assert.ok(found[0].displayName.indexOf('Texas') !== -1);

    /* The rule must not depend on the trip being long. */
    for (let n = 3; n <= N_SPAIN_BROKEN.length; n++) {
        const hit = geocodeOutliers(N_SPAIN_BROKEN.slice(0, n));
        assert.strictEqual(hit.length, 1, n + ' places: still exactly one outlier');
        assert.strictEqual(hit[0].name, 'Santillana de Mar', n + ' places');
    }
});

test('G4: two wrong places are both named, furthest first and deterministically', function () {
    const both = N_SPAIN_BROKEN.map(function (p) {
        return p.name === 'Leon' ? pl('Leon', 31.2715127, -95.9953382, 'Leon County, Texas, United States') : p;
    });
    const found = geocodeOutliers(both);
    assert.strictEqual(found.length, 2);
    assert.ok(found[0].km >= found[1].km, 'furthest first');
    assert.deepStrictEqual(found.map(function (f) { return f.name; }).slice().sort(),
        ['Leon', 'Santillana de Mar']);
    assert.deepStrictEqual(geocodeOutliers(both), found, 'same input, same output');
});

test('G4: it is pure and synchronous — no network, no clock, no storage, no mutation', function () {
    const input = N_SPAIN_BROKEN.slice();
    const snapshot = JSON.parse(JSON.stringify(input));

    const exploding = function () { throw new Error('geocodeOutliers must not reach for this'); };
    const found = geocodeOutliers(input, {
        fetchImpl: exploding, sleepImpl: exploding, now: exploding,
        storage: { getItem: exploding, setItem: exploding, removeItem: exploding }
    });

    assert.ok(Array.isArray(found), 'a plain array, not a Promise');
    assert.strictEqual(typeof found.then, 'undefined');
    assert.strictEqual(found.length, 1);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(input)), snapshot, 'the input is untouched');
});

test('G4: degenerate inputs never throw', function () {
    const one = [pl('Alone', 40, -3)];
    const two = [pl('A', 40, -3), pl('B', 22, -100)];
    const identical = [pl('A', 40, -3), pl('B', 40, -3), pl('C', 40, -3), pl('D', 40, -3)];
    const dupNames = [pl('Madrid', 40.42, -3.70), pl('Madrid', 40.42, -3.70), pl('Madrid', 40.42, -3.70)];
    const unresolved = N_SPAIN.map(function (p) {
        return { name: p.name, lat: null, lon: null, resolved: false, source: 'osm',
                 displayName: '', candidates: 0, chosenByCluster: false };
    });

    const cases = [
        ['no argument', undefined], ['null', null], ['a number', 42], ['a string', 'Madrid'],
        ['empty', []], ['one place', one], ['two places', two],
        ['identical coordinates (median spread is zero)', identical],
        ['duplicate names', dupNames], ['every place unresolved', unresolved],
        ['holes and junk', [null, undefined, 42, 'x', {}, { lat: 'abc', lon: null }, pl('Real', 40, -3)]],
        ['out-of-range coordinates', [{ lat: 9999, lon: -77777, resolved: true, name: 'Bad' },
            pl('A', 40, -3), pl('B', 41, -3), pl('C', 42, -3)]],
        ['a place with no displayName', [{ name: 'X', lat: 40, lon: -3, resolved: true },
            { name: 'Y', lat: 41, lon: -3, resolved: true }, { name: 'Z', lat: 42, lon: -3, resolved: true }]],
        ['resolved:false alongside good ones',
            [Object.assign({}, pl('Ghost', 22, -100), { resolved: false })].concat(N_SPAIN.slice(0, 4))]
    ];
    cases.forEach(function (c) {
        let out;
        assert.doesNotThrow(function () { out = geocodeOutliers(c[1]); }, c[0] + ' must not throw');
        assert.ok(Array.isArray(out), c[0] + ' returns an array');
        out.forEach(function (o) {
            assert.strictEqual(typeof o.name, 'string', c[0] + ': name');
            assert.strictEqual(typeof o.displayName, 'string', c[0] + ': displayName');
            assert.ok(Number.isFinite(o.km) && o.km >= 0, c[0] + ': km is a finite distance');
        });
    });

    assert.deepStrictEqual(geocodeOutliers(one), [], 'one place has nothing to be far from');
    assert.deepStrictEqual(geocodeOutliers(two), [],
        'two places are always equidistant from their own median — no majority to be odd from');
    assert.deepStrictEqual(geocodeOutliers(identical), [],
        'zero median spread must not divide, and must not flag');
    assert.deepStrictEqual(geocodeOutliers(dupNames), []);
    assert.deepStrictEqual(geocodeOutliers(unresolved), []);
});

test('G4: zero median spread plus one distant place still names it', function () {
    /* The complement of the case above: the spread is 0, so the tests read 0 > 0 for the
       cluster and km > 0 for the stray. Multiplication, never division. */
    const stacked = [pl('A', 40, -3), pl('B', 40, -3), pl('C', 40, -3),
                     pl('Mexico', 22.1356454, -100.9519141, 'San Luis Potosi, Mexico')];
    const found = geocodeOutliers(stacked);
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].name, 'Mexico');
    assert.ok(found[0].km > 8000);
});

test('G4: half wrong is honestly unanswerable, and says nothing rather than guessing', function () {
    /* Six in Spain and six in Mexico: the median centre is mid-Atlantic and the median
       spread is thousands of km, so no place is an outlier. There is no majority to be
       odd from, and inventing one would be exactly the failure this branch exists to
       kill. This is why displayName is mandatory rather than a fallback. */
    const split = N_SPAIN.slice(0, 6).concat([
        pl('Leon MX', 21.122, -101.683), pl('Santillana MX', 22.136, -100.952),
        pl('Merida MX', 20.967, -89.617), pl('Puebla MX', 19.041, -98.206),
        pl('Oaxaca MX', 17.062, -96.725), pl('Toluca MX', 19.292, -99.654)
    ]);
    assert.deepStrictEqual(geocodeOutliers(split), [],
        'geometry has nothing to say here, so it says nothing');
});

test('G4: thresholds are injectable, and both are load-bearing', function () {
    assert.strictEqual(geo.GEO_OUTLIER_MULTIPLE, 15);
    assert.strictEqual(geo.GEO_OUTLIER_MIN_KM, 5000);
    assert.strictEqual(geo.GEO_GEOCODE_LIMIT, 5);

    /* Dropping the floor to zero exposes the ratio alone — and the hub-and-spoke case it
       would wrongly flag, which is the evidence the floor exists on. */
    const hub = cityStops('London', 51.507, -0.128).concat([pl('Edinburgh', 55.953, -3.188)]);
    assert.deepStrictEqual(geocodeOutliers(hub), [], 'silent with the shipped floor');
    assert.strictEqual(geocodeOutliers(hub, { outlierMinKm: 0 }).length, 1,
        'and loud without it — the floor is not decoration');

    /* Likewise the multiple: without it, a real continental drive is condemned. */
    const russia = [pl('Moscow', 55.75, 37.62), pl('St Petersburg', 59.94, 30.31),
                    pl('Kazan', 55.79, 49.12), pl('Vladivostok', 43.12, 131.89)];
    assert.deepStrictEqual(geocodeOutliers(russia), []);
    assert.strictEqual(geocodeOutliers(russia, { outlierMultiple: 4 }).length, 1,
        'the multiple is load-bearing too');
});

test('G4: longitude is circular — a Pacific trip is not placed on the far side of the world', function () {
    /* A plain median of 174 and -171 is 1.5, in Africa, which would make every place in
       the trip look thousands of km from its own centre. The circle is cut at the widest
       empty gap instead, so the points form a single arc before the median is taken. */
    const pacific = [pl('Auckland', -36.85, 174.76), pl('Suva', -18.14, 178.44),
                     pl('Nadi', -17.80, 177.44), pl('Apia', -13.83, -171.77),
                     pl('Nukualofa', -21.14, -175.20)];
    assert.deepStrictEqual(geocodeOutliers(pacific), [], 'a real Pacific itinerary is coherent');

    /* And the detector still works across the antimeridian. */
    const withStray = pacific.concat([pl('Lisbon', 38.72, -9.14, 'Lisboa, Portugal')]);
    const found = geocodeOutliers(withStray);
    assert.strictEqual(found.length, 1, 'a genuine stray is still named');
    assert.strictEqual(found[0].name, 'Lisbon');
});

test('G4: end to end — the pipeline reports what it chose AND what looks wrong', async function () {
    resetGeoRateLimit();
    const out = await geocodePlaces(USER_TRIP, geoOpts({ fetchImpl: liveFetch() }));
    const strays = geocodeOutliers(out);

    assert.strictEqual(strays.length, 1, 'the Mexican village is named, and only it');
    assert.strictEqual(strays[0].name, 'Santillana de Mar');
    assert.ok(strays[0].displayName.indexOf('Mexico') !== -1, 'and the note can say what was chosen');

    /* Everything the UI needs to explain the 24,179 km plan, without deciding for him. */
    assert.strictEqual(byName(out, 'Leon').chosenByCluster, true, 'a relocation, declared');
    assert.strictEqual(byName(out, 'Finisterre').chosenByCluster, false);
    assert.ok(byName(out, 'Finisterre').displayName.indexOf('France') !== -1,
        'the Breton Finisterre is not flagged by geometry — but its label names France, ' +
        'which is the whole reason displayName is not optional');
    assert.ok(byName(out, 'Fisterra').candidates > 1, 'ambiguity is reported where it exists');
});

/* ══════════════════════════════════════════════════════════════════════════
   G5: the anchor set — round 2

   Round 1 anchored the cluster on the places that returned exactly ONE candidate,
   reasoning that a single result meant the name was unambiguous. The user's own
   case disproves that: "Santillana de Mar" returns exactly one candidate and it
   is in Mexico. The anchors were seeded with precisely the errors the mechanism
   exists to survive, and on the user's SECOND real trip that disarmed it
   completely. Reproduced live, 2026-08:

       Barcelona, Santillana de Mar, Leon, Fisterra, Lugo, Castellar del Valles
       single-result names: Santillana (MEXICO) + Castellar -> 2 anchors, below
       the minimum of 3 -> 'Leon' stayed in Leon County, TEXAS, unflagged
       geocodeOutliers() -> (nothing), because 2 of 6 were wrong

   The anchor is now the largest mutually-coherent group of first choices:
   agreement is evidence, confidence is not.
   ══════════════════════════════════════════════════════════════════════════ */

/* The user's second real trip, exactly as reported. */
const USER_TRIP_2 = ['Barcelona', 'Santillana de Mar', 'Leon', 'Fisterra', 'Lugo',
                     'Castellar del Valles'];

test('G5: the second real trip — the mechanism is no longer disarmed by its own bug', async function () {
    resetGeoRateLimit();
    const out = await geocodePlaces(USER_TRIP_2, geoOpts({ fetchImpl: liveFetch() }));

    /* Only two names return one candidate, and one of them is the Mexican village.
       That is the fact the old anchor definition could not survive. */
    const singles = out.filter(function (p) { return p.candidates === 1; });
    assert.deepStrictEqual(singles.map(function (p) { return p.name; }).slice().sort(),
        ['Castellar del Valles', 'Santillana de Mar'],
        'the single-candidate places are Castellar and the MEXICAN Santillana');
    assert.ok(singles.filter(function (p) { return p.name === 'Santillana de Mar'; })[0]
        .displayName.indexOf('Mexico') !== -1, 'one result, and it is wrong');

    /* Four Spanish places agree with each other and outvote the Mexico/Texas pair 4-2. */
    const leon = byName(out, 'Leon');
    assert.strictEqual(leon.chosenByCluster, true, "'Leon' is relocated, and it says so");
    assert.ok(leon.displayName.indexOf('Lyon') !== -1, 'off Texas: ' + leon.displayName);

    /* And with one error left instead of two, the outlier check now reaches it. */
    const strays = geocodeOutliers(out);
    assert.strictEqual(strays.length, 1, 'the Mexican village is named at last');
    assert.strictEqual(strays[0].name, 'Santillana de Mar');
    assert.ok(strays[0].km > 8000, Math.round(strays[0].km) + ' km from the rest of the trip');
    assert.ok(strays[0].displayName.indexOf('Mexico') !== -1);
});

test('G5: a confidently-wrong single result does not get to be an anchor', async function () {
    /* The direct statement of the fix. Santillana (Mexico) and Finisterre (France) each
       return exactly one candidate; under the old rule they were anchors. They are now
       simply two places that agree with nobody, and the Spanish majority carries. */
    resetGeoRateLimit();
    const out = await geocodePlaces(USER_TRIP, geoOpts({ fetchImpl: liveFetch() }));

    const mexico = byName(out, 'Santillana de Mar');
    assert.strictEqual(mexico.candidates, 1, 'one candidate — the old definition called this an anchor');
    assert.ok(mexico.displayName.indexOf('Mexico') !== -1, 'and it is 8,700 km from the trip');

    /* The centre it would have pulled towards is not where the trip ended up. */
    const leon = byName(out, 'Leon');
    assert.strictEqual(leon.chosenByCluster, true);
    assert.ok(haversineKm(leon.lat, leon.lon, mexico.lat, mexico.lon) > 8000,
        'the relocation went towards Spain, not towards the confident error');
});

test('G5: a strict plurality is required — a tie relocates nothing', async function () {
    /* Two Spanish places against two American ones is not evidence, it is a coin toss.
       Acting on it would mean the answer depended on nothing at all. */
    resetGeoRateLimit();
    const out = await geocodePlaces(['Bilbao', 'Gijon', 'Santillana de Mar', 'Leon'],
        geoOpts({ fetchImpl: liveFetch() }));

    /* groups: {Bilbao, Gijon} = 2 and {Santillana MX, Leon TX} = 2 */
    const leon = byName(out, 'Leon');
    assert.strictEqual(leon.chosenByCluster, false, 'no majority opinion, so no decision');
    assert.strictEqual(leon.lat, 31.2715127, 'the geocoder\'s own ranking stands');
    assert.ok(leon.displayName.indexOf('Texas') !== -1, 'and displayName still says where it is');

    /* One more coherent Spanish place breaks the tie, and the mechanism engages. */
    resetGeoRateLimit();
    const out2 = await geocodePlaces(['Bilbao', 'Gijon', 'Fisterra', 'Santillana de Mar', 'Leon'],
        geoOpts({ fetchImpl: liveFetch() }));
    assert.strictEqual(byName(out2, 'Leon').chosenByCluster, true, '3 against 2 is a plurality');
    assert.ok(byName(out2, 'Leon').displayName.indexOf('Lyon') !== -1);
});

test('G5: the anchor group is a CHAIN, so a long thin trip stays one group', function () {
    /* Single linkage, not a radius about a centre. Cape Town to Cairo is 7,250 km apart —
       beyond the link distance — but joined through Johannesburg and Nairobi. A radius
       rule would split every continental itinerary into pieces and then anchor on
       whichever piece happened to be biggest. Verified through the public behaviour:
       nothing in these trips is treated as an outlier, and the outlier check uses the
       same median-centre geometry the anchor does. */
    const transAfrica = [pl('Cape Town', -33.92, 18.42), pl('Johannesburg', -26.20, 28.05),
                         pl('Nairobi', -1.29, 36.82), pl('Cairo', 30.04, 31.24)];
    assert.ok(haversineKm(-33.92, 18.42, 30.04, 31.24) > 5000,
        'the two ends really are further apart than the link distance');
    assert.deepStrictEqual(geocodeOutliers(transAfrica), [], 'and the trip is still coherent');
});

test('G5: overriding the geocoder needs a real improvement, not a marginal one', async function () {
    /* The criterion is how much NEARER the trip the alternative is, not merely that it is
       nearer. Fisterra's three nodes span 14 km and Oviedo's two 2.8 km; one of each is
       always marginally closer to the centre, and acting on that would move nothing real
       while raising a flag the UI has to explain. */
    resetGeoRateLimit();
    const out = await geocodePlaces(USER_TRIP, geoOpts({ fetchImpl: liveFetch() }));

    ['Fisterra', 'Oviedo', 'Lugo', 'Santander'].forEach(function (name) {
        assert.strictEqual(byName(out, name).chosenByCluster, false, name + ': no material improvement');
        assert.strictEqual(byName(out, name).lat, LIVE[name][0][0], name + ': first answer kept');
    });

    /* Lower the bar to nothing and the marginal swaps appear — proving the criterion is
       what suppresses them, and that they were there to be suppressed. */
    resetGeoRateLimit();
    const loose = await geocodePlaces(USER_TRIP,
        geoOpts({ fetchImpl: liveFetch(), clusterMoveKm: 0 }));
    const marginal = loose.filter(function (p) { return p.chosenByCluster; })
        .map(function (p) { return p.name; });
    assert.ok(marginal.indexOf('Fisterra') !== -1 || marginal.indexOf('Oviedo') !== -1,
        'a marginal swap really was available and really was declined');
    assert.strictEqual(byName(loose, 'Leon').chosenByCluster, true, 'the real relocation survives either way');
});

/* ── The measured boundary of geocodeOutliers ── */

test('G5: geocodeOutliers holds exactly while the correct places are a strict majority', function () {
    /* Swept over the northern-Spain itinerary with w of its n places moved to Mexico.
       The boundary is the median's own defining property: all w errors are named iff
       n >= 2w + 1. Documented in the header because the round-1 wording ("when roughly
       HALF the places are wrong") was optimistic and would let someone trust this
       further than it goes — it degrades at a third. */
    const MEXICO = [[22.136, -100.952], [21.122, -101.683], [20.967, -89.617],
                    [19.041, -98.206], [17.062, -96.725], [19.292, -99.654]];
    const broken = function (n, w) {
        return N_SPAIN.slice(0, n).map(function (p, i) {
            return i < w ? pl(p.name + ' (MX)', MEXICO[i % MEXICO.length][0],
                                MEXICO[i % MEXICO.length][1], p.name + ', Mexico') : p;
        });
    };

    let inside = 0, outside = 0;
    for (let n = 3; n <= 12; n++) {
        for (let w = 1; w <= 6 && w < n; w++) {
            const found = geocodeOutliers(broken(n, w));
            const named = found.filter(function (f) { return f.name.indexOf('(MX)') !== -1; }).length;
            const accused = found.length - named;
            if (n >= 2 * w + 1) {
                inside++;
                assert.strictEqual(named, w,
                    'n=' + n + ' w=' + w + ': a strict majority is correct, so all ' + w + ' must be named');
                assert.strictEqual(accused, 0,
                    'n=' + n + ' w=' + w + ': and no CORRECT place may ever be accused inside the boundary');
            } else {
                outside++;
                assert.ok(named < w,
                    'n=' + n + ' w=' + w + ': past the boundary it cannot name them all');
            }
        }
    }
    assert.ok(inside >= 20 && outside >= 10, 'the sweep covered both sides (' + inside + '/' + outside + ')');
});

test('G5: past the boundary it names the CORRECT places — recorded, not fixed', function () {
    /* Five of seven towns geocoded to Mexico. The two real ones are now the geometric
       minority and they are what gets named. This is not a defect in the function: it
       names the minority, and when the errors are the majority the minority IS the
       correct set. There is no signal inside the function that could tell the two apart —
       "one stray among eleven" and "eleven strays among one" are the same geometry with
       different labels — and a guard on "too many places named" was tried against the
       sweep and suppresses nothing, because only one to three are named out of seven. */
    const MEXICO = [[22.136, -100.952], [21.122, -101.683], [20.967, -89.617],
                    [19.041, -98.206], [17.062, -96.725]];
    const mostlyWrong = N_SPAIN.slice(0, 7).map(function (p, i) {
        return i < 5 ? pl(p.name + ' (MX)', MEXICO[i][0], MEXICO[i][1], p.name + ', Mexico') : p;
    });
    const found = geocodeOutliers(mostlyWrong);
    assert.ok(found.length > 0 && found.every(function (f) { return f.name.indexOf('(MX)') === -1; }),
        'it names the two correct towns, because they are the minority');
    /* displayName is what the user reads, and it is the one signal that does not depend
       on the errors being outnumbered — hence its mandatory status. */
    found.forEach(function (f) { assert.ok(f.displayName.length > 0); });
});

test('G5: the majority condition is necessary, not sufficient', function () {
    /* Whether an error inside the boundary is actually named still depends on the trip's
       own spread, which is the denominator. The SAME Mexican village scores x39.6 against
       the user's tight regional itinerary and x18.8 against his Spain-wide one — both
       named, but a wider trip would not be. */
    const tight = geocodeOutliers(N_SPAIN_BROKEN);
    assert.strictEqual(tight.length, 1);

    const wide = [pl('Barcelona', 41.3825802, 2.177073), pl('Fisterra', 42.9286659, -9.2626624),
                  pl('Lugo', 43.0395266, -7.4567985), pl('Castellar del Valles', 41.6183431, 2.0879423),
                  pl('Leon', 45.7578137, 4.8320114, 'Lyon, France'),
                  pl('Santillana de Mar', 22.1356454, -100.9519141, 'San Luis Potosi, Mexico')];
    const found = geocodeOutliers(wide);
    assert.strictEqual(found.length, 1, 'still named across a Spain-wide trip');
    assert.strictEqual(found[0].name, 'Santillana de Mar');
    assert.ok(found[0].km > tight[0].km - 500 && found[0].km > 8000);
});

test('G5: the round-1 false-positive evidence is untouched', function () {
    /* The 60-itinerary corpus behind the 5,000 km floor and the x15 multiple must not
       have been weakened to buy any of the above. Spot-checked here on the three cases
       that constrain the two constants most tightly. */
    const perth = cityStops('Perth', -31.953, 115.857).concat([pl('Sydney', -33.868, 151.209)]);
    assert.deepStrictEqual(geocodeOutliers(perth), [], 'Perth-Sydney: the floor\'s lower anchor');

    const russia = [pl('Moscow', 55.75, 37.62), pl('St Petersburg', 59.94, 30.31),
                    pl('Kazan', 55.79, 49.12), pl('Vladivostok', 43.12, 131.89)];
    assert.deepStrictEqual(geocodeOutliers(russia), [], "Vladivostok: the multiple's lower anchor");

    const london = cityStops('London', 51.507, -0.128).concat([pl('Edinburgh', 55.953, -3.188)]);
    assert.deepStrictEqual(geocodeOutliers(london), [], 'hub-and-spoke: why a ratio alone is worthless');
});

/* ── G6: what a plurality is worth, and what it is not ── */

test('G6: a genuine 3-against-3 tie relocates nothing', async function () {
    /* Three Spanish places against three American ones, both groups at the anchor
       minimum. There is no majority opinion here, only a coin toss, and acting on it
       would make the answer depend on nothing at all. (The earlier tie test could not
       reach this check — its groups were of two, so the anchor floor stopped it first.)
       'Santiago' is measured live and really does resolve to Costa Rica. */
    resetGeoRateLimit();
    const names = ['Bilbao', 'Gijon', 'Fisterra', 'Santillana de Mar', 'Leon', 'Santiago'];
    const out = await geocodePlaces(names, geoOpts({ fetchImpl: liveFetch() }));

    assert.strictEqual(byName(out, 'Santiago').lat, 9.8694792, 'Santiago really is in Costa Rica');
    out.forEach(function (p) {
        assert.strictEqual(p.chosenByCluster, false,
            p.name + ': a tie is not a plurality, so nothing is decided');
    });
    assert.strictEqual(byName(out, 'Leon').lat, 31.2715127, "the geocoder's own ranking stands");

    /* One more Spanish place breaks the tie 4-3, and the mechanism engages. */
    resetGeoRateLimit();
    const broken = await geocodePlaces(names.concat(['Lugo']), geoOpts({ fetchImpl: liveFetch() }));
    assert.strictEqual(byName(broken, 'Leon').chosenByCluster, true, '4 against 3 is a plurality');
    assert.ok(byName(broken, 'Leon').displayName.indexOf('Lyon') !== -1);
});

test('G6: the tie rule is what makes the answer independent of input order', async function () {
    /* Without it, the largest group is whichever the sort happened to leave first, so a
       reordered list would answer differently — the exact failure the whole two-phase
       design exists to avoid. */
    const names = ['Bilbao', 'Gijon', 'Fisterra', 'Santillana de Mar', 'Leon', 'Santiago'];
    resetGeoRateLimit();
    const a = await geocodePlaces(names, geoOpts({ fetchImpl: liveFetch() }));
    resetGeoRateLimit();
    const b = await geocodePlaces(names.slice().reverse(), geoOpts({ fetchImpl: liveFetch() }));

    const key = function (l) {
        return l.slice().sort(function (x, y) { return x.name < y.name ? -1 : 1; })
            .map(function (p) { return p.name + '@' + p.lat + ',' + p.lon + ',' + p.chosenByCluster; });
    };
    assert.deepStrictEqual(key(a), key(b), 'the tie is resolved the same way from either end: not at all');
});

test('G6: cluster preference can recover the RIGHT place, not just a nearer wrong one', async function () {
    /* 'Guadalajara' first-resolves to Jalisco, Mexico — and the Spanish one is sitting at
       candidate [1]. This is the case the mechanism is actually good at, and it ends with
       the user's real destination and a label that confirms it. */
    resetGeoRateLimit();
    const out = await geocodePlaces(['Bilbao', 'Gijon', 'Fisterra', 'Lugo', 'Guadalajara'],
        geoOpts({ fetchImpl: liveFetch() }));

    const g = byName(out, 'Guadalajara');
    assert.strictEqual(g.candidates, 4);
    assert.strictEqual(g.chosenByCluster, true, 'relocated, and declared');
    assert.ok(g.displayName.indexOf('Castilla-La Mancha') !== -1,
        'and it is the Spanish Guadalajara: ' + g.displayName);
    assert.ok(g.lat > 40 && g.lat < 41 && g.lon > -4 && g.lon < -2, 'really in Spain');

    /* Nothing is left for the outlier check to find. */
    assert.deepStrictEqual(geocodeOutliers(out), [], 'the trip is coherent again');
});

test('G6: swapping one wrong continent for another is not an improvement', async function () {
    /* 'Santiago' offers Costa Rica, Chile, Cuba, the Dominican Republic and Brazil, and
       NOT Santiago de Compostela. Against a Spanish cluster the "nearest" is the Dominican
       Republic at ~6,600 km. Taking it would destroy a label the user could recognise
       ("Santiago, Cartago, Costa Rica"), replace it with an equally wrong one, and raise a
       flag implying something had been fixed. So nothing on offer is taken. */
    resetGeoRateLimit();
    const out = await geocodePlaces(['Bilbao', 'Gijon', 'Fisterra', 'Lugo', 'Santiago'],
        geoOpts({ fetchImpl: liveFetch() }));

    const s = byName(out, 'Santiago');
    assert.strictEqual(s.candidates, 5, 'five candidates, none of them in Spain');
    assert.strictEqual(s.chosenByCluster, false, 'no flag, because nothing was fixed');
    assert.strictEqual(s.lat, 9.8694792, 'the geocoder\'s own first answer stands');
    assert.ok(s.displayName.indexOf('Costa Rica') !== -1,
        'and the user keeps the label that tells him: ' + s.displayName);

    /* The outlier check is what carries this case, exactly as intended. */
    const strays = geocodeOutliers(out);
    assert.strictEqual(strays.length, 1);
    assert.strictEqual(strays[0].name, 'Santiago');
    assert.ok(strays[0].displayName.indexOf('Costa Rica') !== -1,
        'named, with the label that explains it');

    /* Prove the alternative really was on offer and really was declined. */
    resetGeoRateLimit();
    const loose = await geocodePlaces(['Bilbao', 'Gijon', 'Fisterra', 'Lugo', 'Santiago'],
        geoOpts({ fetchImpl: liveFetch(), clusterLinkKm: 40000 }));
    const moved = byName(loose, 'Santiago');
    assert.strictEqual(moved.chosenByCluster, true, 'without the rule it is relocated...');
    assert.ok(moved.displayName.indexOf('Dominicana') !== -1,
        '...to the Dominican Republic, which helps nobody: ' + moved.displayName);
});
