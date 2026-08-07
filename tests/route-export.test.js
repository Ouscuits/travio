/* ── Tests for js/route-export.js ──
   Node built-in runner, no dependencies:  node --test tests/*.test.js

   The three requirements that were MEASURED against a real engine plan, and
   that a naive implementation silently fails:

     X1  ICS line folding is at 75 OCTETS, not characters (RFC 5545 §3.1).
         Accented place names make those two different: folding by characters
         produced an out-of-spec line. Multi-byte characters must never be
         split, and a continuation line's leading space costs one of its 75.
     X2  Escaping is PER FORMAT and both are needed. GPX takes XML escaping
         (& < > " '), ICS takes its own (\ ; , newline). The four names below
         are ordinary in this project and each one breaks its format raw.
     X3  The trip date is a PARAMETER. Never Date.now(): DTSTART/DTSTAMP need a
         date, and reading the clock would make the module impure and these
         tests non-deterministic.

   Plus the project's standing correctness bar:
     X4  degenerate inputs must not throw (0 stops, 1 day, rest day with 0 km,
         unresolved places with null coordinates, duplicate names, no geometry);
     X5  never export a number the app does not know — an unknown toll must not
         become a zero, a floor must not become a total, and a plan whose
         distances the engine declared unusable exports no distances;
     X6  determinism — same input, same output, byte for byte. */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const X = require(path.join(__dirname, '..', 'js', 'route-export.js'));
const engine = require(path.join(__dirname, '..', 'js', 'route-engine.js'));

/* ── Fixtures ────────────────────────────────────────────────────────────────
   The four real names from this project, one per breakable character class. */
function P(name, lat, lon, extra) {
    const p = { name: name, lat: lat, lon: lon, resolved: true, source: 'osm' };
    if (extra) for (const k in extra) p[k] = extra[k];
    return p;
}

const AMP   = P('Sant Joan Despí & Cornellà', 41.3583, 2.0578);          /* XML entity     */
const ANGLE = P("L'Hospitalet <centre>", 41.3596, 2.0999);               /* XML tag + apos */
const QUOTE = P('Zaragoza "La Seo"', 41.6560, -0.8760);                  /* XML attribute  */
const SEMI  = P('Valencia; Ciutat Vella', 39.4750, -0.3770);             /* ICS separator  */

const MADRID    = P('Madrid', 40.4168, -3.7038);
const BARCELONA = P('Barcelona', 41.3851, 2.1734);
const ZARAGOZA  = P('Zaragoza', 41.6488, -0.8891);

/* A long accented pair: its SUMMARY line is longer than 75 octets AND longer
   than 75 characters, which is what makes the two folding rules diverge.
   They are ~100 km apart on purpose — inside the engine's 5 km round-trip
   radius (R3) the two would be read as the same place and the day would come
   back as a rest day with no arrow in its title. */
const LONG_A = P('Sant Joan Despí i Cornellà de Llobregat', 41.3583, 2.0578);
const LONG_B = P("L'Hospitalet de l'Infant", 41.0119, 0.9282);

function planFor(start, end, stops, days, opts) {
    const o = opts || {};
    const places = [start].concat(stops, end ? [end] : []);
    const matrix = engine.haversineMatrix(places);
    return engine.planRoute({
        start: start, end: end, stops: stops, matrix: matrix,
        days: days,
        departureTime: o.departureTime === undefined ? '09:00' : o.departureTime,
        maxDriveMinPerDay: o.maxDriveMinPerDay || 360
    });
}

const TRICKY_PLAN = planFor(AMP, SEMI, [ANGLE, QUOTE], 3);
const LONG_PLAN   = planFor(LONG_A, LONG_B, [], 1);
const SIMPLE_PLAN = planFor(MADRID, BARCELONA, [ZARAGOZA], 2);

/* Hand-built plans for the degenerate shapes the engine cannot be coaxed into
   producing (null coordinates, malformed day records). */
function leg(from, to, km, min) { return { from: from, to: to, km: km, min: min }; }
function day(n, legs, extra) {
    const legList = legs || [];
    let km = 0, min = 0;
    for (let i = 0; i < legList.length; i++) { km += legList[i].km; min += legList[i].min; }
    const d = {
        day: n, legs: legList, stops: legList.map(function (l) { return l.to; }),
        km: km, driveMin: min,
        startPlace: legList.length ? legList[0].from : null,
        endPlace: legList.length ? legList[legList.length - 1].to : null,
        overDriveCap: false, startTime: null, endTime: null
    };
    if (extra) for (const k in extra) d[k] = extra[k];
    return d;
}
function mkPlan(days, extra) {
    let km = 0, min = 0;
    for (let i = 0; i < days.length; i++) { km += days[i].km; min += days[i].driveMin; }
    const p = {
        days: days, order: [], totalKm: km, totalMin: min,
        roundTrip: false, warnings: []
    };
    if (extra) for (const k in extra) p[k] = extra[k];
    return p;
}

/* ── A dependency-free XML well-formedness checker ───────────────────────────
   Stack-based: every open tag must be closed by its own name in order, there
   must be exactly one root, every `&` must open a legal entity, and no raw `<`
   may survive inside text or an attribute value. That is precisely the set of
   mistakes unescaped place names make. */
function parseXml(src) {
    const stack = [];
    let root = null;
    let i = 0;

    function checkEntities(text, where) {
        const re = /&([^;\s]*);?/g;
        let m;
        while ((m = re.exec(text)) !== null) {
            const body = m[1];
            const ok = /^(amp|lt|gt|quot|apos)$/.test(body) ||
                /^#\d+$/.test(body) || /^#x[0-9a-fA-F]+$/.test(body);
            if (!ok || text.charAt(m.index + m[0].length - 1) !== ';') {
                throw new Error('bad entity "&' + body + '" in ' + where);
            }
        }
    }

    function parseAttrs(raw, tag) {
        const attrs = {};
        const re = /([A-Za-z_:][\w.:-]*)\s*=\s*"([^"]*)"/g;
        let m, consumed = '';
        while ((m = re.exec(raw)) !== null) {
            if (m[2].indexOf('<') >= 0) throw new Error('raw < in attribute of <' + tag + '>');
            checkEntities(m[2], 'attribute ' + m[1]);
            attrs[m[1]] = m[2];
            consumed += m[0];
        }
        const leftover = raw.replace(/([A-Za-z_:][\w.:-]*)\s*=\s*"([^"]*)"/g, '').trim();
        if (leftover) throw new Error('unparsed attribute text in <' + tag + '>: ' + leftover);
        return attrs;
    }

    while (i < src.length) {
        const lt = src.indexOf('<', i);
        const text = lt < 0 ? src.slice(i) : src.slice(i, lt);
        if (text) {
            checkEntities(text, 'text');
            if (stack.length) stack[stack.length - 1].text += text;
            else if (text.trim()) throw new Error('text outside root: ' + text.trim());
        }
        if (lt < 0) break;
        const gt = src.indexOf('>', lt);
        if (gt < 0) throw new Error('unterminated tag');
        let raw = src.slice(lt + 1, gt);
        i = gt + 1;
        if (raw.charAt(0) === '?' || raw.charAt(0) === '!') continue;
        if (raw.charAt(0) === '/') {
            const name = raw.slice(1).trim();
            const top = stack.pop();
            if (!top) throw new Error('close tag </' + name + '> with empty stack');
            if (top.name !== name) throw new Error('expected </' + top.name + '>, got </' + name + '>');
            continue;
        }
        const selfClose = raw.charAt(raw.length - 1) === '/';
        if (selfClose) raw = raw.slice(0, -1);
        const m = /^([A-Za-z_:][\w.:-]*)([\s\S]*)$/.exec(raw);
        if (!m) throw new Error('malformed tag: <' + raw + '>');
        const node = { name: m[1], attrs: parseAttrs(m[2], m[1]), children: [], text: '' };
        if (stack.length) stack[stack.length - 1].children.push(node);
        else if (root) throw new Error('second root element <' + node.name + '>');
        else root = node;
        if (!selfClose) stack.push(node);
    }
    if (stack.length) throw new Error('unclosed <' + stack[stack.length - 1].name + '>');
    if (!root) throw new Error('no root element');
    return root;
}

function findAll(node, name, out) {
    const acc = out || [];
    if (node.name === name) acc.push(node);
    for (let i = 0; i < node.children.length; i++) findAll(node.children[i], name, acc);
    return acc;
}
function childText(node, name) {
    for (let i = 0; i < node.children.length; i++) {
        if (node.children[i].name === name) return node.children[i].text;
    }
    return null;
}

/* ── ICS reading helpers ── */
function icsLines(text) {
    const unfolded = X.unfoldIcs(text);
    const lines = unfolded.split('\r\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines;
}
/* Properties of the VEVENTs only. DESCRIPTION exists at both calendar and
   event level (RFC 7986), so an unscoped reader silently returns the wrong
   one. */
function icsProp(text, name) { return propsIn(text, name, true); }
/* Properties of the calendar header, outside every VEVENT. */
function icsCalProp(text, name) { return propsIn(text, name, false); }

function propsIn(text, name, insideEvent) {
    const out = [];
    const lines = icsLines(text);
    let depth = 0;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i] === 'BEGIN:VEVENT') { depth++; continue; }
        if (lines[i] === 'END:VEVENT') { depth--; continue; }
        if ((depth > 0) !== insideEvent) continue;
        if (lines[i].indexOf(name + ':') === 0 || lines[i].indexOf(name + ';') === 0) {
            out.push(lines[i].slice(lines[i].indexOf(':') + 1));
        }
    }
    return out;
}
function physicalLines(text) {
    const l = text.split('\r\n');
    if (l.length && l[l.length - 1] === '') l.pop();
    return l;
}

/* ════════════════════════════════════════════════════════════════════════════
   X1 — ICS line folding at 75 OCTETS
   ════════════════════════════════════════════════════════════════════════════ */

test('X1 utf8Length counts octets, not characters', function () {
    assert.strictEqual(X.utf8Length('abc'), 3);
    assert.strictEqual(X.utf8Length('Despí'), 6);          /* í is 2 octets   */
    assert.strictEqual(X.utf8Length('→'), 3);              /* arrow is 3      */
    assert.strictEqual(X.utf8Length('😀'), 4);             /* astral is 4     */
    assert.strictEqual('😀'.length, 2);                    /* but 2 UTF-16 units */
    assert.strictEqual(X.utf8Length(''), 0);
    assert.strictEqual(X.utf8Length(null), 0);
});

test('X1 a line of 75 octets or fewer is not folded at all', function () {
    const line = 'SUMMARY:' + 'a'.repeat(67);
    assert.strictEqual(X.utf8Length(line), 75);
    assert.strictEqual(X.foldIcsLine(line), line);
    assert.ok(line.indexOf('\r\n') < 0);
});

test('X1 76 octets folds into exactly two physical lines', function () {
    const line = 'SUMMARY:' + 'a'.repeat(68);
    assert.strictEqual(X.utf8Length(line), 76);
    const folded = X.foldIcsLine(line);
    const parts = folded.split('\r\n');
    assert.strictEqual(parts.length, 2);
    assert.strictEqual(X.utf8Length(parts[0]), 75);
    assert.strictEqual(parts[1].charAt(0), ' ');
});

test('X1 every physical line of a folded value is <= 75 octets', function () {
    const line = 'DESCRIPTION:' + 'Ciutat Vella à Cornellà '.repeat(24);
    const folded = X.foldIcsLine(line);
    const parts = folded.split('\r\n');
    assert.ok(parts.length > 4, 'expected several fold segments, got ' + parts.length);
    for (let i = 0; i < parts.length; i++) {
        assert.ok(X.utf8Length(parts[i]) <= 75,
            'segment ' + i + ' is ' + X.utf8Length(parts[i]) + ' octets: ' + parts[i]);
    }
});

test('X1 continuation lines budget 74 content octets, because the space costs one', function () {
    const line = 'X:' + 'x'.repeat(300);
    const parts = X.foldIcsLine(line).split('\r\n');
    assert.strictEqual(X.utf8Length(parts[0]), 75);
    for (let i = 1; i < parts.length - 1; i++) {
        assert.strictEqual(parts[i].charAt(0), ' ');
        assert.strictEqual(X.utf8Length(parts[i]), 75, 'continuation must total 75 with its space');
        assert.strictEqual(X.utf8Length(parts[i].slice(1)), 74, 'content budget is 74');
    }
});

test('X1 folding never splits a multi-byte character', function () {
    /* All 3-octet characters: 75 is not a multiple of 3, so a byte-blind cut
       would land inside a character on the very first fold. */
    const line = 'SUMMARY:' + '→'.repeat(80);
    const folded = X.foldIcsLine(line);
    assert.ok(folded.indexOf('�') < 0);
    const parts = folded.split('\r\n');
    for (let i = 0; i < parts.length; i++) {
        const body = i === 0 ? parts[i] : parts[i].slice(1);
        const stripped = i === 0 ? body.slice('SUMMARY:'.length) : body;
        assert.ok(X.utf8Length(stripped) % 3 === 0,
            'segment ' + i + ' cut inside a 3-octet character');
        assert.ok(X.utf8Length(parts[i]) <= 75);
    }
    assert.strictEqual(X.unfoldIcs(folded), line);
});

test('X1 the folded SUMMARY of accented place names round-trips exactly', function () {
    const ics = X.buildIcs({ plan: LONG_PLAN, startDate: '2026-08-14' });
    const summary = icsProp(ics, 'SUMMARY')[0];
    assert.strictEqual(summary,
        "Day 1: Sant Joan Despí i Cornellà de Llobregat → L'Hospitalet de l'Infant");

    /* the raw file really did fold it */
    const raw = physicalLines(ics);
    let first = -1;
    for (let i = 0; i < raw.length; i++) if (raw[i].indexOf('SUMMARY:') === 0) { first = i; break; }
    assert.ok(first >= 0, 'no SUMMARY line');
    assert.ok(raw[first + 1].charAt(0) === ' ', 'SUMMARY was not folded');
    assert.ok(X.utf8Length(raw[first]) <= 75);

    /* unfolding restores the original octets, byte for byte */
    assert.strictEqual(X.unfoldIcs(raw[first] + '\r\n' + raw[first + 1]),
        'SUMMARY:' + summary);
});

test('X1 character-based folding of that same line WOULD have exceeded 75 octets', function () {
    const ics = X.buildIcs({ plan: LONG_PLAN, startDate: '2026-08-14' });
    const logical = 'SUMMARY:' + icsProp(ics, 'SUMMARY')[0];

    /* the naive implementation: cut at 75 CHARACTERS */
    const naive = logical.slice(0, 75);
    assert.strictEqual(naive.length, 75);
    assert.ok(X.utf8Length(naive) > 75,
        'fixture is not discriminating: naive cut is ' + X.utf8Length(naive) + ' octets');
    assert.strictEqual(X.utf8Length(naive), 79);

    /* what this module actually emits */
    const ours = physicalLines(ics).filter(function (l) { return l.indexOf('SUMMARY:') === 0; })[0];
    assert.ok(X.utf8Length(ours) <= 75);
    assert.ok(ours.length < 75, 'the octet-correct cut is necessarily earlier than 75 chars');
});

test('X1 a lone trailing backslash is carried to the next segment, never split from its pair', function () {
    const line = 'DESCRIPTION:' + 'a'.repeat(62) + '\\n' + 'b'.repeat(40);
    const parts = X.foldIcsLine(line).split('\r\n');
    for (let i = 0; i < parts.length; i++) {
        const body = i === 0 ? parts[i] : parts[i].slice(1);
        let trailing = 0;
        for (let k = body.length - 1; k >= 0 && body.charAt(k) === '\\'; k--) trailing++;
        assert.strictEqual(trailing % 2, 0, 'segment ' + i + ' ends on half an escape pair');
    }
    assert.strictEqual(X.unfoldIcs(X.foldIcsLine(line)), line);
});

test('X1 folding is exposed and stable for an empty or null line', function () {
    assert.strictEqual(X.foldIcsLine(''), '');
    assert.strictEqual(X.foldIcsLine(null), '');
    assert.strictEqual(X.FOLD_LIMIT, 75);
});

test('X1 every physical line in a real export is within the limit and unfolds cleanly', function () {
    const ics = X.buildIcs({
        plan: TRICKY_PLAN, startDate: '2026-08-14',
        enrichment: {
            days: [{
                present: true,
                activities: ['Passeig per la Rambla del Poblenou i el Parc de la Ciutadella amb parada al Mercat'],
                lodging: 'Hostal a Cornellà de Llobregat, a prop de l\'estació',
                tip: 'Compra el bitllet de rodalies abans de pujar; a l\'estació hi ha cua'
            }, { present: false, activities: [] }, { present: false, activities: [] }]
        }
    });
    const raw = physicalLines(ics);
    for (let i = 0; i < raw.length; i++) {
        assert.ok(X.utf8Length(raw[i]) <= 75,
            'line ' + i + ' is ' + X.utf8Length(raw[i]) + ' octets: ' + raw[i]);
    }
    /* and the logical lines all still parse as PROP:value */
    const logical = icsLines(ics);
    for (let i = 0; i < logical.length; i++) {
        assert.ok(/^[A-Za-z-]+[;:]/.test(logical[i]), 'unfolded into a non-property line: ' + logical[i]);
    }
});

/* ════════════════════════════════════════════════════════════════════════════
   X2 — escaping, per format
   ════════════════════════════════════════════════════════════════════════════ */

test('X2 escapeXml handles all five XML characters', function () {
    assert.strictEqual(X.escapeXml('a & b'), 'a &amp; b');
    assert.strictEqual(X.escapeXml('<t>'), '&lt;t&gt;');
    assert.strictEqual(X.escapeXml('"q"'), '&quot;q&quot;');
    assert.strictEqual(X.escapeXml("l'h"), 'l&#39;h');
    assert.strictEqual(X.escapeXml('&amp;'), '&amp;amp;', 'ampersand must be escaped first');
    assert.strictEqual(X.escapeXml(null), '');
});

test('X2 escapeIcs handles backslash, semicolon, comma and newline — and NOT colon', function () {
    assert.strictEqual(X.escapeIcs('a\\b'), 'a\\\\b');
    assert.strictEqual(X.escapeIcs('Valencia; Ciutat Vella'), 'Valencia\\; Ciutat Vella');
    assert.strictEqual(X.escapeIcs('a, b'), 'a\\, b');
    assert.strictEqual(X.escapeIcs('a\nb'), 'a\\nb');
    assert.strictEqual(X.escapeIcs('a\r\nb'), 'a\\nb');
    assert.strictEqual(X.escapeIcs('12:00'), '12:00', 'RFC 5545 does not escape COLON in TEXT');
    assert.strictEqual(X.escapeIcs('a\\;b'), 'a\\\\\\;b', 'backslash escaped before semicolon');
});

test('X2 the two escapers are genuinely different — neither covers the other', function () {
    const name = 'Sant Joan Despí & Cornellà; "La Seo" <x>';
    const xml = X.escapeXml(name);
    const ics = X.escapeIcs(name);
    assert.notStrictEqual(xml, ics);
    assert.ok(xml.indexOf('&amp;') >= 0 && xml.indexOf(';') >= 0, 'XML does not escape semicolons');
    assert.ok(ics.indexOf('\\;') >= 0 && ics.indexOf('&') >= 0, 'ICS does not escape ampersands');
});

test('X2 GPX with all four breaking names is well-formed', function () {
    const gpx = X.buildGpx({ plan: TRICKY_PLAN });
    const root = parseXml(gpx);           /* throws on any imbalance/bad entity */
    assert.strictEqual(root.name, 'gpx');
    assert.strictEqual(root.attrs.version, '1.1');
    assert.ok(gpx.indexOf('Despí & Cornellà') < 0, 'raw ampersand leaked into the XML');
    assert.ok(gpx.indexOf('<centre>') < 0, 'raw angle brackets leaked into the XML');
});

test('X2 each breaking name survives GPX escaping and decodes back to itself', function () {
    const gpx = X.buildGpx({ plan: TRICKY_PLAN });
    const root = parseXml(gpx);
    const names = findAll(root, 'wpt').map(function (w) { return decodeXml(childText(w, 'name')); });
    assert.ok(names.indexOf('Sant Joan Despí & Cornellà') >= 0);
    assert.ok(names.indexOf("L'Hospitalet <centre>") >= 0);
    assert.ok(names.indexOf('Zaragoza "La Seo"') >= 0);
    assert.ok(names.indexOf('Valencia; Ciutat Vella') >= 0);
});

function decodeXml(s) {
    return String(s === null || s === undefined ? '' : s)
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');
}
function decodeIcs(s) {
    let out = '';
    const v = String(s === null || s === undefined ? '' : s);
    for (let i = 0; i < v.length; i++) {
        if (v.charAt(i) === '\\' && i + 1 < v.length) {
            const n = v.charAt(++i);
            out += n === 'n' || n === 'N' ? '\n' : n;
        } else out += v.charAt(i);
    }
    return out;
}

test('X2 each breaking name survives ICS escaping and decodes back to itself', function () {
    const ics = X.buildIcs({ plan: TRICKY_PLAN, startDate: '2026-08-14' });
    const summaries = icsProp(ics, 'SUMMARY').map(decodeIcs).join(' | ');
    assert.ok(summaries.indexOf('Sant Joan Despí & Cornellà') >= 0);
    assert.ok(summaries.indexOf("L'Hospitalet <centre>") >= 0);
    assert.ok(summaries.indexOf('Zaragoza "La Seo"') >= 0);
    const locations = icsProp(ics, 'LOCATION').map(decodeIcs);
    assert.ok(locations.indexOf('Valencia; Ciutat Vella') >= 0);
    /* the raw file must carry the escaped form, not the bare semicolon */
    assert.ok(ics.indexOf('Valencia\\; Ciutat Vella') >= 0);
    assert.ok(ics.indexOf('LOCATION:Valencia; Ciutat Vella') < 0);
});

test('X2 a semicolon in a name cannot be mistaken for a property parameter', function () {
    const plan = mkPlan([day(1, [leg(P('A;VALUE=DATE', 1, 1), P('B', 2, 2), 10, 10)])]);
    const ics = X.buildIcs({ plan: plan, startDate: '2026-01-01' });
    const lines = icsLines(ics);
    let found = false;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].indexOf('SUMMARY:') === 0) {
            found = true;
            assert.ok(lines[i].indexOf('A\\;VALUE=DATE') >= 0);
        }
    }
    assert.ok(found);
    /* DTSTART is timed-or-date, never both, and never poisoned by a name */
    assert.strictEqual(icsProp(ics, 'DTSTART').length, 1);
});

test('X2 control characters are stripped rather than emitted raw', function () {
    const dirty = 'a bc';
    assert.strictEqual(X.escapeXml(dirty), 'abc');
    assert.strictEqual(X.escapeIcs(dirty), 'abc');
    assert.strictEqual(X.escapeHtml('x\ny'), 'x\ny', 'HTML keeps newlines for <pre>');
    assert.strictEqual(X.escapeXml('x\ny'), 'xy', 'GPX values are single-line');
});

/* ════════════════════════════════════════════════════════════════════════════
   GPX structure and well-formedness
   ════════════════════════════════════════════════════════════════════════════ */

test('GPX declares version 1.1, the namespace and a creator', function () {
    const root = parseXml(X.buildGpx({ plan: SIMPLE_PLAN }));
    assert.strictEqual(root.attrs.version, '1.1');
    assert.strictEqual(root.attrs.xmlns, 'http://www.topografix.com/GPX/1/1');
    assert.ok(root.attrs.creator.length > 0);
    assert.ok(root.attrs['xsi:schemaLocation'].indexOf('gpx.xsd') > 0);
});

test('GPX child order follows the schema: metadata, wpt*, rte*, trk*', function () {
    const geometry = [[[40.4, -3.7], [41.0, -2.0], [41.6, -0.9]], [[41.6, -0.9], [41.4, 2.2]]];
    const root = parseXml(X.buildGpx({ plan: SIMPLE_PLAN, geometry: geometry }));
    const order = root.children.map(function (c) { return c.name; });
    const rank = { metadata: 0, wpt: 1, rte: 2, trk: 3 };
    let last = -1;
    for (let i = 0; i < order.length; i++) {
        const r = rank[order[i]];
        assert.notStrictEqual(r, undefined, 'unexpected child <' + order[i] + '>');
        assert.ok(r >= last, 'out-of-schema order at <' + order[i] + '>');
        last = r;
    }
    assert.strictEqual(order[0], 'metadata');
});

test('GPX emits one waypoint per distinct place, deduplicated', function () {
    const root = parseXml(X.buildGpx({ plan: SIMPLE_PLAN }));
    const wpts = findAll(root, 'wpt');
    assert.strictEqual(wpts.length, 3);
    const names = wpts.map(function (w) { return childText(w, 'name'); });
    assert.deepStrictEqual(names.slice().sort(), ['Barcelona', 'Madrid', 'Zaragoza']);
});

test('GPX round trip does not duplicate the origin waypoint but keeps both route legs', function () {
    const plan = planFor(MADRID, MADRID, [ZARAGOZA, BARCELONA], 3);
    assert.strictEqual(plan.roundTrip, true);
    const root = parseXml(X.buildGpx({ plan: plan }));
    const names = findAll(root, 'wpt').map(function (w) { return childText(w, 'name'); });
    let madrid = 0;
    for (let i = 0; i < names.length; i++) if (names[i] === 'Madrid') madrid++;
    assert.strictEqual(madrid, 1, 'the same coordinates must not produce two pins');
    const rtepts = findAll(root, 'rtept').map(function (r) { return childText(r, 'name'); });
    let madridStops = 0;
    for (let i = 0; i < rtepts.length; i++) if (rtepts[i] === 'Madrid') madridStops++;
    assert.strictEqual(madridStops, 2, 'the route still departs from and returns to Madrid');
});

test('GPX waypoint descriptions name the day and the role', function () {
    const root = parseXml(X.buildGpx({ plan: SIMPLE_PLAN }));
    const wpts = findAll(root, 'wpt');
    const byName = {};
    for (let i = 0; i < wpts.length; i++) byName[childText(wpts[i], 'name')] = childText(wpts[i], 'desc');
    assert.strictEqual(byName.Madrid, 'Day 1: Start');
    assert.strictEqual(byName.Zaragoza, 'Day 1: Overnight');
    assert.strictEqual(byName.Barcelona, 'Day 2: End');
});

test('GPX emits one <rte> per driving day, numbered, in day order', function () {
    const root = parseXml(X.buildGpx({ plan: SIMPLE_PLAN }));
    const rtes = findAll(root, 'rte');
    assert.strictEqual(rtes.length, 2);
    assert.strictEqual(childText(rtes[0], 'number'), '1');
    assert.strictEqual(childText(rtes[1], 'number'), '2');
    assert.ok(childText(rtes[0], 'name').indexOf('Day 1') === 0);
    assert.ok(childText(rtes[1], 'name').indexOf('Day 2') === 0);
});

test('GPX <rte> says out loud that the straight lines are not the road', function () {
    const root = parseXml(X.buildGpx({ plan: SIMPLE_PLAN }));
    const desc = childText(findAll(root, 'rte')[0], 'desc');
    assert.ok(desc.indexOf('NOT the road route') > 0, desc);
});

test('GPX coordinates are trimmed to 6 decimals with no -0', function () {
    assert.strictEqual(X.coord(41.3583), '41.3583');
    assert.strictEqual(X.coord(41), '41');
    assert.strictEqual(X.coord(0), '0');
    assert.strictEqual(X.coord(-0), '0');
    assert.strictEqual(X.coord(-0.0000001), '0');
    assert.strictEqual(X.coord(-3.70379999), '-3.7038');
    assert.strictEqual(X.coord(1 / 3), '0.333333');
});

test('GPX coordinate attributes parse back to the place coordinates', function () {
    const root = parseXml(X.buildGpx({ plan: SIMPLE_PLAN }));
    const wpts = findAll(root, 'wpt');
    for (let i = 0; i < wpts.length; i++) {
        const lat = Number(wpts[i].attrs.lat), lon = Number(wpts[i].attrs.lon);
        assert.ok(isFinite(lat) && lat >= -90 && lat <= 90);
        assert.ok(isFinite(lon) && lon >= -180 && lon <= 180);
    }
});

/* ── the per-day track decision ── */

test('GPX emits NO <trk> when there is no geometry — a straight line is not a road', function () {
    const root = parseXml(X.buildGpx({ plan: SIMPLE_PLAN }));
    assert.strictEqual(findAll(root, 'trk').length, 0);
    assert.ok(findAll(root, 'rte').length > 0, 'the plan is still exported, as a route');
});

test('GPX emits one <trk> per day when per-day geometry is supplied', function () {
    const geometry = [
        [[40.4168, -3.7038], [41.0, -2.0], [41.6488, -0.8891]],
        [[41.6488, -0.8891], [41.5, 0.5], [41.3851, 2.1734]]
    ];
    const root = parseXml(X.buildGpx({ plan: SIMPLE_PLAN, geometry: geometry }));
    const trks = findAll(root, 'trk');
    assert.strictEqual(trks.length, 2);
    assert.strictEqual(findAll(trks[0], 'trkpt').length, 3);
    assert.ok(childText(trks[0], 'name').indexOf('Day 1') === 0);
    assert.ok(childText(trks[0], 'desc').indexOf('road geometry') > 0);
    assert.strictEqual(findAll(root, 'trkseg').length, 2, 'one segment per track');
});

test('GPX accepts the { days: [...] } geometry wrapper', function () {
    const geometry = { days: [[[40.4, -3.7], [41.6, -0.9]], [[41.6, -0.9], [41.4, 2.2]]] };
    const root = parseXml(X.buildGpx({ plan: SIMPLE_PLAN, geometry: geometry }));
    assert.strictEqual(findAll(root, 'trk').length, 2);
});

test('GPX accepts {lat,lon} and {lat,lng} points', function () {
    const geometry = [
        [{ lat: 40.4, lon: -3.7 }, { lat: 41.6, lon: -0.9 }],
        [{ lat: 41.6, lng: -0.9 }, { lat: 41.4, lng: 2.2 }]
    ];
    const root = parseXml(X.buildGpx({ plan: SIMPLE_PLAN, geometry: geometry }));
    assert.strictEqual(findAll(root, 'trkpt').length, 4);
});

test('GPX degrades to a single whole-trip <trk> when only a flat polyline is given', function () {
    const flat = [[40.4168, -3.7038], [41.0, -2.0], [41.6488, -0.8891], [41.3851, 2.1734]];
    const root = parseXml(X.buildGpx({ plan: SIMPLE_PLAN, geometry: flat }));
    const trks = findAll(root, 'trk');
    assert.strictEqual(trks.length, 1);
    assert.strictEqual(findAll(trks[0], 'trkpt').length, 4);
    assert.strictEqual(findAll(root, 'rte').length, 2, 'day structure is still carried by the routes');
});

test('GPX degrades to no track for a day whose geometry is missing or too short', function () {
    const geometry = [[[40.4, -3.7], [41.6, -0.9]], null];
    const root = parseXml(X.buildGpx({ plan: SIMPLE_PLAN, geometry: geometry }));
    assert.strictEqual(findAll(root, 'trk').length, 1);
    const oneShort = [[[40.4, -3.7]], [[41.6, -0.9], [41.4, 2.2]]];
    const root2 = parseXml(X.buildGpx({ plan: SIMPLE_PLAN, geometry: oneShort }));
    assert.strictEqual(findAll(root2, 'trk').length, 1, 'a single point is not a track');
});

test('GPX ignores junk geometry instead of throwing', function () {
    const junk = ['nonsense', 42, {}, [], [[NaN, NaN]], { days: 'no' }, { path: 7 }];
    for (let i = 0; i < junk.length; i++) {
        const gpx = X.buildGpx({ plan: SIMPLE_PLAN, geometry: junk[i] });
        const root = parseXml(gpx);
        assert.strictEqual(findAll(root, 'trk').length, 0, 'junk #' + i + ' produced a track');
    }
});

test('S4 a path with an unreadable point is REJECTED, never silently shortened', function () {
    /* Dropping the bad point leaves a shorter, entirely plausible track that
       asserts a road between two places the line never joined. */
    const geometry = [[[40.4, -3.7], [999, 0], [41.6, -0.9]], null];
    const root = parseXml(X.buildGpx({ plan: SIMPLE_PLAN, geometry: geometry }));
    assert.strictEqual(findAll(root, 'trkpt').length, 0, 'a mangled path became a track');
    assert.strictEqual(findAll(root, 'trk').length, 0);
    assert.strictEqual(findAll(root, 'rte').length, 2, 'the plan is still exported as routes');

    const kinds = [
        [[40.4, -3.7], [91, 0], [41.6, -0.9]],          /* latitude out of range */
        [[40.4, -3.7], [40, 181], [41.6, -0.9]],        /* longitude out of range */
        [[40.4, -3.7], [NaN, NaN], [41.6, -0.9]],
        [[40.4, -3.7], null, [41.6, -0.9]],
        [[40.4, -3.7], [40.5], [41.6, -0.9]],           /* one-element point */
        [[40.4, -3.7], 'x', [41.6, -0.9]]
    ];
    for (let i = 0; i < kinds.length; i++) {
        assert.strictEqual(X.normaliseGeometry(kinds[i]).trip, null, 'kind ' + i + ' was accepted');
        assert.strictEqual(X.normaliseGeometry([kinds[i]]).days, null, 'kind ' + i + ' as a day path');
    }
    /* an intact path of the same shape is still accepted, so this is not a
       blanket refusal */
    assert.strictEqual(X.normaliseGeometry([[40.4, -3.7], [41, -2], [41.6, -0.9]]).trip.length, 3);
});

/* js/route-map.js is a sibling that may or may not exist yet; this module must
   not depend on it, so the interop check skips itself when it is absent. */
let MAP = null;
try { MAP = require(path.join(__dirname, '..', 'js', 'route-map.js')); } catch (e) { MAP = null; }

test('GPX consumes the per-day simplified paths js/route-map.js produces', { skip: !MAP }, function () {
    const road = [];
    for (let i = 0; i <= 400; i++) {
        const t = i / 400;
        road.push([40.4168 + (41.3851 - 40.4168) * t + Math.sin(i / 7) * 0.02,
            -3.7038 + (2.1734 + 3.7038) * t + Math.cos(i / 5) * 0.02]);
    }
    const view = MAP.buildMapView({ plan: SIMPLE_PLAN, geometry: road });
    assert.ok(view.days.length === 2 && view.days[0].points.length >= 2);

    /* the whole view object: its `days` carry `.points` */
    const root = parseXml(X.buildGpx({ plan: SIMPLE_PLAN, geometry: view }));
    const trks = findAll(root, 'trk');
    assert.strictEqual(trks.length, 2, 'one track per day, following the road');
    assert.strictEqual(findAll(trks[0], 'trkpt').length, view.days[0].points.length);

    /* and the flat persisted line degrades to one whole-trip track */
    const flat = parseXml(X.buildGpx({ plan: SIMPLE_PLAN, geometry: view.geometry }));
    assert.strictEqual(findAll(flat, 'trk').length, 1);
    assert.strictEqual(findAll(flat, 'trkpt').length, view.geometry.length);

    /* a road track has more points than the two-stop straight line it replaces */
    assert.ok(view.days[0].points.length > 2);
});

test('GPX never mistakes projected screen units for degrees', function () {
    /* route-map.js day objects carry `points` in lat/lon AND `path` in viewBox
       units; exporting the latter would write pixels into a GPX file. */
    const dayObj = { points: [[41.5, 2.1], [40.4, -3.7]], path: [[400, 300], [500, 320]] };
    const root = parseXml(X.buildGpx({ plan: SIMPLE_PLAN, geometry: [dayObj] }));
    const pts = findAll(root, 'trkpt');
    assert.strictEqual(pts.length, 2);
    assert.strictEqual(pts[0].attrs.lat, '41.5');
    assert.ok(Math.abs(Number(pts[1].attrs.lon)) <= 180);
    /* and a wrapper that only has `path`, in real degrees, is still accepted */
    const onlyPath = { path: [[41.5, 2.1], [40.4, -3.7]] };
    assert.ok(X.normaliseGeometry(onlyPath).trip);
    /* while one whose only path is out of range yields nothing at all */
    assert.deepStrictEqual(X.normaliseGeometry({ path: [[400, 300], [500, 320]] }),
        { days: null, trip: null });
});

test('normaliseGeometry classifies the shapes it accepts', function () {
    assert.deepStrictEqual(X.normaliseGeometry(null), { days: null, trip: null });
    assert.ok(X.normaliseGeometry([[1, 2], [3, 4]]).trip);
    assert.ok(X.normaliseGeometry([[[1, 2], [3, 4]]]).days);
    assert.ok(X.normaliseGeometry({ path: [[1, 2], [3, 4]] }).trip);
    assert.ok(X.normaliseGeometry({ days: [[[1, 2], [3, 4]]] }).days);
});

/* ════════════════════════════════════════════════════════════════════════════
   X3 — the date is a parameter
   ════════════════════════════════════════════════════════════════════════════ */

test('X3 the module never reads the clock', function () {
    const src = require('node:fs').readFileSync(
        path.join(__dirname, '..', 'js', 'route-export.js'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '');   /* comments may discuss it */
    assert.ok(code.indexOf('Date.now') < 0, 'Date.now() in route-export.js');
    assert.ok(code.indexOf('new Date') < 0, 'new Date() in route-export.js');
    assert.ok(code.indexOf('Math.random') < 0, 'Math.random() in route-export.js');
    assert.ok(code.indexOf('document') < 0, 'DOM access in route-export.js');
    assert.ok(code.indexOf('fetch(') < 0, 'network access in route-export.js');
});

test('X3 without a start date buildIcs returns the empty string, not an invented date', function () {
    assert.strictEqual(X.buildIcs({ plan: SIMPLE_PLAN }), '');
    assert.strictEqual(X.buildIcs({ plan: SIMPLE_PLAN, startDate: null }), '');
    assert.strictEqual(X.buildIcs({ plan: SIMPLE_PLAN, startDate: 'tomorrow' }), '');
    assert.strictEqual(X.buildIcs({ plan: SIMPLE_PLAN, startDate: '2026-02-30' }), '',
        'February has no 30th');
    assert.strictEqual(X.buildIcs({ plan: SIMPLE_PLAN, startDate: '2026-13-01' }), '');
});

test('X3 an empty calendar is never emitted — VCALENDAR always carries a component', function () {
    const outputs = [
        X.buildIcs({ plan: SIMPLE_PLAN }),
        X.buildIcs({ plan: mkPlan([]), startDate: '2026-08-14' }),
        X.buildIcs({ plan: null, startDate: '2026-08-14' }),
        X.buildIcs({})
    ];
    for (let i = 0; i < outputs.length; i++) {
        assert.strictEqual(outputs[i], '', 'case ' + i + ' produced a component-less calendar');
    }
});

test('X3 parseDate accepts the shapes a caller can realistically hold', function () {
    assert.deepStrictEqual(X.parseDate('2026-08-14'), { y: 2026, m: 8, d: 14 });
    assert.deepStrictEqual(X.parseDate('20260814'), { y: 2026, m: 8, d: 14 });
    assert.deepStrictEqual(X.parseDate('2026-08-14T09:00'), { y: 2026, m: 8, d: 14 });
    assert.deepStrictEqual(X.parseDate({ y: 2026, m: 8, d: 14 }), { y: 2026, m: 8, d: 14 });
    assert.deepStrictEqual(X.parseDate({ year: 2026, month: 8, day: 14 }), { y: 2026, m: 8, d: 14 });
    assert.strictEqual(X.parseDate(''), null);
    assert.strictEqual(X.parseDate('14/08/2026'), null);
});

test('X3 date arithmetic is calendar-correct, including leap years', function () {
    assert.deepStrictEqual(X.addDays({ y: 2026, m: 8, d: 14 }, 1), { y: 2026, m: 8, d: 15 });
    assert.deepStrictEqual(X.addDays({ y: 2026, m: 12, d: 31 }, 1), { y: 2027, m: 1, d: 1 });
    assert.deepStrictEqual(X.addDays({ y: 2026, m: 2, d: 28 }, 1), { y: 2026, m: 3, d: 1 });
    assert.deepStrictEqual(X.addDays({ y: 2024, m: 2, d: 28 }, 1), { y: 2024, m: 2, d: 29 });
    assert.deepStrictEqual(X.addDays({ y: 2000, m: 2, d: 28 }, 1), { y: 2000, m: 2, d: 29 });
    assert.deepStrictEqual(X.addDays({ y: 1900, m: 2, d: 28 }, 1), { y: 1900, m: 3, d: 1 });
    assert.deepStrictEqual(X.addDays({ y: 2026, m: 8, d: 14 }, 0), { y: 2026, m: 8, d: 14 });
    assert.strictEqual(X.formatIcsDate({ y: 2026, m: 8, d: 4 }), '20260804');
});

test('X3 consecutive days get consecutive dates, across a month boundary', function () {
    const plan = planFor(MADRID, BARCELONA, [ZARAGOZA], 3);
    const ics = X.buildIcs({ plan: plan, startDate: '2026-08-30' });
    const starts = icsProp(ics, 'DTSTART').map(function (v) { return v.slice(0, 8); });
    assert.deepStrictEqual(starts, ['20260830', '20260831', '20260901']);
});

test('X3 DTSTAMP is derived from the supplied date and can be overridden', function () {
    const a = X.buildIcs({ plan: SIMPLE_PLAN, startDate: '2026-08-14' });
    assert.deepStrictEqual(icsProp(a, 'DTSTAMP'), ['20260814T000000Z', '20260814T000000Z']);
    const b = X.buildIcs({ plan: SIMPLE_PLAN, startDate: '2026-08-14', dtstamp: '20250101T101112Z' });
    assert.deepStrictEqual(icsProp(b, 'DTSTAMP'), ['20250101T101112Z', '20250101T101112Z']);
    const c = X.buildIcs({ plan: SIMPLE_PLAN, startDate: '2026-08-14', dtstamp: 'garbage' });
    assert.deepStrictEqual(icsProp(c, 'DTSTAMP'), ['20260814T000000Z', '20260814T000000Z']);
});

/* ════════════════════════════════════════════════════════════════════════════
   ICS structure
   ════════════════════════════════════════════════════════════════════════════ */

test('ICS is CRLF-terminated throughout, with no bare LF or CR', function () {
    const ics = X.buildIcs({ plan: TRICKY_PLAN, startDate: '2026-08-14' });
    assert.ok(ics.length > 0);
    assert.ok(/\r\n$/.test(ics), 'file must end with CRLF');
    assert.strictEqual((ics.match(/\r\n/g) || []).length, (ics.match(/\n/g) || []).length,
        'every LF must be preceded by a CR');
    assert.strictEqual((ics.match(/\r/g) || []).length, (ics.match(/\r\n/g) || []).length,
        'every CR must be followed by an LF');
});

test('ICS carries the required calendar properties', function () {
    const ics = X.buildIcs({ plan: SIMPLE_PLAN, startDate: '2026-08-14' });
    const lines = icsLines(ics);
    assert.strictEqual(lines[0], 'BEGIN:VCALENDAR');
    assert.strictEqual(lines[lines.length - 1], 'END:VCALENDAR');
    assert.deepStrictEqual(icsCalProp(ics, 'VERSION'), ['2.0']);
    assert.deepStrictEqual(icsCalProp(ics, 'PRODID'), ['-//Travio//Route Planner//EN']);
    assert.deepStrictEqual(icsCalProp(ics, 'CALSCALE'), ['GREGORIAN']);
});

test('ICS PRODID can be overridden and never comes out empty', function () {
    const ics = X.buildIcs({ plan: SIMPLE_PLAN, startDate: '2026-08-14', prodId: '-//Me//App//EN' });
    assert.deepStrictEqual(icsCalProp(ics, 'PRODID'), ['-//Me//App//EN']);
    const blank = X.buildIcs({ plan: SIMPLE_PLAN, startDate: '2026-08-14', prodId: '   ' });
    assert.deepStrictEqual(icsCalProp(blank, 'PRODID'), ['-//Travio//Route Planner//EN']);
});

test('ICS emits exactly one VEVENT per plan day, correctly nested', function () {
    for (let n = 1; n <= 5; n++) {
        const plan = planFor(MADRID, BARCELONA, [ZARAGOZA], n);
        assert.strictEqual(plan.days.length, n);
        const ics = X.buildIcs({ plan: plan, startDate: '2026-08-14' });
        const lines = icsLines(ics);
        let open = 0, begins = 0, ends = 0;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i] === 'BEGIN:VEVENT') { open++; begins++; }
            if (lines[i] === 'END:VEVENT') { open--; ends++; }
            assert.ok(open === 0 || open === 1, 'VEVENTs must not nest');
        }
        assert.strictEqual(begins, n);
        assert.strictEqual(ends, n);
        assert.strictEqual(open, 0);
    }
});

test('ICS UIDs are unique within a calendar and stable across exports', function () {
    const plan = planFor(MADRID, BARCELONA, [ZARAGOZA, AMP], 4);
    const ics = X.buildIcs({ plan: plan, startDate: '2026-08-14' });
    const uids = icsProp(ics, 'UID');
    assert.strictEqual(uids.length, 4);
    const seen = {};
    for (let i = 0; i < uids.length; i++) {
        assert.ok(!seen[uids[i]], 'duplicate UID ' + uids[i]);
        seen[uids[i]] = true;
        assert.ok(/@travio\.app$/.test(uids[i]), 'UID needs a domain part: ' + uids[i]);
    }
    const again = X.buildIcs({ plan: plan, startDate: '2026-08-14' });
    assert.deepStrictEqual(icsProp(again, 'UID'), uids, 're-export must update, not duplicate');
});

test('ICS UIDs differ when the route differs, and when the start date differs', function () {
    const a = X.buildIcs({ plan: planFor(MADRID, BARCELONA, [ZARAGOZA], 2), startDate: '2026-08-14' });
    const b = X.buildIcs({ plan: planFor(MADRID, BARCELONA, [AMP], 2), startDate: '2026-08-14' });
    const c = X.buildIcs({ plan: planFor(MADRID, BARCELONA, [ZARAGOZA], 2), startDate: '2026-09-14' });
    assert.notDeepStrictEqual(icsProp(a, 'UID'), icsProp(b, 'UID'));
    assert.notDeepStrictEqual(icsProp(a, 'UID'), icsProp(c, 'UID'));
});

test('ICS UIDs stay distinct even when the plan reports duplicate day numbers', function () {
    const plan = mkPlan([
        day(1, [leg(MADRID, ZARAGOZA, 100, 60)]),
        day(1, [leg(ZARAGOZA, BARCELONA, 100, 60)])
    ]);
    const uids = icsProp(X.buildIcs({ plan: plan, startDate: '2026-08-14' }), 'UID');
    assert.strictEqual(uids.length, 2);
    assert.notStrictEqual(uids[0], uids[1]);
});

test('ICS uidSeed lets the caller pin UIDs to a saved-route id', function () {
    const ics = X.buildIcs({ plan: SIMPLE_PLAN, startDate: '2026-08-14', uidSeed: 'route-42' });
    const uids = icsProp(ics, 'UID');
    assert.deepStrictEqual(uids, ['travio-route-42-d1@travio.app', 'travio-route-42-d2@travio.app']);
});

test('ICS uses floating local time for a driving day with a departure clock', function () {
    const ics = X.buildIcs({ plan: SIMPLE_PLAN, startDate: '2026-08-14' });
    const start = icsProp(ics, 'DTSTART')[0];
    assert.ok(/^\d{8}T\d{6}$/.test(start), 'expected a floating DATE-TIME, got ' + start);
    assert.ok(start.indexOf('Z') < 0, 'a road trip is driven in local time, not UTC');
    assert.ok(ics.indexOf('DTSTART:20260814T090000') >= 0);
});

test('ICS DTEND is always strictly after DTSTART', function () {
    const ics = X.buildIcs({ plan: SIMPLE_PLAN, startDate: '2026-08-14' });
    const starts = icsProp(ics, 'DTSTART'), ends = icsProp(ics, 'DTEND');
    assert.strictEqual(starts.length, ends.length);
    for (let i = 0; i < starts.length; i++) {
        assert.ok(ends[i] > starts[i], starts[i] + ' -> ' + ends[i]);
    }
});

test('ICS rolls a drive past midnight into the following day', function () {
    const d = day(1, [leg(MADRID, BARCELONA, 900, 600)], { startTime: '20:00', endTime: '06:00' });
    const ics = X.buildIcs({ plan: mkPlan([d]), startDate: '2026-08-14' });
    assert.deepStrictEqual(icsProp(ics, 'DTSTART'), ['20260814T200000']);
    assert.deepStrictEqual(icsProp(ics, 'DTEND'), ['20260815T060000']);
});

test('ICS falls back to an all-day event when no departure time was given', function () {
    const plan = planFor(MADRID, BARCELONA, [ZARAGOZA], 2, { departureTime: null });
    const ics = X.buildIcs({ plan: plan, startDate: '2026-08-14' });
    assert.ok(ics.indexOf('DTSTART;VALUE=DATE:20260814') >= 0);
    assert.ok(ics.indexOf('DTEND;VALUE=DATE:20260815') >= 0);
    assert.deepStrictEqual(icsProp(ics, 'DTSTART'), ['20260814', '20260815']);
});

test('ICS allDay:true forces DATE events even when clocks exist', function () {
    const ics = X.buildIcs({ plan: SIMPLE_PLAN, startDate: '2026-08-14', allDay: true });
    assert.deepStrictEqual(icsProp(ics, 'DTSTART'), ['20260814', '20260815']);
    assert.ok(ics.indexOf('VALUE=DATE') > 0);
});

test('ICS carries LOCATION and GEO for the day end place, omitting GEO when unknown', function () {
    const ics = X.buildIcs({ plan: SIMPLE_PLAN, startDate: '2026-08-14' });
    assert.deepStrictEqual(icsProp(ics, 'LOCATION'), ['Zaragoza', 'Barcelona']);
    assert.deepStrictEqual(icsProp(ics, 'GEO'), ['41.6488;-0.8891', '41.3851;2.1734']);

    const lost = P('Nowhere', null, null, { resolved: false });
    const plan = mkPlan([day(1, [leg(MADRID, lost, 100, 60)])]);
    const ics2 = X.buildIcs({ plan: plan, startDate: '2026-08-14' });
    assert.deepStrictEqual(icsProp(ics2, 'LOCATION'), ['Nowhere']);
    assert.deepStrictEqual(icsProp(ics2, 'GEO'), [], 'no coordinates, no GEO');
});

test('ICS descriptions carry the engine distance and drive time', function () {
    const ics = X.buildIcs({ plan: SIMPLE_PLAN, startDate: '2026-08-14' });
    const desc = decodeIcs(icsProp(ics, 'DESCRIPTION')[0]);
    assert.ok(/Distance: \d/.test(desc), desc);
    assert.ok(/Drive time: /.test(desc), desc);
});

test('ICS lists intermediate stops but not the start and end of the day', function () {
    const plan = planFor(MADRID, BARCELONA, [ZARAGOZA, AMP], 1);
    const desc = decodeIcs(icsProp(X.buildIcs({ plan: plan, startDate: '2026-08-14' }), 'DESCRIPTION')[0]);
    assert.ok(desc.indexOf('Stops: ') >= 0, desc);
    assert.ok(desc.indexOf('Madrid') < 0, 'the start is not a stop');
});

test('ICS labels are overridable so the calendar can be written in the user locale', function () {
    const ics = X.buildIcs({
        plan: SIMPLE_PLAN, startDate: '2026-08-14',
        labels: { day: 'Día {day}', distance: 'Distancia', driveTime: 'Tiempo al volante' }
    });
    assert.ok(decodeIcs(icsProp(ics, 'SUMMARY')[0]).indexOf('Día 1') === 0);
    assert.ok(decodeIcs(icsProp(ics, 'DESCRIPTION')[0]).indexOf('Distancia: ') === 0);
});

/* ════════════════════════════════════════════════════════════════════════════
   X4 — degenerate inputs must not throw
   ════════════════════════════════════════════════════════════════════════════ */

test('X4 no plan at all: GPX is still well-formed, ICS is empty', function () {
    const inputs = [undefined, null, {}, { days: null }, { days: [] }];
    for (let i = 0; i < inputs.length; i++) {
        const gpx = X.buildGpx({ plan: inputs[i] });
        const root = parseXml(gpx);
        assert.strictEqual(root.name, 'gpx');
        assert.strictEqual(findAll(root, 'wpt').length, 0);
        assert.strictEqual(findAll(root, 'rte').length, 0);
        assert.strictEqual(X.buildIcs({ plan: inputs[i], startDate: '2026-08-14' }), '');
    }
    assert.ok(X.buildPrintHtml({}).indexOf('<html') >= 0);
    assert.ok(X.buildGpx().indexOf('<gpx') > 0);
    assert.strictEqual(X.buildIcs(), '');
    assert.ok(X.buildPrintHtml().indexOf('<html') >= 0);
});

test('X4 zero stops: start to end directly', function () {
    const plan = planFor(MADRID, BARCELONA, [], 1);
    const root = parseXml(X.buildGpx({ plan: plan }));
    assert.strictEqual(findAll(root, 'wpt').length, 2);
    assert.strictEqual(findAll(root, 'rte').length, 1);
    const ics = X.buildIcs({ plan: plan, startDate: '2026-08-14' });
    assert.strictEqual(icsProp(ics, 'UID').length, 1);
});

test('X4 one day holding every stop', function () {
    const plan = planFor(MADRID, BARCELONA, [ZARAGOZA, AMP, QUOTE], 1);
    assert.strictEqual(plan.days.length, 1);
    const root = parseXml(X.buildGpx({ plan: plan }));
    assert.strictEqual(findAll(root, 'rte').length, 1);
    assert.strictEqual(findAll(findAll(root, 'rte')[0], 'rtept').length, 5);
    assert.strictEqual(icsProp(X.buildIcs({ plan: plan, startDate: '2026-08-14' }), 'UID').length, 1);
});

test('X4 a rest day with 0 km gets a waypoint and an all-day event, but no route', function () {
    /* more days than stops forces the engine to create rest days (R5) */
    const plan = planFor(MADRID, BARCELONA, [ZARAGOZA], 5);
    assert.strictEqual(plan.days.length, 5);
    let rest = 0;
    for (let i = 0; i < plan.days.length; i++) if (plan.days[i].legs.length === 0) rest++;
    assert.ok(rest > 0, 'fixture produced no rest day');

    const root = parseXml(X.buildGpx({ plan: plan }));
    assert.strictEqual(findAll(root, 'rte').length, plan.days.length - rest);

    const ics = X.buildIcs({ plan: plan, startDate: '2026-08-14' });
    assert.strictEqual(icsProp(ics, 'UID').length, 5, 'a rest day is still a day of the trip');
    const summaries = icsProp(ics, 'SUMMARY').map(decodeIcs).join('\n');
    assert.ok(summaries.indexOf('Rest day') >= 0, summaries);
    const starts = icsProp(ics, 'DTSTART');
    let allDay = 0;
    for (let i = 0; i < starts.length; i++) if (/^\d{8}$/.test(starts[i])) allDay++;
    assert.strictEqual(allDay, rest, 'a rest day has no drive window to put on the clock');
});

test('X4 a rest day description carries no fabricated distance', function () {
    const d = day(2, [], { startPlace: ZARAGOZA, endPlace: ZARAGOZA, km: 0, driveMin: 0 });
    const plan = mkPlan([day(1, [leg(MADRID, ZARAGOZA, 300, 180)], { startTime: '09:00' }), d]);
    const ics = X.buildIcs({ plan: plan, startDate: '2026-08-14' });
    const descs = icsProp(ics, 'DESCRIPTION');
    assert.strictEqual(descs.length, 1, 'a rest day with nothing to say says nothing');
    assert.ok(ics.indexOf('Distance: 0 ') < 0, 'a rest day must not claim a 0 km drive');
    assert.ok(ics.indexOf('Drive time: 0 ') < 0);
    assert.ok(decodeIcs(icsProp(ics, 'SUMMARY')[1]).indexOf('Rest day in Zaragoza') > 0);
});

test('X4 unresolved places with null coordinates are dropped from the geometry, not the itinerary',
    function () {
        const lost = P('Cap de Res', null, null, { resolved: false });
        const plan = mkPlan([
            day(1, [leg(MADRID, lost, 200, 120)], { startTime: '09:00' }),
            day(2, [leg(lost, BARCELONA, 400, 240)], { startTime: '09:00' })
        ]);
        const gpx = X.buildGpx({ plan: plan });
        const root = parseXml(gpx);
        const names = findAll(root, 'wpt').map(function (w) { return childText(w, 'name'); });
        assert.ok(names.indexOf('Cap de Res') < 0, 'a place with no coordinates has no pin');
        assert.strictEqual(findAll(root, 'rte').length, 0, 'one located point is not a route');
        assert.ok(gpx.indexOf('could not be located') > 0, 'the omission must be stated');
        assert.ok(gpx.indexOf('1 place(s)') > 0);

        const ics = X.buildIcs({ plan: plan, startDate: '2026-08-14' });
        const summaries = icsProp(ics, 'SUMMARY').map(decodeIcs).join('\n');
        assert.ok(summaries.indexOf('Cap de Res') >= 0, 'the day itself is still exported');
        assert.strictEqual(icsProp(ics, 'GEO').length, 1, 'only the located end place gets a GEO');
    });

test('X4 NaN / string / out-of-range coordinates are treated as unlocated', function () {
    const bad = [
        P('NaN', NaN, 1), P('str', 'x', 'y'), P('big', 91, 0),
        P('small', 0, -181), P('undef', undefined, undefined)
    ];
    const legs = [];
    for (let i = 0; i < bad.length; i++) legs.push(leg(i === 0 ? MADRID : bad[i - 1], bad[i], 10, 10));
    const gpx = X.buildGpx({ plan: mkPlan([day(1, legs)]) });
    const root = parseXml(gpx);
    assert.strictEqual(findAll(root, 'wpt').length, 1, 'only Madrid is locatable');
    assert.ok(gpx.indexOf('5 place(s) could not be located') > 0);
});

test('X4 coordinates arriving as numeric strings are accepted', function () {
    const plan = mkPlan([day(1, [leg(P('A', '41.5', '2.1'), P('B', '40.0', '-3.0'), 100, 60)])]);
    const root = parseXml(X.buildGpx({ plan: plan }));
    const wpts = findAll(root, 'wpt');
    assert.strictEqual(wpts.length, 2);
    assert.strictEqual(wpts[0].attrs.lat, '41.5');
});

test('X4 duplicate destination names do not collapse days or UIDs', function () {
    const plan = planFor(MADRID, BARCELONA, [ZARAGOZA, P('Zaragoza', 41.6488, -0.8891)], 3);
    const gpx = X.buildGpx({ plan: plan });
    parseXml(gpx);
    const ics = X.buildIcs({ plan: plan, startDate: '2026-08-14' });
    const uids = icsProp(ics, 'UID');
    assert.strictEqual(uids.length, plan.days.length);
    assert.strictEqual(new Set(uids).size, uids.length);
});

test('X4 two different places sharing a name each keep their own waypoint', function () {
    const a = P('Sant Pere', 41.5, 2.1), b = P('Sant Pere', 42.5, 1.1);
    const plan = mkPlan([day(1, [leg(a, b, 120, 90)], { startTime: '09:00' })]);
    const root = parseXml(X.buildGpx({ plan: plan }));
    assert.strictEqual(findAll(root, 'wpt').length, 2,
        'dedup is by name AND coordinates — different places are different pins');
});

test('X4 a place with an empty name still exports its coordinates', function () {
    const plan = mkPlan([day(1, [leg(P('', 41.5, 2.1), P('B', 40, -3), 100, 60)])]);
    const root = parseXml(X.buildGpx({ plan: plan }));
    assert.strictEqual(findAll(root, 'wpt').length, 2);
    assert.strictEqual(childText(findAll(root, 'wpt')[0], 'name'), '');
});

test('X4 malformed day records do not throw', function () {
    const plans = [
        { days: [null] },
        { days: [{}] },
        { days: [{ legs: 'nope' }] },
        { days: [{ legs: [null, undefined] }] },
        { days: [{ legs: [{ from: null, to: null, km: NaN, min: NaN }] }] },
        { days: [{ day: 'x', legs: [], startPlace: MADRID, endPlace: MADRID }] }
    ];
    for (let i = 0; i < plans.length; i++) {
        const gpx = X.buildGpx({ plan: plans[i] });
        parseXml(gpx);
        const ics = X.buildIcs({ plan: plans[i], startDate: '2026-08-14' });
        assert.ok(ics.length > 0, 'case ' + i + ' produced no calendar');
        assert.ok(ics.indexOf('BEGIN:VEVENT') > 0);
        assert.ok(/\r\n$/.test(ics));
    }
});

test('X4 a very long trip builds without recursion or quadratic blowup', function () {
    const days = [];
    for (let i = 0; i < 200; i++) {
        days.push(day(i + 1, [leg(P('P' + i, 40 + i * 0.01, -3 + i * 0.01),
            P('P' + (i + 1), 40 + (i + 1) * 0.01, -3 + (i + 1) * 0.01), 50, 40)],
            { startTime: '09:00' }));
    }
    const plan = mkPlan(days);
    const ics = X.buildIcs({ plan: plan, startDate: '2026-01-01' });
    assert.strictEqual(icsProp(ics, 'UID').length, 200);
    assert.strictEqual(new Set(icsProp(ics, 'UID')).size, 200);
    assert.deepStrictEqual(icsProp(ics, 'DTSTART')[199].slice(0, 8), '20260719');
    const root = parseXml(X.buildGpx({ plan: plan }));
    assert.strictEqual(findAll(root, 'rte').length, 200);
    assert.strictEqual(findAll(root, 'wpt').length, 201);
});

test('X4 a large track folds and serialises without breaking well-formedness', function () {
    const path5000 = [];
    for (let i = 0; i < 5000; i++) path5000.push([40 + i * 0.001, -3 + i * 0.0005]);
    const plan = mkPlan([day(1, [leg(MADRID, BARCELONA, 600, 360)], { startTime: '09:00' })]);
    const root = parseXml(X.buildGpx({ plan: plan, geometry: [path5000] }));
    assert.strictEqual(findAll(root, 'trkpt').length, 5000);
});

test('X4 a 4000-character description folds into many valid segments', function () {
    const long = 'Passejada per la Cornellà històrica amb parada al mercat; '.repeat(70);
    const plan = mkPlan([day(1, [leg(MADRID, BARCELONA, 600, 360)], { startTime: '09:00' })]);
    const ics = X.buildIcs({
        plan: plan, startDate: '2026-08-14',
        enrichment: { days: [{ present: true, activities: [long], lodging: '', tip: '' }] }
    });
    const raw = physicalLines(ics);
    for (let i = 0; i < raw.length; i++) assert.ok(X.utf8Length(raw[i]) <= 75);
    const desc = decodeIcs(icsProp(ics, 'DESCRIPTION')[0]);
    assert.ok(desc.indexOf('Passejada per la Cornellà') > 0);
    assert.ok(desc.length > 3000, 'the text survived folding intact');
});

/* ════════════════════════════════════════════════════════════════════════════
   X5 — never export a number the app does not know
   ════════════════════════════════════════════════════════════════════════════ */

test('X5 no cost appears at all when the caller supplies no costs', function () {
    const ics = X.buildIcs({ plan: SIMPLE_PLAN, startDate: '2026-08-14' });
    assert.ok(ics.indexOf('EUR') < 0, 'a cost was invented from nothing');
    assert.ok(ics.indexOf('Estimated cost') < 0);
});

test('X5 a complete day cost is exported as a total', function () {
    const costs = { days: [{ total: 123.45, incomplete: false }, { total: 100, incomplete: false }] };
    const ics = X.buildIcs({ plan: SIMPLE_PLAN, startDate: '2026-08-14', costs: costs });
    const desc = decodeIcs(icsProp(ics, 'DESCRIPTION')[0]);
    assert.ok(desc.indexOf('Estimated cost: EUR 123.45') >= 0, desc);
    assert.ok(desc.indexOf('at least') < 0);
});

test('X5 an INCOMPLETE day cost is exported as a floor, never as a total', function () {
    const costs = { days: [{ total: 95.5, incomplete: true, tollsBasis: 'unknown' },
        { total: 100, incomplete: false }] };
    const ics = X.buildIcs({ plan: SIMPLE_PLAN, startDate: '2026-08-14', costs: costs });
    const descs = icsProp(ics, 'DESCRIPTION').map(decodeIcs);
    assert.ok(descs[0].indexOf('at least EUR 95.50') > 0, descs[0]);
    assert.ok(descs[0].indexOf('incomplete') > 0);
    assert.ok(descs[1].indexOf('at least') < 0, 'the complete day is unaffected');
});

test('X5 an unknown toll never becomes a zero in the exported cost', function () {
    /* the exact bug class: computeCosts reports tolls: 0 with tollsKnown false */
    const costs = {
        days: [{ total: 80, tolls: 0, tollsKnown: false, tollsBasis: 'unknown', incomplete: true },
            { total: 80, tolls: 0, tollsKnown: false, tollsBasis: 'not-avoided', incomplete: true }]
    };
    const ics = X.buildIcs({ plan: SIMPLE_PLAN, startDate: '2026-08-14', costs: costs });
    assert.ok(ics.indexOf('EUR 0.00') < 0, 'an unknown toll surfaced as a euro zero');
    const descs = icsProp(ics, 'DESCRIPTION').map(decodeIcs);
    for (let i = 0; i < descs.length; i++) assert.ok(descs[i].indexOf('at least') > 0, descs[i]);
});

test('X5 a day with no cost entry gets no cost line while its neighbours keep theirs', function () {
    const costs = { days: [null, { total: 50, incomplete: false }] };
    const descs = icsProp(X.buildIcs({
        plan: SIMPLE_PLAN, startDate: '2026-08-14', costs: costs
    }), 'DESCRIPTION').map(decodeIcs);
    assert.ok(descs[0].indexOf('EUR') < 0);
    assert.ok(descs[1].indexOf('EUR 50.00') > 0);
});

test('X5 a non-numeric total is omitted rather than printed as 0', function () {
    const costs = { days: [{ total: null, incomplete: false }, { total: 'x', incomplete: false }] };
    const ics = X.buildIcs({ plan: SIMPLE_PLAN, startDate: '2026-08-14', costs: costs });
    assert.ok(ics.indexOf('EUR') < 0);
});

test('X5 a plan the engine declared unusable exports no distances or times', function () {
    const plan = planFor(MADRID, BARCELONA, [ZARAGOZA], 2);
    plan.warnings = plan.warnings.concat(['unknown-distance: the matrix carried no usable values']);
    assert.strictEqual(X.numbersUnreliable(plan), true);

    const gpx = X.buildGpx({ plan: plan });
    parseXml(gpx);
    assert.ok(gpx.indexOf('could not be computed') > 0, 'the omission must be stated');
    assert.ok(gpx.indexOf('Drive time ') < 0, 'a drive time survived an unusable plan');

    const ics = X.buildIcs({ plan: plan, startDate: '2026-08-14' });
    const descs = icsProp(ics, 'DESCRIPTION').map(decodeIcs);
    for (let i = 0; i < descs.length; i++) {
        assert.ok(descs[i].indexOf('Distance: ') < 0, descs[i]);
        assert.ok(descs[i].indexOf('could not be computed') >= 0, descs[i]);
    }
    /* and with no trustworthy drive time there is no drive window to schedule */
    const starts = icsProp(ics, 'DTSTART');
    for (let i = 0; i < starts.length; i++) assert.ok(/^\d{8}$/.test(starts[i]));
});

test('X5 zero-distance is the other unusable class, and costs are withheld with it', function () {
    const plan = planFor(MADRID, BARCELONA, [ZARAGOZA], 2);
    plan.warnings = ['zero-distance: every leg came back as 0 km'];
    const ics = X.buildIcs({
        plan: plan, startDate: '2026-08-14',
        costs: { days: [{ total: 120, incomplete: false }, { total: 120, incomplete: false }] }
    });
    assert.ok(ics.indexOf('EUR') < 0, 'a cost computed from unusable distances was exported');
});

/* ── X7 — the third state: qualify the figure, do not withhold it ───────────
   This replaces a test that called "no road data at all" an ORDINARY warning
   and asserted the bare figure. The numbersUnreliable half was right; the half
   it never asserted — that an estimate carries its qualifier — is the bug. */

test('X7 the haversine fallback prints its number AND says what kind of number it is', function () {
    /* The reproduction: OSRM down, geo-provider falls back to haversine × 1.25.
       Madrid→Barcelona is 620 real road km and this says 632 — plausible, which
       is exactly what makes an unqualified figure dangerous. */
    const plan = planFor(MADRID, BARCELONA, [], 1);
    let sourced = false;
    for (let i = 0; i < plan.warnings.length; i++) {
        if (plan.warnings[i].indexOf('distance-source: no road data at all') === 0) sourced = true;
    }
    assert.ok(sourced, 'fixture no longer reproduces the haversine warning');

    /* not unusable — suppressing a usable estimate would be over-firing */
    assert.strictEqual(X.numbersUnreliable(plan), false);

    /* the caller that knows the source gets the crisp sentence */
    const told = X.buildIcs({ plan: plan, startDate: '2026-08-14', matrixSource: 'haversine' });
    assert.strictEqual(X.distanceBasis(plan, { matrixSource: 'haversine' }), 'estimated');
    const toldDesc = decodeIcs(icsProp(told, 'DESCRIPTION')[0]);
    assert.ok(toldDesc.indexOf('Distance: ') === 0, 'the figure is still printed');
    assert.ok(/STRAIGHT-LINE ESTIMATES/.test(toldDesc), 'no qualifier on the figure: ' + toldDesc);
    assert.ok(toldDesc.indexOf('not driving distances') > 0, toldDesc);
    /* and the qualifier sits with the numbers, not in some far corner */
    const driveAt = toldDesc.indexOf('Drive time: ');
    const qualAt = toldDesc.indexOf('STRAIGHT-LINE ESTIMATES');
    assert.ok(qualAt > driveAt && qualAt - driveAt < 60, 'qualifier is not adjacent to the figures');

    /* the caller that says nothing still gets a qualifier AND the engine's own
       alert-level sentence — never a bare 632 km */
    const quiet = X.buildIcs({ plan: plan, startDate: '2026-08-14' });
    assert.strictEqual(X.distanceBasis(plan, {}), 'unconfirmed');
    const quietDesc = decodeIcs(icsProp(quiet, 'DESCRIPTION')[0]);
    assert.ok(quietDesc.indexOf('Distance: ') === 0);
    assert.ok(quietDesc.indexOf('could not be confirmed') > 0, quietDesc);
    assert.ok(quietDesc.indexOf('no road data at all') > 0,
        'the engine sentence the screen shows as an alert is missing: ' + quietDesc);
    assert.ok(decodeIcs(icsCalProp(quiet, 'DESCRIPTION')[0]).indexOf('no road data at all') > 0);

    /* the GPX says it too, in the metadata and on every route */
    const gpx = X.buildGpx({ plan: plan, matrixSource: 'haversine' });
    const root = parseXml(gpx);
    assert.ok(decodeXml(childText(findAll(root, 'metadata')[0], 'desc'))
        .indexOf('STRAIGHT-LINE ESTIMATES') > 0);
    assert.ok(decodeXml(childText(findAll(root, 'rte')[0], 'desc'))
        .indexOf('STRAIGHT-LINE ESTIMATES') > 0);
    assert.ok(X.buildGpx({ plan: plan }).indexOf('no road data at all') > 0,
        'the GPX drops the engine sentence when no source is stated');
});

test('X7 all five provenance states, and only one of them withholds', function () {
    const plan = planFor(MADRID, BARCELONA, [ZARAGOZA], 2);
    plan.warnings = [];
    const cases = [
        { src: 'osrm', basis: 'road', mark: 'from the road graph' },
        { src: 'mixed', basis: 'partial', mark: 'Some of these distances are straight-line' },
        { src: 'haversine', basis: 'estimated', mark: 'STRAIGHT-LINE ESTIMATES' },
        { src: undefined, basis: 'unconfirmed', mark: 'could not be confirmed' },
        { src: 'nonsense', basis: 'unconfirmed', mark: 'could not be confirmed' }
    ];
    for (let i = 0; i < cases.length; i++) {
        const c = cases[i];
        assert.strictEqual(X.distanceBasis(plan, { matrixSource: c.src }), c.basis, 'source ' + c.src);
        const desc = decodeIcs(icsProp(X.buildIcs({
            plan: plan, startDate: '2026-08-14', matrixSource: c.src
        }), 'DESCRIPTION')[0]);
        assert.ok(desc.indexOf('Distance: ') === 0, 'source ' + c.src + ' withheld a usable figure');
        assert.ok(desc.indexOf(c.mark) > 0, 'source ' + c.src + ' -> ' + desc);
    }
    /* only 'unusable' withholds */
    plan.warnings = ['unknown-distance: x'];
    assert.strictEqual(X.distanceBasis(plan, { matrixSource: 'osrm' }), 'unusable');
    const withheld = decodeIcs(icsProp(X.buildIcs({
        plan: plan, startDate: '2026-08-14', matrixSource: 'osrm'
    }), 'DESCRIPTION')[0]);
    assert.ok(withheld.indexOf('Distance: ') < 0);
});

test('X7 an absent matrixSource is unconfirmed — neither road data nor "no road data"',
    function () {
        const plan = planFor(MADRID, BARCELONA, [ZARAGOZA], 2);
        plan.warnings = [];
        assert.strictEqual(X.distanceBasis(plan, {}), 'unconfirmed');
        assert.strictEqual(X.distanceBasis(null, {}), 'unconfirmed');
        assert.strictEqual(X.distanceBasis({}, { matrixSource: null }), 'unconfirmed');

        const desc = decodeIcs(icsProp(X.buildIcs({
            plan: plan, startDate: '2026-08-14'
        }), 'DESCRIPTION')[0]);
        /* silence is not evidence of a road graph ... */
        assert.ok(desc.indexOf('come from the road graph') < 0);
        /* ... and it is not evidence of the absence of one either. Telling a
           70%-real matrix it has no road data is the same lie in the other
           direction — the bug js/itinerary-render.js was fixed for. */
        assert.ok(desc.indexOf('no road data was available') < 0,
            'an unknown source was reported as having no road data at all');
        assert.ok(desc.indexOf('could not be confirmed') > 0, desc);
    });

test('X7 a caller that states nothing still gets the engine warning verbatim', function () {
    /* the qualifier for an unknown source is deliberately weaker than the
       warning it would be standing in for, so the warning itself must survive */
    const plan = planFor(MADRID, BARCELONA, [ZARAGOZA], 2);
    plan.warnings = ['distance-source: partial road data — 2 of 6 cells estimated'];
    assert.deepStrictEqual(X.residualWarnings(plan, {}), plan.warnings);
    assert.deepStrictEqual(X.residualWarnings(plan, { matrixSource: 'mixed' }), []);
    assert.deepStrictEqual(X.residualWarnings(plan, { matrixSource: 'haversine' }), []);
    assert.deepStrictEqual(X.residualWarnings(plan, { matrixSource: 'osrm' }), plan.warnings);
    assert.ok(X.buildIcs({ plan: plan, startDate: '2026-08-14' }).indexOf('2 of 6 cells') > 0);
});

test('X7 warnings may only DOWNGRADE the claimed provenance, never upgrade it', function () {
    const base = planFor(MADRID, BARCELONA, [ZARAGOZA], 2);
    function withWarnings(w) { const p = planFor(MADRID, BARCELONA, [ZARAGOZA], 2); p.warnings = w; return p; }

    /* an "osrm" label plus evidence of gap-filling is at best partial */
    assert.strictEqual(X.distanceBasis(withWarnings(['distance-fallback: 3 cells']),
        { matrixSource: 'osrm' }), 'partial');
    assert.strictEqual(X.distanceBasis(withWarnings(['missing-matrix: none supplied']),
        { matrixSource: 'osrm' }), 'estimated');
    /* a discarded or repaired matrix proves the label is not trustworthy, but
       not that there was no road data — so it lands on unconfirmed, not on the
       stronger "no road data was available" */
    assert.strictEqual(X.distanceBasis(withWarnings(['matrix-size-mismatch: 3x3 but 4 places']),
        { matrixSource: 'osrm' }), 'unconfirmed');
    assert.strictEqual(X.distanceBasis(withWarnings(['invalid-distance: negative values']),
        { matrixSource: 'osrm' }), 'unconfirmed');
    /* and nothing can turn a haversine matrix into road data */
    assert.strictEqual(X.distanceBasis(withWarnings([]), { matrixSource: 'haversine' }), 'estimated');
    assert.strictEqual(X.distanceBasis(base, { matrixSource: 'osrm' }), 'partial',
        'the engine already flags this fixture as gap-filled or estimated');

    /* An "osrm" claim the engine contradicted is the one case a three-way
       qualifier cannot fully carry, so the engine's own sentence is surfaced
       verbatim alongside the downgrade — covered structurally, but only when
       the structure actually matches. */
    assert.deepStrictEqual(X.residualWarnings(base, { matrixSource: 'osrm' }), base.warnings);
    assert.deepStrictEqual(X.residualWarnings(base, {}), base.warnings);
    assert.deepStrictEqual(X.residualWarnings(base, { matrixSource: 'haversine' }), []);
    const ics = X.buildIcs({ plan: base, startDate: '2026-08-14', matrixSource: 'osrm' });
    assert.ok(decodeIcs(icsCalProp(ics, 'DESCRIPTION')[0]).indexOf('no road data at all') > 0,
        'a contradicted road-data claim went out unqualified');
});

test('X7 a mixed matrix is never told it has no road data at all', function () {
    /* the bug itinerary-render.js fixed on screen, checked here for the file:
       a 70%-real matrix must not claim there is no road data */
    const plan = planFor(MADRID, BARCELONA, [ZARAGOZA], 2);
    plan.warnings = ['distance-source: partial road data — 2 of 6 cells estimated'];
    const desc = decodeIcs(icsProp(X.buildIcs({
        plan: plan, startDate: '2026-08-14', matrixSource: 'mixed'
    }), 'DESCRIPTION')[0]);
    assert.ok(desc.indexOf('Some of these distances') > 0, desc);
    assert.ok(desc.indexOf('no road data was available') < 0,
        'a partly-real matrix was reported as having no road data');
});

test('X7 numbersUnreliable(false) rules out withholding but cannot promise road data', function () {
    const plan = planFor(MADRID, BARCELONA, [ZARAGOZA], 2);
    plan.warnings = ['unknown-distance: x'];
    assert.strictEqual(X.distanceBasis(plan, { numbersUnreliable: false }), 'estimated');
    assert.strictEqual(X.distanceBasis(plan, { numbersUnreliable: false, matrixSource: 'osrm' }),
        'estimated', 'an override must not upgrade the claim to road data');
    assert.strictEqual(X.distanceBasis(plan, { numbersUnreliable: true }), 'unusable');
});

test('X7 B6: a long driving day is flagged in the file, not only on screen', function () {
    const plan = planFor(MADRID, BARCELONA, [], 1);
    assert.strictEqual(plan.days[0].overDriveCap, true, 'fixture is not over the cap');

    const withCap = decodeIcs(icsProp(X.buildIcs({
        plan: plan, startDate: '2026-08-14', maxDriveMin: 360
    }), 'DESCRIPTION')[0]);
    assert.ok(withCap.indexOf('Long driving day: 7 h 1 min, above the 6 h') >= 0, withCap);

    /* without a stated cap the flag stays but the number does not get invented */
    const noCap = decodeIcs(icsProp(X.buildIcs({
        plan: plan, startDate: '2026-08-14'
    }), 'DESCRIPTION')[0]);
    assert.ok(noCap.indexOf('Long driving day') >= 0, noCap);
    assert.ok(!/above the \d/.test(noCap), 'a cap the planner never stated was exported: ' + noCap);

    /* and the GPX route carries it too */
    const gpx = X.buildGpx({ plan: plan, maxDriveMin: 360 });
    assert.ok(gpx.indexOf('Long driving day') > 0);

    /* a day under the cap says nothing */
    const easy = planFor(MADRID, BARCELONA, [ZARAGOZA], 4);
    const quiet = X.buildIcs({ plan: easy, startDate: '2026-08-14', maxDriveMin: 360 });
    let flagged = 0;
    const all = icsProp(quiet, 'DESCRIPTION').map(decodeIcs);
    for (let i = 0; i < all.length; i++) if (all[i].indexOf('Long driving day') >= 0) flagged++;
    let capped = 0;
    for (let i = 0; i < easy.days.length; i++) if (easy.days[i].overDriveCap) capped++;
    assert.strictEqual(flagged, capped);
});

test('X7 every one of the 20 engine warning codes reaches the file, structurally or verbatim',
    function () {
        const src = require('node:fs').readFileSync(
            path.join(__dirname, '..', 'js', 'route-engine.js'), 'utf8');
        const codes = {};
        const re = /warnings\.push\('([a-z-]+):/g;
        let m;
        while ((m = re.exec(src)) !== null) codes[m[1]] = true;
        const all = Object.keys(codes).sort();
        assert.strictEqual(all.length, 20, 'the engine now emits ' + all.length + ' codes: ' + all);

        const covered = X.COVERED_WARNINGS;
        const verbatim = [];
        for (let i = 0; i < all.length; i++) if (!covered[all[i]]) verbatim.push(all[i]);
        assert.deepStrictEqual(verbatim, ['cap-default', 'days-clamped', 'duplicate-stop-removed',
            'empty-trip', 'missing-end', 'missing-start', 'no-places', 'optimisation-limited',
            'stop-ignored']);

        /* the verbatim ones really do come out */
        const plan = planFor(MADRID, BARCELONA, [ZARAGOZA], 2);
        plan.warnings = ['duplicate-stop-removed: "Zaragoza" is listed more than once.',
            'optimisation-limited: 14 stops exceed the 2-opt limit.',
            'cap-default: maxDriveMinPerDay "x" is not usable, using 360.'];
        assert.strictEqual(X.residualWarnings(plan).length, 3);
        const ics = X.buildIcs({ plan: plan, startDate: '2026-08-14' });
        const first = decodeIcs(icsProp(ics, 'DESCRIPTION')[0]);
        assert.ok(first.indexOf('Planner notes') > 0, first);
        assert.ok(first.indexOf('is listed more than once') > 0);
        assert.ok(first.indexOf('exceed the 2-opt limit') > 0);
        assert.ok(first.indexOf('not usable, using 360') > 0);
        /* and only on the first day, not repeated on every event */
        const second = decodeIcs(icsProp(ics, 'DESCRIPTION')[1]);
        assert.ok(second.indexOf('Planner notes') < 0);
        /* the GPX carries them too */
        assert.ok(X.buildGpx({ plan: plan }).indexOf('exceed the 2-opt limit') > 0);
    });

test('X7 a structurally-represented warning is not ALSO dumped as raw prose', function () {
    const plan = planFor(MADRID, BARCELONA, [ZARAGOZA], 2);
    plan.warnings = ['distance-source: no road data at all — every distance is a straight-line estimate.',
        'rest-day: day 2 has no driving.',
        'over-drive-cap: day 1 drives 421 min.',
        'unresolved-place: "X" could not be located.',
        'round-trip: the end point matches the start point.'];
    /* stating the source makes the qualifier say everything the warning says */
    const opts = { matrixSource: 'haversine' };
    assert.deepStrictEqual(X.residualWarnings(plan, opts), []);
    const ics = X.buildIcs({ plan: plan, startDate: '2026-08-14', matrixSource: 'haversine' });
    assert.ok(ics.indexOf('Planner notes') < 0, 'covered warnings were duplicated as prose');
    assert.ok(ics.indexOf('every distance is a straight-line estimate.') < 0);
    /* but their meaning is still in the file */
    assert.ok(decodeIcs(icsProp(ics, 'DESCRIPTION')[0]).indexOf('STRAIGHT-LINE ESTIMATES') > 0);
});

test('X7 the calendar header states the provenance as well', function () {
    const plan = planFor(MADRID, BARCELONA, [ZARAGOZA], 2);
    plan.warnings = [];          /* a genuinely clean road matrix */
    const ics = X.buildIcs({ plan: plan, startDate: '2026-08-14', matrixSource: 'osrm' });
    assert.ok(decodeIcs(icsCalProp(ics, 'DESCRIPTION')[0]).indexOf('road graph') > 0);
    assert.ok(decodeIcs(icsCalProp(ics, 'X-WR-CALDESC')[0]).indexOf('road graph') > 0);
    /* and it is calendar-level, so it must not be counted as an event's */
    assert.strictEqual(icsProp(ics, 'DESCRIPTION').length, 2);
});

test('X7 the provenance sentences are translatable like everything else', function () {
    const ics = X.buildIcs({
        plan: planFor(MADRID, BARCELONA, [ZARAGOZA], 2), startDate: '2026-08-14',
        matrixSource: 'haversine',
        labels: { basisEstimated: 'Distancias en línea recta, NO por carretera.' }
    });
    assert.ok(decodeIcs(icsProp(ics, 'DESCRIPTION')[0]).indexOf('línea recta') > 0);
});

test('X5 numbersUnreliable can be forced either way by the caller', function () {
    const plan = planFor(MADRID, BARCELONA, [ZARAGOZA], 2);
    assert.strictEqual(X.numbersUnreliable(plan, true), true);
    plan.warnings = ['unknown-distance: x'];
    assert.strictEqual(X.numbersUnreliable(plan, false), false);
    assert.strictEqual(X.numbersUnreliable(null), false);
    assert.strictEqual(X.numbersUnreliable({ warnings: 'not an array' }), false);
});

test('X5 model prose is labelled as a suggestion and kept below the engine facts', function () {
    const enrichment = {
        days: [{
            present: true,
            activities: ['Visit the cathedral'],
            lodging: 'Hostal Central',
            tip: 'Book ahead'
        }, { present: false, activities: [], lodging: '', tip: '' }]
    };
    const desc = decodeIcs(icsProp(X.buildIcs({
        plan: SIMPLE_PLAN, startDate: '2026-08-14', enrichment: enrichment
    }), 'DESCRIPTION')[0]);
    const heading = desc.indexOf('Suggestions (AI-generated');
    assert.ok(heading > 0, desc);
    assert.ok(desc.indexOf('Distance: ') < heading, 'engine facts must come first');
    assert.ok(desc.indexOf('Visit the cathedral') > heading);
    assert.ok(desc.indexOf('Hostal Central') > heading);
    assert.ok(desc.indexOf('Book ahead') > heading);
});

test('X5 model prose never reaches the GPX route or the SUMMARY line', function () {
    const enrichment = { days: [{ present: true, activities: ['Visit the cathedral'], lodging: '', tip: '' }] };
    const gpx = X.buildGpx({ plan: SIMPLE_PLAN, geometry: null, enrichment: enrichment });
    assert.ok(gpx.indexOf('cathedral') < 0, 'GPX carries the engine route only');
    const ics = X.buildIcs({ plan: SIMPLE_PLAN, startDate: '2026-08-14', enrichment: enrichment });
    const summaries = icsProp(ics, 'SUMMARY').join('\n');
    assert.ok(summaries.indexOf('cathedral') < 0);
});

test('X5 an empty enrichment day adds no heading', function () {
    const enrichment = { days: [{ present: true, activities: [], lodging: '  ', tip: '' }] };
    const desc = decodeIcs(icsProp(X.buildIcs({
        plan: SIMPLE_PLAN, startDate: '2026-08-14', enrichment: enrichment
    }), 'DESCRIPTION')[0]);
    assert.ok(desc.indexOf('Suggestions') < 0, desc);
});

test('X5 the GPX metadata totals equal the sum of the per-day values (quality bar B9)', function () {
    const gpx = X.buildGpx({ plan: SIMPLE_PLAN });
    const root = parseXml(gpx);
    const total = decodeXml(childText(findAll(root, 'metadata')[0], 'desc'));
    let km = 0;
    for (let i = 0; i < SIMPLE_PLAN.days.length; i++) {
        const v = SIMPLE_PLAN.days[i].km;
        km += v >= 10 ? Math.round(v) : Math.round(v * 10) / 10;
    }
    const shown = km >= 10 ? Math.round(km) : Math.round(km * 10) / 10;
    assert.ok(total.indexOf('Distance ' + shown + ' km') >= 0, total);
});

/* ════════════════════════════════════════════════════════════════════════════
   S1–S5 — the secondary findings, each failing against the previous build
   ════════════════════════════════════════════════════════════════════════════ */

test('S1 a trip that would run past 9999-12-31 emits no calendar, not a 9-digit date', function () {
    const oneDay = planFor(MADRID, BARCELONA, [], 1);
    /* the reproduction: DTEND used to roll to 100000101 */
    const last = X.buildIcs({ plan: oneDay, startDate: '9999-12-31', allDay: true });
    assert.strictEqual(last, '', 'a calendar with an unrepresentable DTEND was emitted');

    const threeDay = planFor(MADRID, BARCELONA, [ZARAGOZA], 3);
    assert.strictEqual(threeDay.days.length, 3);
    assert.strictEqual(X.buildIcs({ plan: threeDay, startDate: '9999-12-30' }), '');
    assert.strictEqual(X.buildIcs({ plan: threeDay, startDate: '9999-12-29' }), '');

    /* one day earlier the last DTEND is 9999-12-31, which fits — so this is a
       boundary, not a blanket refusal */
    const ok = X.buildIcs({ plan: threeDay, startDate: '9999-12-28' });
    assert.ok(ok.length > 0);
    const dates = icsProp(ok, 'DTSTART').concat(icsProp(ok, 'DTEND'), icsProp(ok, 'DTSTAMP'));
    for (let i = 0; i < dates.length; i++) {
        assert.ok(/^\d{8}(T\d{6}Z?)?$/.test(dates[i]), 'malformed date value ' + dates[i]);
    }
    assert.deepStrictEqual(icsProp(ok, 'DTEND')[2].slice(0, 8), '99991231');
});

test('S1 no caller-visible input produces a date field of the wrong width', function () {
    const plan = planFor(MADRID, BARCELONA, [ZARAGOZA], 2);
    const starts = ['0001-01-01', '1000-01-01', '2026-02-28', '9999-01-01', '9999-12-01'];
    for (let i = 0; i < starts.length; i++) {
        const ics = X.buildIcs({ plan: plan, startDate: starts[i] });
        if (!ics) continue;
        const lines = icsLines(ics);
        for (let k = 0; k < lines.length; k++) {
            const m = /^(DTSTART|DTEND|DTSTAMP)[;:].*?:?(\d{4,})/.exec(lines[k]);
            if (m) assert.ok(/^\d{8}/.test(m[2]), starts[i] + ' -> ' + lines[k]);
        }
    }
});

test('S2 an unreadable distance is "not available", never a manufactured zero', function () {
    const unknowns = [undefined, null, NaN, '?', Infinity, -1, {}];
    for (let i = 0; i < unknowns.length; i++) {
        const d = day(1, [leg(MADRID, BARCELONA, 100, 60)], { startTime: '09:00' });
        d.km = unknowns[i];
        d.driveMin = unknowns[i];
        const ics = X.buildIcs({ plan: mkPlan([d]), startDate: '2026-08-14' });
        const desc = decodeIcs(icsProp(ics, 'DESCRIPTION')[0]);
        assert.ok(desc.indexOf('Distance: not available') >= 0,
            'unknown #' + i + ' -> ' + desc);
        assert.ok(desc.indexOf('Drive time: not available') >= 0, desc);
        assert.ok(desc.indexOf('0 km') < 0, 'unknown #' + i + ' became a zero');
        assert.ok(desc.indexOf('0 min') < 0, 'unknown #' + i + ' became a zero');
        /* with no readable drive time there is no window to schedule */
        assert.ok(/^\d{8}$/.test(icsProp(ics, 'DTSTART')[0]));

        const gpx = X.buildGpx({ plan: mkPlan([d]) });
        parseXml(gpx);
        assert.ok(gpx.indexOf('0 km') < 0, 'GPX invented a zero for unknown #' + i);
        assert.ok(gpx.indexOf('not available') > 0);
    }
    assert.strictEqual(X.knownNonNeg(0), 0, 'a real zero is still a real zero');
    assert.strictEqual(X.knownNonNeg(NaN), null);
    assert.strictEqual(X.knownNonNeg('12.5'), 12.5);
});

test('S2 a trip total that skipped an unreadable day is labelled a floor', function () {
    const d1 = day(1, [leg(MADRID, ZARAGOZA, 300, 180)], { startTime: '09:00' });
    const d2 = day(2, [leg(ZARAGOZA, BARCELONA, 300, 180)], { startTime: '09:00' });
    d2.km = null;
    const gpx = X.buildGpx({ plan: mkPlan([d1, d2]) });
    const desc = decodeXml(childText(findAll(parseXml(gpx), 'metadata')[0], 'desc'));
    assert.ok(desc.indexOf('Distance at least 300 km') >= 0, desc);
    assert.ok(desc.indexOf('Drive time 6 h') >= 0, 'the readable half is still a total');

    /* and with everything readable it is not hedged */
    const clean = decodeXml(childText(findAll(parseXml(
        X.buildGpx({ plan: mkPlan([d1]) })), 'metadata')[0], 'desc'));
    assert.ok(clean.indexOf('at least') < 0, clean);
});

test('S2 two plans differing only in a KNOWN vs UNKNOWN distance get different UIDs', function () {
    const known = mkPlan([day(1, [leg(MADRID, BARCELONA, 0, 0)])]);
    const unknownDay = day(1, [leg(MADRID, BARCELONA, 0, 0)]);
    unknownDay.km = null; unknownDay.driveMin = null;
    assert.notStrictEqual(X.planSignature(known), X.planSignature(mkPlan([unknownDay])));
});

test('S3 uidSeed cannot inject a second VEVENT', function () {
    const payload = 'x\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nSUMMARY:PWNED';
    const ics = X.buildIcs({ plan: SIMPLE_PLAN, startDate: '2026-08-14', uidSeed: payload });
    const lines = icsLines(ics);
    let begins = 0;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i] === 'BEGIN:VEVENT') begins++;
        assert.notStrictEqual(lines[i], 'SUMMARY:PWNED', 'a forged property was injected');
    }
    assert.strictEqual(begins, 2, 'the calendar grew an extra component');
    /* the payload's letters may survive as inert characters — what must not
       survive is their structure */
    assert.strictEqual(icsProp(ics, 'SUMMARY').length, 2);
    const uids = icsProp(ics, 'UID');
    assert.strictEqual(uids.length, 2);
    for (let i = 0; i < uids.length; i++) {
        assert.ok(/^travio-[A-Za-z0-9._-]+-d\d+@travio\.app$/.test(uids[i]), uids[i]);
    }
    assert.strictEqual(icsProp(ics, 'DTSTAMP').length, 2, 'every event still has a DTSTAMP');
    /* a seed that is nothing but junk falls back to the derived one */
    const junk = X.buildIcs({ plan: SIMPLE_PLAN, startDate: '2026-08-14', uidSeed: '\r\n;,:' });
    assert.deepStrictEqual(icsProp(junk, 'UID'),
        icsProp(X.buildIcs({ plan: SIMPLE_PLAN, startDate: '2026-08-14' }), 'UID'));
    assert.strictEqual(X.safeUidSeed('route/42 ok!'), 'route42ok');
    assert.strictEqual(X.safeUidSeed('a'.repeat(200)).length, 64);
});

test('S3 prodId cannot inject a calendar property', function () {
    const ics = X.buildIcs({
        plan: SIMPLE_PLAN, startDate: '2026-08-14', prodId: 'a\r\nX-EVIL:1'
    });
    assert.ok(ics.indexOf('\r\nX-EVIL:1') < 0, 'a forged property was injected');
    assert.deepStrictEqual(icsCalProp(ics, 'X-EVIL'), []);
    assert.strictEqual(icsCalProp(ics, 'PRODID')[0], 'a\\nX-EVIL:1');
});

test('S3 css cannot break out of the style element', function () {
    const payload = '}</style><script>alert(1)</script><style>{';
    const html = X.buildPrintHtml({ css: payload });
    assert.ok(html.indexOf('<script>') < 0, 'script tag reached the page: ' + html);
    assert.ok(html.indexOf('</style><') < 0);
    assert.strictEqual((html.match(/<style>/g) || []).length, 1);
    assert.strictEqual((html.match(/<\/style>/g) || []).length, 1);
    /* CSS still works: the child combinator survives, only `<` is removed */
    assert.strictEqual(X.safeCss('.a > .b{color:red}'), '.a > .b{color:red}');
    assert.ok(X.buildPrintHtml({ css: '.day-card > p{margin:0}' }).indexOf('.day-card > p') > 0);
    /* case and spacing variants of the closing tag are all defused */
    const variants = ['</STYLE>', '</ style>', '</style\n>', '<\/style>'];
    for (let i = 0; i < variants.length; i++) {
        assert.ok(X.buildPrintHtml({ css: 'x{}' + variants[i] + 'y' })
            .indexOf('</style>\n</head>') > 0, 'variant ' + i);
    }
});

test('S3 only bodyHtml is documented as verbatim, and it is the only one that is', function () {
    const src = require('node:fs').readFileSync(
        path.join(__dirname, '..', 'js', 'route-export.js'), 'utf8');
    assert.ok(src.indexOf('`bodyHtml` is inserted verbatim') > 0, 'the contract is undocumented');
    const html = X.buildPrintHtml({
        bodyHtml: '<p>trusted</p>', title: '<b>t</b>', subtitle: '<b>s</b>',
        footer: '<b>f</b>', notes: ['<b>n</b>'], lang: 'ca'
    });
    assert.strictEqual((html.match(/<b>/g) || []).length, 0, 'an undocumented field passed markup');
    assert.ok(html.indexOf('<p>trusted</p>') > 0);
});

test('S5 unpaired surrogates never reach either format', function () {
    const lone = 'A\uD800B\uDC00C';
    assert.strictEqual(X.escapeXml(lone), 'ABC');
    assert.strictEqual(X.escapeIcs(lone), 'ABC');
    assert.strictEqual(X.escapeHtml(lone), 'ABC');
    /* a real astral character is untouched */
    assert.strictEqual(X.escapeXml('A\u{1F600}B'), 'A\u{1F600}B');
    assert.strictEqual(X.utf8Length(X.escapeIcs('A\u{1F600}B')), 6);

    const plan = mkPlan([day(1, [leg(P('Bad\uD800Name', 41, 2), BARCELONA, 10, 10)],
        { startTime: '09:00' })]);
    const gpx = X.buildGpx({ plan: plan });
    parseXml(gpx);
    assert.ok(gpx.indexOf('BadName') > 0);
    assert.ok(!/[\uD800-\uDFFF]/.test(gpx.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')),
        'a lone surrogate survived into the GPX');
    const ics = X.buildIcs({ plan: plan, startDate: '2026-08-14' });
    assert.ok(!/[\uD800-\uDFFF]/.test(ics.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')),
        'a lone surrogate survived into the ICS');
});

/* ════════════════════════════════════════════════════════════════════════════
   X6 — determinism
   ════════════════════════════════════════════════════════════════════════════ */

test('X6 the same input produces byte-identical output, every time', function () {
    const args = {
        plan: TRICKY_PLAN, startDate: '2026-08-14',
        geometry: [[[41.35, 2.05], [41.36, 2.10]], null, null],
        costs: { days: [{ total: 10, incomplete: false }, { total: 20, incomplete: true }, null] },
        enrichment: { days: [{ present: true, activities: ['a'], lodging: '', tip: '' }] }
    };
    const gpx1 = X.buildGpx(args), gpx2 = X.buildGpx(args);
    const ics1 = X.buildIcs(args), ics2 = X.buildIcs(args);
    const html1 = X.buildPrintHtml({ title: 'T', plainText: 'x' });
    const html2 = X.buildPrintHtml({ title: 'T', plainText: 'x' });
    assert.strictEqual(gpx1, gpx2);
    assert.strictEqual(ics1, ics2);
    assert.strictEqual(html1, html2);
    for (let i = 0; i < 5; i++) {
        assert.strictEqual(X.buildGpx(args), gpx1);
        assert.strictEqual(X.buildIcs(args), ics1);
    }
});

test('X6 the builders do not mutate the plan they are given', function () {
    const plan = planFor(MADRID, BARCELONA, [ZARAGOZA], 2);
    const before = JSON.stringify(plan);
    X.buildGpx({ plan: plan, geometry: [[[1, 2], [3, 4]]] });
    X.buildIcs({ plan: plan, startDate: '2026-08-14' });
    X.buildPrintHtml({ plan: plan });
    assert.strictEqual(JSON.stringify(plan), before);
});

test('X6 label overrides do not leak into the next call', function () {
    const custom = X.buildIcs({ plan: SIMPLE_PLAN, startDate: '2026-08-14', labels: { day: 'Jour {day}' } });
    assert.ok(decodeIcs(icsProp(custom, 'SUMMARY')[0]).indexOf('Jour 1') === 0);
    const plain = X.buildIcs({ plan: SIMPLE_PLAN, startDate: '2026-08-14' });
    assert.ok(decodeIcs(icsProp(plain, 'SUMMARY')[0]).indexOf('Day 1') === 0);
    assert.strictEqual(X.DEFAULT_LABELS.day, 'Day {day}');
});

test('X6 non-string label overrides are ignored, not interpolated', function () {
    const ics = X.buildIcs({
        plan: SIMPLE_PLAN, startDate: '2026-08-14',
        labels: { day: 42, distance: null, km: {} }
    });
    assert.ok(decodeIcs(icsProp(ics, 'SUMMARY')[0]).indexOf('Day 1') === 0);
    assert.ok(ics.indexOf('[object Object]') < 0);
});

test('X6 planUidSeed and planSignature are stable and route-sensitive', function () {
    const a = planFor(MADRID, BARCELONA, [ZARAGOZA], 2);
    const b = planFor(MADRID, BARCELONA, [ZARAGOZA], 2);
    assert.strictEqual(X.planSignature(a), X.planSignature(b));
    assert.strictEqual(X.planUidSeed(a, '2026-08-14'), X.planUidSeed(b, '2026-08-14'));
    const c = planFor(MADRID, BARCELONA, [AMP], 2);
    assert.notStrictEqual(X.planSignature(a), X.planSignature(c));
    assert.ok(/^[0-9a-z]+$/.test(X.planUidSeed(a, '2026-08-14')));
    assert.ok(X.planUidSeed(null, null).length > 0, 'a seed exists even for an empty plan');
});

/* ════════════════════════════════════════════════════════════════════════════
   Printable HTML
   ════════════════════════════════════════════════════════════════════════════ */

test('print HTML is a standalone document with a charset and a print stylesheet', function () {
    const html = X.buildPrintHtml({ title: 'Madrid → Barcelona', plainText: 'body' });
    assert.ok(html.indexOf('<!DOCTYPE html>') === 0);
    assert.ok(html.indexOf('<meta charset="utf-8">') > 0);
    assert.ok(html.indexOf('@media print') > 0);
    assert.ok(html.indexOf('@page') > 0);
    assert.ok(html.indexOf('page-break-inside:avoid') > 0, 'day cards must not split across pages');
    assert.ok(html.indexOf('</html>') > 0);
    assert.ok(html.indexOf('http://') < 0 && html.indexOf('https://') < 0,
        'the printable page must not fetch anything');
});

test('print HTML escapes the title, subtitle, notes and footer', function () {
    const html = X.buildPrintHtml({
        title: 'Sant Joan Despí & Cornellà',
        subtitle: '<script>alert(1)</script>',
        notes: ["L'Hospitalet <centre>", '', null],
        footer: 'Zaragoza "La Seo"'
    });
    assert.ok(html.indexOf('<script>') < 0, 'unescaped markup reached the page');
    assert.ok(html.indexOf('&lt;script&gt;') > 0);
    assert.ok(html.indexOf('Despí &amp; Cornellà') > 0);
    assert.ok(html.indexOf('L&#39;Hospitalet &lt;centre&gt;') > 0);
    assert.ok(html.indexOf('&quot;La Seo&quot;') > 0);
    assert.strictEqual((html.match(/<li>/g) || []).length, 1, 'blank and null notes are dropped');
});

test('print HTML escapes plainText but passes rendered bodyHtml through', function () {
    const escaped = X.buildPrintHtml({ plainText: 'a < b & c\nsecond line' });
    assert.ok(escaped.indexOf('<pre>a &lt; b &amp; c\nsecond line</pre>') > 0,
        'plain text keeps its line breaks inside <pre>');

    const passed = X.buildPrintHtml({ bodyHtml: '<div class="day-card">already escaped</div>' });
    assert.ok(passed.indexOf('<div class="day-card">already escaped</div>') > 0);
});

test('print HTML prefers bodyHtml over plainText, and survives having neither', function () {
    const both = X.buildPrintHtml({ bodyHtml: '<p>rendered</p>', plainText: 'mirror' });
    assert.ok(both.indexOf('<p>rendered</p>') > 0);
    assert.ok(both.indexOf('mirror') < 0, 'the same itinerary must not print twice');
    const neither = X.buildPrintHtml({ title: 'Empty' });
    assert.ok(neither.indexOf('<main class="print-body"></main>') > 0);
});

test('print HTML derives its title from the plan when none is given', function () {
    const html = X.buildPrintHtml({ plan: SIMPLE_PLAN });
    assert.ok(html.indexOf('<title>Madrid → Barcelona</title>') > 0, html.slice(0, 400));
});

test('print HTML takes a lang attribute and rejects a malformed one', function () {
    assert.ok(X.buildPrintHtml({ lang: 'ca' }).indexOf('<html lang="ca">') > 0);
    assert.ok(X.buildPrintHtml({ lang: 'zh-CN' }).indexOf('<html lang="zh-CN">') > 0);
    assert.ok(X.buildPrintHtml({ lang: '"><script>' }).indexOf('<html lang="en">') > 0);
});

test('print HTML accepts a custom stylesheet and exposes the default one', function () {
    assert.ok(X.PRINT_CSS.indexOf('.day-card') > 0);
    assert.ok(X.PRINT_CSS.indexOf('#10B981') > 0, 'the Travio emerald, not SML red');
    const html = X.buildPrintHtml({ css: 'body{color:red}' });
    assert.ok(html.indexOf('<style>body{color:red}</style>') > 0);
    assert.ok(html.indexOf('@media print') < 0);
});

test('print HTML styles the classes itinerary-render.js actually emits', function () {
    const needed = ['.summary-card', '.day-card', '.cost-table', '.notice', '.leg-list',
        '.enrich-list', '.mono', '.day-head', '.stat'];
    for (let i = 0; i < needed.length; i++) {
        assert.ok(X.PRINT_CSS.indexOf(needed[i]) >= 0, 'no print style for ' + needed[i]);
    }
});

/* ════════════════════════════════════════════════════════════════════════════
   File names and module shape
   ════════════════════════════════════════════════════════════════════════════ */

test('safeFileName produces an ASCII, extension-suffixed name', function () {
    assert.strictEqual(X.safeFileName('Sant Joan Despí & Cornellà', 'gpx'),
        'sant-joan-despi-cornella.gpx');
    assert.strictEqual(X.safeFileName('Madrid → Barcelona', 'ics'), 'madrid-barcelona.ics');
    assert.strictEqual(X.safeFileName('', 'gpx'), 'travio-route.gpx');
    assert.strictEqual(X.safeFileName('///', 'ics'), 'travio-route.ics');
    assert.strictEqual(X.safeFileName('a'.repeat(200), 'html').length, 65);
    assert.ok(X.safeFileName('../../etc/passwd', 'gpx').indexOf('/') < 0);
});

test('the module exports the documented surface and attaches to window in a browser', function () {
    const fns = ['buildGpx', 'buildIcs', 'buildPrintHtml', 'escapeXml', 'escapeIcs',
        'foldIcsLine', 'utf8Length', 'parseDate', 'addDays', 'planUidSeed',
        'numbersUnreliable', 'safeFileName', 'coord', 'normaliseGeometry'];
    for (let i = 0; i < fns.length; i++) {
        assert.strictEqual(typeof X[fns[i]], 'function', fns[i] + ' is not exported');
    }
    assert.strictEqual(typeof X.PRINT_CSS, 'string');
    const src = require('node:fs').readFileSync(
        path.join(__dirname, '..', 'js', 'route-export.js'), 'utf8');
    assert.ok(src.indexOf("window.TravioExport = api") > 0, 'no browser global');
    assert.ok(src.indexOf('module.exports = api') > 0, 'no Node export');
    assert.ok(!/^\s*(import|export)[\s{]/m.test(src), 'no ES module syntax');
});

test('the exporter consumes the real engine contract types end to end', function () {
    const plan = planFor(AMP, AMP, [ANGLE, QUOTE, SEMI], 4);   /* round trip, 4 days */
    assert.strictEqual(plan.roundTrip, true);
    const gpx = X.buildGpx({ plan: plan, name: 'Volta pel país' });
    const root = parseXml(gpx);
    assert.strictEqual(decodeXml(childText(findAll(root, 'metadata')[0], 'name')), 'Volta pel país');
    const ics = X.buildIcs({ plan: plan, startDate: '2026-08-14', name: 'Volta pel país' });
    assert.strictEqual(icsProp(ics, 'UID').length, 4);
    const raw = physicalLines(ics);
    for (let i = 0; i < raw.length; i++) assert.ok(X.utf8Length(raw[i]) <= 75);
    const html = X.buildPrintHtml({ plan: plan, plainText: 'summary' });
    assert.ok(html.indexOf('Volta') < 0, 'the print title comes from the plan unless given');
    assert.ok(X.buildPrintHtml({ plan: plan, title: 'Volta pel país' })
        .indexOf('<title>Volta pel país</title>') > 0);
});
