/* ── Travio Export ── GPX 1.1 · iCalendar (RFC 5545) · printable HTML ── */
/*
 * Classic script. No ES modules, no bundler, no npm dependency.
 * Works in the browser (attaches to `window.TravioExport`) and in Node for
 * tests (`module.exports`).
 *
 * PURITY. Nothing here touches the DOM, the network, Date.now(), or any source
 * of randomness. Every function is a string builder: same input, same output,
 * byte for byte. The caller wraps the returned string in a Blob and a download
 * attribute — nothing leaves the device.
 *
 *   - the trip start date is a PARAMETER. iCalendar needs DTSTART and DTSTAMP,
 *     and reading the clock for either would make this module impure and its
 *     tests non-deterministic. No date in, no calendar out (see buildIcs).
 *   - UIDs are derived from the plan itself, not from a random number, so
 *     re-exporting the same trip updates the same calendar entries instead of
 *     duplicating them.
 *
 * HONESTY. The deterministic plan produced by js/route-engine.js is the SOURCE
 * OF TRUTH for route, days, distances and times. Model prose may appear only as
 * a description, under a heading that says so. And a number the app does not
 * know is never exported: an unknown toll must not become a zero, so a day whose
 * cost is a FLOOR is exported with its "at least" wording or not at all, and a
 * plan whose distances the engine declared unusable exports no distances.
 */

(function () {
    'use strict';

    /* ── Labels ──────────────────────────────────────────────────────────────
       GPX is machine-facing and its structural words stay English by
       convention, but an ICS description lands in the traveller's calendar in
       their own language. Rather than pull i18n.js into a pure module, every
       user-visible word is a template the caller may override; the defaults
       below are the English fallback. */
    const DEFAULT_LABELS = {
        trip:         'Travio route',
        day:          'Day {day}',
        arrow:        ' → ',
        start:        'Start',
        end:          'End',
        stop:         'Stop',
        overnight:    'Overnight',
        restDay:      'Rest day',
        restDayAt:    'Rest day in {place}',
        distance:     'Distance',
        driveTime:    'Drive time',
        stops:        'Stops',
        cost:         'Estimated cost: {amount}',
        costFloor:    'Estimated cost: at least {amount} (incomplete — some costs are unknown)',
        suggestions:  'Suggestions (AI-generated, not part of the computed route)',
        lodging:      'Where to sleep',
        tip:          'Local tip',
        viaPoints:    'Planned via points. Straight lines between them are NOT the road route.',
        roadTrack:    'Track from the routing service road geometry.',
        unlocated:    '{count} place(s) could not be located and are omitted from this file.',
        /* The five provenance states a distance can be in. Four of them still
           print the number; only the fifth withholds it. */
        basisRoad:        'Distances and times come from the road graph.',
        basisPartial:     'Some of these distances are straight-line estimates, not driving distances.',
        basisUnconfirmed: 'The provenance of these distances could not be confirmed: some or all of ' +
                          'them may be straight-line estimates rather than measured driving distances.',
        basisEstimated:   'STRAIGHT-LINE ESTIMATES, not driving distances: no road data was available, ' +
                          'so these figures are crow-flies distances with a road allowance and an assumed speed.',
        unreliable:     'Distances and times could not be computed for this trip and are omitted.',
        notAvailable:   'not available',
        atLeast:        'at least {value}',
        longDay:        'Long driving day: {drive}, above the {cap} the planner was given.',
        longDayNoCap:   'Long driving day: above the daily limit the planner was given.',
        plannerNotes:   'Planner notes',
        km:           'km',
        hour:         'h',
        minute:       'min',
        currency:     'EUR'
    };

    const GPX_CREATOR = 'Travio route planner';
    const ICS_PRODID  = '-//Travio//Route Planner//EN';
    const UID_DOMAIN  = 'travio.app';

    /* ── Distance provenance: FOUR states, only one of which withholds ────────
       The first version of this module had two: print the number, or print
       nothing. That is a strictly weaker guarantee than the screen gives, at
       the moment it most needs to be stronger.

       When OSRM is down the geo provider falls back to haversine × 1.25 at an
       assumed speed. The engine then warns `distance-source: no road data at
       all` and js/itinerary-render.js raises it to `alert`, its LOUDEST
       severity. Those numbers are usable — suppressing them would be
       over-firing — but they are crow-flies estimates, and Madrid→Barcelona
       comes out at 632 km against 620 real road km. The figure is PLAUSIBLE,
       which is exactly what makes an unqualified one dangerous a week later in
       a calendar with no app around it to explain itself.

       So the fix is not to withhold more, it is to QUALIFY. `road`, `partial`
       and `estimated` all print the number with a sentence saying what kind of
       number it is; only `unusable` withholds.

       `matrixSource` is the authoritative claim, and it is the same value
       renderSummary() reads out of view.meta.matrixSource. Warnings are the
       evidence and may only DOWNGRADE that claim, never upgrade it — the
       counters are the evidence, the label is the claim.

       An ABSENT or unrecognised source is its own state, `unconfirmed`, and
       not a synonym for `estimated`. Silence is not evidence of a road graph,
       so it can never read as road data; but it is not evidence of the absence
       of one either, and telling a traveller with a 70%-real matrix that "no
       road data was available" is the same lie in the other direction — the
       exact bug js/itinerary-render.js was fixed for. `unconfirmed` says only
       what is true: this could be either. A caller that knows the source
       should pass it and get a crisper sentence; a caller that does not also
       gets the engine's own warning verbatim (see distanceSourceCovered). */
    const BASIS_RANK = { road: 0, partial: 1, unconfirmed: 2, estimated: 3, unusable: 4 };

    /* Warnings that make the numbers unusable. Deliberately identical to
       UNRELIABLE_WARNINGS in js/itinerary-render.js: the file and the screen
       must withhold on exactly the same evidence, or one of them is lying.
       `invalid-distance` is NOT in this set for the same reason it is not in
       the screen's — the engine sanitises those cells and carries on. */
    const UNRELIABLE_WARNINGS = { 'zero-distance': 1, 'unknown-distance': 1 };

    /* Evidence that downgrades the claimed provenance, and how far. A
       `distance-source` warning is evidence too: the engine emits none at all
       for a clean road matrix, so its presence means the matrix is at best
       partly estimated whatever the label says. */
    const BASIS_EVIDENCE = {
        'distance-source':      'partial',      /* not a clean road matrix      */
        'distance-fallback':    'partial',      /* gaps filled with estimates   */
        'missing-matrix':       'estimated',    /* nothing to route from at all */
        'matrix-size-mismatch': 'unconfirmed',  /* the matrix was discarded     */
        'invalid-distance':     'unconfirmed'   /* cells had to be repaired     */
    };

    /* ── Which engine warnings reach an exported file, and how ───────────────
       All 20 codes the engine can emit are accounted for. These 11 are
       represented STRUCTURALLY — as a title, a qualifier or a counted note —
       so repeating their English prose would be duplication, not information.
       Every other code is surfaced VERBATIM in the planner notes, the same
       "never swallowed" rule js/itinerary-render.js applies with its
       {code:'other'} catch-all. Nothing is dropped. */
    const COVERED_WARNINGS = {
        'rest-day':             1,   /* the day's own title says "Rest day in X"   */
        'over-drive-cap':       1,   /* the long-driving-day line (quality bar B6) */
        'round-trip':           1,   /* the route visibly returns to its origin    */
        'unresolved-place':     1,   /* the "N place(s) could not be located" note */
        'distance-source':      1,   /* the provenance qualifier                   */
        'distance-fallback':    1,   /* the provenance qualifier                   */
        'missing-matrix':       1,   /* the provenance qualifier                   */
        'matrix-size-mismatch': 1,   /* the provenance qualifier                   */
        'invalid-distance':     1,   /* the provenance qualifier                   */
        'zero-distance':        1,   /* the provenance qualifier (withheld)        */
        'unknown-distance':     1    /* the provenance qualifier (withheld)        */
    };

    /* ── Tiny pure helpers ── */
    function num(v, def) {
        if (v === null || v === undefined || v === '') return def;
        const n = Number(v);
        return isFinite(n) ? n : def;
    }
    function nonNeg(v, def) { const n = num(v, NaN); return isFinite(n) && n >= 0 ? n : def; }
    function str(v) { return v === null || v === undefined ? '' : String(v); }
    function arr(v) { return Array.isArray(v) ? v : []; }

    function fill(template, params) {
        if (typeof template !== 'string') return '';
        if (!params) return template;
        return template.replace(/\{(\w+)\}/g, function (m, k) {
            return Object.prototype.hasOwnProperty.call(params, k) ? String(params[k]) : m;
        });
    }

    function labelsOf(custom) {
        const out = {};
        for (const k in DEFAULT_LABELS) {
            if (Object.prototype.hasOwnProperty.call(DEFAULT_LABELS, k)) out[k] = DEFAULT_LABELS[k];
        }
        if (custom && typeof custom === 'object') {
            for (const k in custom) {
                if (Object.prototype.hasOwnProperty.call(custom, k) &&
                    typeof custom[k] === 'string') out[k] = custom[k];
            }
        }
        return out;
    }

    /* ── Escaping, per format ────────────────────────────────────────────────
       Two formats, two rulesets, and neither one covers the other. These are
       ordinary place names in this project and each of them breaks exactly one
       of the two formats when left raw:
         "Sant Joan Despi & Cornella"  -> XML entity
         "L'Hospitalet <centre>"       -> XML tag
         'Zaragoza "La Seo"'           -> XML attribute (and quoting habits)
         "Valencia; Ciutat Vella"      -> ICS property-value separator
    */
    function escapeMarkup(s, keepNewline) {
        return stripControl(str(s), keepNewline)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /* GPX values live on one line here, so a stray newline is dropped. */
    function escapeXml(s) { return escapeMarkup(s, false); }

    /* RFC 5545 §3.3.11: in a TEXT value, BACKSLASH, SEMICOLON, COMMA and
       newline are escaped. COLON is NOT — escaping it is a common myth and
       some parsers render the backslash. */
    function escapeIcs(s) {
        return stripControl(str(s).replace(/\r\n/g, '\n').replace(/\r/g, '\n'), true)
            .replace(/\\/g, '\\\\')
            .replace(/;/g, '\\;')
            .replace(/,/g, '\\,')
            .replace(/\n/g, '\\n');
    }

    /* HTML keeps its newlines: the plain-text mirror is printed inside <pre>. */
    function escapeHtml(s) { return escapeMarkup(s, true); }

    /* Drops C0/DEL controls and UNPAIRED surrogates. A lone surrogate is not a
       character: it cannot be encoded as UTF-8, so it turns a well-formed
       document into bytes no strict parser will accept. */
    function stripControl(s, keepNewline) {
        let out = '';
        for (let i = 0; i < s.length; i++) {
            const c = s.charCodeAt(i);
            if (c === 10 && keepNewline) { out += '\n'; continue; }
            if (c < 0x20 || c === 0x7f) continue;
            if (c >= 0xd800 && c <= 0xdbff) {
                const next = s.charCodeAt(i + 1);
                if (next >= 0xdc00 && next <= 0xdfff) { out += s.charAt(i) + s.charAt(i + 1); i++; }
                continue;                      /* unpaired high surrogate */
            }
            if (c >= 0xdc00 && c <= 0xdfff) continue;   /* unpaired low surrogate */
            out += s.charAt(i);
        }
        return out;
    }

    /* A UID has no escape syntax, so the seed is restricted rather than
       escaped: anything outside this set could only ever be a way out of the
       property value. */
    function safeUidSeed(v) {
        return stripControl(str(v)).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64);
    }

    /* CSS is not markup and must not be HTML-escaped — `.a > .b` would stop
       working. The ONLY way out of a <style> element is the literal `</`, and
       the HTML tokenizer does not decode CSS escapes, so removing `<` closes
       the hole while leaving the child combinator intact. */
    function safeCss(v) {
        return stripControl(str(v), true).replace(/</g, '');
    }

    /* ── UTF-8 aware line folding (RFC 5545 §3.1) ────────────────────────────
       "Lines of text SHOULD NOT be longer than 75 OCTETS, excluding the line
       break." Octets, not characters — and with accented place names those are
       not the same thing: 75 characters of Catalan/Spanish names measured 83
       octets in a real export, which is out of spec.

       Two consequences the naive implementation gets wrong:
         1. a multi-byte character must never be split across the fold, so the
            budget is spent per CODE POINT (the equivalent of cutting at 75
            bytes and then backing off over any 10xxxxxx continuation byte);
         2. a continuation line begins with a single space that COUNTS toward
            its 75 octets, so its content budget is 74, not 75.
       Folding is byte-transparent — unfolding restores the original octets
       exactly — but a lone trailing backslash is still moved to the next line
       so that no naive parser ever sees half of an escape pair. */
    const FOLD_LIMIT = 75;

    function utf8LenOfCodePoint(cp) {
        if (cp < 0x80) return 1;
        if (cp < 0x800) return 2;
        if (cp < 0x10000) return 3;
        return 4;
    }

    function utf8Length(s) {
        const v = str(s);
        let n = 0;
        for (let i = 0; i < v.length;) {
            const cp = v.codePointAt(i);
            n += utf8LenOfCodePoint(cp);
            i += cp > 0xffff ? 2 : 1;
        }
        return n;
    }

    function trailingBackslashes(s) {
        let n = 0;
        for (let i = s.length - 1; i >= 0 && s.charAt(i) === '\\'; i--) n++;
        return n;
    }

    function foldIcsLine(line) {
        const s = str(line);
        if (utf8Length(s) <= FOLD_LIMIT) return s;
        const parts = [];
        let cur = '', bytes = 0, limit = FOLD_LIMIT;
        for (let i = 0; i < s.length;) {
            const cp = s.codePointAt(i);
            const ch = String.fromCodePoint(cp);
            const n = utf8LenOfCodePoint(cp);
            if (bytes + n > limit) {
                let seg = cur, carry = '';
                if (trailingBackslashes(seg) % 2 === 1) {
                    seg = seg.slice(0, -1);
                    carry = '\\';
                }
                parts.push(seg);
                cur = carry + ch;
                bytes = utf8Length(cur);
                limit = FOLD_LIMIT - 1;     /* the leading space costs one octet */
                i += ch.length;
                continue;
            }
            cur += ch;
            bytes += n;
            i += ch.length;
        }
        parts.push(cur);
        return parts.join('\r\n ');
    }

    function unfoldIcs(text) {
        return str(text).replace(/\r\n[ \t]/g, '');
    }

    /* ── Places and coordinates ── */
    function hasCoords(p) {
        if (!p) return false;
        const lat = num(p.lat, NaN), lon = num(p.lon, NaN);
        return isFinite(lat) && isFinite(lon) &&
            lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
    }

    /* Fixed 6-decimal rounding with the trailing zeros trimmed: ~0.1 m, stable
       across platforms, and free of the "-0" that some importers choke on. */
    function coord(n) {
        let v = Math.round(num(n, 0) * 1e6) / 1e6;
        if (Object.is(v, -0)) v = 0;
        let s = v.toFixed(6);
        if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
        return s;
    }

    function placeName(p) { return p && p.name ? str(p.name) : ''; }

    /* ── Plan reading ────────────────────────────────────────────────────────
       Everything below reads the ENGINE's days and legs. Nothing is inferred,
       re-ordered or re-optimised here; an exporter that re-derives the route
       is a second planner with none of the tests. */
    function planDays(plan) { return plan && Array.isArray(plan.days) ? plan.days : []; }

    /* The places a day visits, in order: where it starts, then the arrival of
       each leg. A rest day has no legs and yields its single place. */
    function dayNodes(day) {
        const d = day || {};
        const legs = arr(d.legs);
        const out = [];
        if (d.startPlace) out.push(d.startPlace);
        else if (legs.length && legs[0] && legs[0].from) out.push(legs[0].from);
        for (let i = 0; i < legs.length; i++) {
            if (legs[i] && legs[i].to) out.push(legs[i].to);
        }
        if (out.length === 0 && d.endPlace) out.push(d.endPlace);
        return out;
    }

    function locatedNodes(day) {
        const nodes = dayNodes(day);
        const out = [];
        for (let i = 0; i < nodes.length; i++) if (hasCoords(nodes[i])) out.push(nodes[i]);
        return out;
    }

    function isRestDay(day) { return arr(day && day.legs).length === 0; }

    function dayNumber(day, index) { return Math.round(num(day && day.day, index + 1)); }

    function warningCode(w) {
        const s = str(w);
        return s.indexOf(':') > 0 ? s.slice(0, s.indexOf(':')) : s;
    }

    function worse(a, b) { return BASIS_RANK[b] > BASIS_RANK[a] ? b : a; }

    /* 'road' | 'partial' | 'estimated' | 'unusable'. See BASIS_RANK above. */
    function distanceBasis(plan, opts) {
        const o = opts || {};
        const src = str(o.matrixSource);
        let basis = src === 'osrm' ? 'road'
            : (src === 'mixed' ? 'partial'
                : (src === 'haversine' ? 'estimated' : 'unconfirmed'));

        const warnings = arr(plan && plan.warnings);
        for (let i = 0; i < warnings.length; i++) {
            const code = warningCode(warnings[i]);
            if (UNRELIABLE_WARNINGS[code]) { basis = 'unusable'; break; }
            if (BASIS_EVIDENCE[code]) basis = worse(basis, BASIS_EVIDENCE[code]);
        }
        /* The caller's explicit verdict wins in both directions, but `false`
           only rules out withholding — it cannot promise road data. */
        if (o.numbersUnreliable === true) basis = 'unusable';
        else if (o.numbersUnreliable === false && basis === 'unusable') basis = 'estimated';
        return basis;
    }

    /* Kept as the yes/no question the rest of the module used to ask. */
    function numbersUnreliable(plan, override) {
        return distanceBasis(plan, { numbersUnreliable: override }) === 'unusable';
    }

    function basisNote(basis, L) {
        if (basis === 'road') return L.basisRoad;
        if (basis === 'partial') return L.basisPartial;
        if (basis === 'unconfirmed') return L.basisUnconfirmed;
        if (basis === 'unusable') return L.unreliable;
        return L.basisEstimated;
    }

    /* ── When "covered structurally" stops being true ────────────────────────
       `distance-source` is covered by the qualifier only while the qualifier
       says everything the warning says. Exactly two claims do that: 'mixed'
       lands on `partial` and 'haversine' on `estimated`, each stating the same
       fact the engine stated.

       The other two do not. An 'osrm' claim the engine warned about anyway is
       a CONTRADICTION — the engine emits nothing for a clean road matrix — and
       which contradiction it is (no road data at all, counters disagreeing
       with the label) is detail no qualifier carries. An ABSENT claim lands on
       `unconfirmed`, which is deliberately weaker than the warning it would be
       standing in for. In both cases the engine's own sentence is surfaced
       verbatim as well, so a caller that passes no matrixSource still gets
       everything the screen would have shown. */
    function distanceSourceCovered(matrixSource) {
        const src = str(matrixSource);
        return src === 'mixed' || src === 'haversine';
    }

    /* Engine warnings that no other part of the file already states. */
    function residualWarnings(plan, opts) {
        const covered = distanceSourceCovered(opts && opts.matrixSource);
        const out = [], seen = {};
        const warnings = arr(plan && plan.warnings);
        for (let i = 0; i < warnings.length; i++) {
            const t = str(warnings[i]).trim();
            if (!t || seen[t]) continue;
            const code = warningCode(t);
            if (COVERED_WARNINGS[code] && !(code === 'distance-source' && !covered)) continue;
            seen[t] = 1;
            out.push(t);
        }
        return out;
    }

    /* ── Reading a number the plan may not actually have ─────────────────────
       `num(v, 0)` turns undefined, null, NaN, '?' and Infinity into a zero, and
       a zero is a claim: "this day involves no driving". Today's engine
       guarantees finite values, so nothing reaches this from the live path —
       but a saved document, a hand-built plan or a future provider can, and
       silently exporting a manufactured zero is precisely the bug class this
       branch exists to kill. Unknown reads as null and PRINTS as "not
       available". */
    function knownNonNeg(v) {
        if (v === null || v === undefined || v === '') return null;
        const n = Number(v);
        return isFinite(n) && n >= 0 ? n : null;
    }
    function kmText(km, L) {
        const v = knownNonNeg(km);
        return v === null ? L.notAvailable : formatKm(v, L);
    }
    /* A trip total: complete, a floor, or — when not one day could be read —
       simply unknown. "at least 0 km" would be a manufactured zero wearing a
       hedge. */
    function totalText(value, seen, dayCount, formatter, L) {
        if (seen === 0) return L.notAvailable;
        const text = formatter(value, L);
        return seen < dayCount ? fill(L.atLeast, { value: text }) : text;
    }
    function durationText(min, L) {
        const v = knownNonNeg(min);
        return v === null ? L.notAvailable : formatDuration(v, L);
    }

    /* The long-driving-day flag is a DayPlan field, so it needs no prose
       parsing. The cap is NOT a plan field — quoting a default the planner may
       never have used would export a number the app does not know, so without
       it the warning simply drops the figure. */
    function longDayNote(day, L, maxDriveMin) {
        if (!day || day.overDriveCap !== true) return '';
        const cap = knownNonNeg(maxDriveMin);
        const drive = knownNonNeg(day.driveMin);
        if (cap === null || drive === null) return L.longDayNoCap;
        return fill(L.longDay, {
            drive: formatDuration(drive, L),
            cap: formatDuration(cap, L)
        });
    }

    function countUnlocated(plan) {
        const seen = {};
        let n = 0;
        const days = planDays(plan);
        for (let i = 0; i < days.length; i++) {
            const nodes = dayNodes(days[i]);
            for (let k = 0; k < nodes.length; k++) {
                if (hasCoords(nodes[k])) continue;
                const key = placeName(nodes[k]) || ('#' + i + '.' + k);
                if (seen[key]) continue;
                seen[key] = 1;
                n++;
            }
        }
        const order = arr(plan && plan.order);
        for (let i = 0; i < order.length; i++) {
            if (hasCoords(order[i])) continue;
            const key = placeName(order[i]) || ('@' + i);
            if (seen[key]) continue;
            seen[key] = 1;
            n++;
        }
        return n;
    }

    function tripName(plan, explicit, L) {
        const given = str(explicit).trim();
        if (given) return given;
        const days = planDays(plan);
        if (days.length) {
            const first = days[0] || {};
            const from = placeName(first.startPlace) ||
                placeName((arr(first.legs)[0] || {}).from);
            const last = days[days.length - 1] || {};
            const to = placeName(last.endPlace) || from;
            if (from && to && from !== to) return from + L.arrow + to;
            if (from) return from;
        }
        return L.trip;
    }

    /* ── Formatting the engine's numbers ── */
    function roundKm(km) {
        const v = num(km, 0);
        return v >= 10 ? Math.round(v) : Math.round(v * 10) / 10;
    }
    function formatKm(km, L) { return roundKm(km) + ' ' + L.km; }

    function formatDuration(minutes, L) {
        const m = Math.max(0, Math.round(num(minutes, 0)));
        const h = Math.floor(m / 60), r = m % 60;
        if (h === 0) return r + ' ' + L.minute;
        if (r === 0) return h + ' ' + L.hour;
        return h + ' ' + L.hour + ' ' + r + ' ' + L.minute;
    }
    function formatMoney(v, L) { return L.currency + ' ' + num(v, 0).toFixed(2); }

    /* ── Civil-date arithmetic, no Date object, no timezone ──────────────────
       Howard Hinnant's days-from-civil. A trip that starts on 2026-02-28 must
       roll into 2026-03-01 and one starting 2024-02-28 into 2024-02-29, and
       doing that through a Date object drags the host timezone into a pure
       function (a UTC-midnight Date read back with getDate() is the previous
       day west of Greenwich). Integer arithmetic has no such opinion. */
    function daysInMonth(y, m) {
        const lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        if (m === 2 && ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0)) return 29;
        return lengths[m - 1];
    }

    function parseDate(v) {
        if (v === null || v === undefined || v === '') return null;
        let y, m, d;
        if (Object.prototype.toString.call(v) === '[object Date]') {
            const t = v.getTime();
            if (!isFinite(t)) return null;
            y = v.getFullYear(); m = v.getMonth() + 1; d = v.getDate();
        } else if (typeof v === 'object') {
            y = num(v.y !== undefined ? v.y : v.year, NaN);
            m = num(v.m !== undefined ? v.m : v.month, NaN);
            d = num(v.d !== undefined ? v.d : v.day, NaN);
        } else {
            const s = str(v).trim();
            const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(s) ||
                /^(\d{4})(\d{2})(\d{2})$/.exec(s);
            if (!match) return null;
            y = parseInt(match[1], 10); m = parseInt(match[2], 10); d = parseInt(match[3], 10);
        }
        if (!(isFinite(y) && isFinite(m) && isFinite(d))) return null;
        y = Math.round(y); m = Math.round(m); d = Math.round(d);
        if (y < 1 || y > 9999 || m < 1 || m > 12) return null;
        if (d < 1 || d > daysInMonth(y, m)) return null;
        return { y: y, m: m, d: d };
    }

    function daysFromCivil(y, m, d) {
        const yy = y - (m <= 2 ? 1 : 0);
        const era = Math.floor(yy / 400);
        const yoe = yy - era * 400;
        const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
        const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
        return era * 146097 + doe - 719468;
    }

    function civilFromDays(z) {
        const zz = z + 719468;
        const era = Math.floor(zz / 146097);
        const doe = zz - era * 146097;
        const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) -
            Math.floor(doe / 146096)) / 365);
        const y = yoe + era * 400;
        const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
        const mp = Math.floor((5 * doy + 2) / 153);
        const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
        const m = mp + (mp < 10 ? 3 : -9);
        return { y: y + (m <= 2 ? 1 : 0), m: m, d: d };
    }

    function addDays(date, n) {
        return civilFromDays(daysFromCivil(date.y, date.m, date.d) + Math.round(num(n, 0)));
    }

    function pad(n, width) {
        let s = String(Math.abs(Math.round(n)));
        while (s.length < width) s = '0' + s;
        return s;
    }
    function formatIcsDate(date) { return pad(date.y, 4) + pad(date.m, 2) + pad(date.d, 2); }
    function formatIcsDateTime(date, minutes) {
        const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
        return formatIcsDate(date) + 'T' + pad(Math.floor(m / 60), 2) + pad(m % 60, 2) + '00';
    }

    function parseClock(value) {
        if (typeof value !== 'string') return null;
        const m = /^\s*(\d{1,2})\s*:\s*(\d{2})\s*$/.exec(value);
        if (!m) return null;
        const h = parseInt(m[1], 10), mi = parseInt(m[2], 10);
        if (!(h >= 0 && h <= 23 && mi >= 0 && mi <= 59)) return null;
        return h * 60 + mi;
    }

    /* ── Deterministic UID seed ──────────────────────────────────────────────
       A random UID would break determinism AND re-import: the same trip
       exported twice would land in the calendar twice instead of updating.
       FNV-1a over a canonical rendering of the route is stable, collision-safe
       enough for a personal calendar, and changes when the route changes. */
    function fnv1a(s) {
        let h = 0x811c9dc5;
        const v = str(s);
        for (let i = 0; i < v.length; i++) {
            h ^= v.charCodeAt(i);
            h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
        }
        return h >>> 0;
    }

    function planSignature(plan) {
        const parts = [];
        const days = planDays(plan);
        for (let i = 0; i < days.length; i++) {
            const d = days[i] || {};
            const nodes = dayNodes(d);
            const names = [];
            for (let k = 0; k < nodes.length; k++) names.push(placeName(nodes[k]));
            /* Unknown is its own token: collapsing it to 0 would let two
               genuinely different plans share a UID. */
            const k = knownNonNeg(d.km), t = knownNonNeg(d.driveMin);
            parts.push(dayNumber(d, i) + '|' + names.join('>') + '|' +
                (k === null ? '?' : roundKm(k)) + '|' +
                (t === null ? '?' : Math.round(t)));
        }
        parts.push('rt=' + (plan && plan.roundTrip ? 1 : 0));
        return parts.join('||');
    }

    function planUidSeed(plan, startDate) {
        const d = parseDate(startDate);
        const sig = planSignature(plan) + '@@' + (d ? formatIcsDate(d) : '');
        return fnv1a(sig).toString(36);
    }

    /* ── Geometry ────────────────────────────────────────────────────────────
       Optional and never fetched. Accepted shapes, in the order they are
       probed:
         [[[lat,lon],...], ...]        one path per day  (what js/route-map.js
                                       is expected to expose)
         { days: [...] }               the same, wrapped
         [[lat,lon], ...]              one flat path for the whole trip
         { path|points|coordinates }   the same, wrapped
       Anything unrecognised degrades to "no geometry" — never to an exception,
       and never to a network call. */
    function toPoint(p) {
        if (!p) return null;
        let lat, lon;
        if (Array.isArray(p)) {
            if (p.length < 2) return null;
            lat = num(p[0], NaN); lon = num(p[1], NaN);
        } else if (typeof p === 'object') {
            lat = num(p.lat, NaN);
            lon = num(p.lon !== undefined ? p.lon : p.lng, NaN);
        } else return null;
        if (!(isFinite(lat) && isFinite(lon))) return null;
        if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
        return [lat, lon];
    }

    /* A path is accepted WHOLE or not at all. Dropping the unreadable points
       and keeping the rest yields a shorter, entirely plausible track that
       asserts a road between two places the line never joined — a fabricated
       route is worse than no route, and the caller can still see the plan
       through the <rte> elements. */
    function pointsOf(v) {
        if (!Array.isArray(v) || v.length < 2) return null;
        const out = [];
        for (let i = 0; i < v.length; i++) {
            const p = toPoint(v[i]);
            if (!p) return null;
            out.push(p);
        }
        return out;
    }

    /* A wrapped path may arrive under any of several key names, and a sibling
       object can carry more than one of them at once — js/route-map.js exposes
       BOTH `points` (lat/lon, the line to persist) and `path` (viewBox units,
       for the SVG). Picking the wrong key would print screen coordinates into a
       GPX file as if they were degrees, so every candidate is tried and the
       first one that yields real coordinates wins; the range check on every
       point is what makes that safe. */
    const PATH_KEYS = ['points', 'path', 'coordinates', 'latlngs', 'geometry'];

    function toPath(v) {
        if (Array.isArray(v)) return pointsOf(v);
        if (v && typeof v === 'object') {
            for (let i = 0; i < PATH_KEYS.length; i++) {
                const p = pointsOf(v[PATH_KEYS[i]]);
                if (p) return p;
            }
        }
        return null;
    }

    function looksLikePath(v) {
        if (!Array.isArray(v) || v.length === 0) return false;
        for (let i = 0; i < v.length; i++) {
            if (v[i] === null || v[i] === undefined) continue;
            return toPoint(v[i]) !== null;
        }
        return false;
    }

    function normaliseGeometry(geometry) {
        const empty = { days: null, trip: null };
        if (!geometry) return empty;
        let source = geometry;
        if (!Array.isArray(source) && typeof source === 'object') {
            if (Array.isArray(source.days)) {
                return { days: source.days.map(toPath), trip: null };
            }
            const wrapped = toPath(source);
            return wrapped ? { days: null, trip: wrapped } : empty;
        }
        if (!Array.isArray(source)) return empty;
        if (looksLikePath(source)) return { days: null, trip: toPath(source) };
        /* an array of arrays-of-points: one path per day */
        const days = [];
        let any = false;
        for (let i = 0; i < source.length; i++) {
            const p = toPath(source[i]);
            days.push(p);
            if (p) any = true;
        }
        return any ? { days: days, trip: null } : empty;
    }

    /* ════════════════════════════════════════════════════════════════════════
       GPX 1.1
       ════════════════════════════════════════════════════════════════════════
       Element order follows the schema (metadata, wpt*, rte*, trk*), because
       importers that validate reject a file that carries them in any other.

       WAYPOINT / ROUTE / TRACK is a real semantic distinction and this exporter
       respects it:
         <wpt> — the places the traveller stops at;
         <rte> — the PLANNED sequence of via points for a day. A GPS reads it as
                 "go to these, in this order", which is exactly what the engine
                 computed and all it computed;
         <trk> — a PATH that was actually travelled or resolved on the road
                 graph. It is emitted ONLY when real geometry is supplied.
       Drawing straight city-to-city lines into a <trk> would state that the
       road goes that way — across a bay, through a mountain — which is a claim
       the engine never made.

       UNVERIFIED, and recorded as unverified: how each importer treats a file
       with routes and no track has NOT been tested against Garmin, OsmAnd,
       Komoot or anything else. `rte` is part of GPX 1.1 and is the semantically
       correct element, but support for it is known to be uneven and Komoot in
       particular is reported to prefer tracks. The trade is deliberate — an
       importer that ignores an `rte` shows the user nothing, which is
       recoverable, whereas a fabricated `trk` shows them a road that is not
       there, which is not. Supplying `geometry` produces a `trk` and sidesteps
       the question entirely; that is the path the app should take. Do not
       upgrade this note to a compatibility claim without testing it. */
    function gpxWaypoints(plan, L) {
        const roles = [];        /* [{ place, labels: [] }] keyed by identity below */
        const index = {};
        const days = planDays(plan);

        function add(place, label) {
            if (!hasCoords(place)) return;
            const key = placeName(place) + '@' + coord(place.lat) + ',' + coord(place.lon);
            if (index[key] === undefined) {
                index[key] = roles.length;
                roles.push({ place: place, labels: [] });
            }
            const entry = roles[index[key]];
            if (label && entry.labels.indexOf(label) < 0) entry.labels.push(label);
        }

        for (let i = 0; i < days.length; i++) {
            const d = days[i];
            const dayLabel = fill(L.day, { day: dayNumber(d, i) });
            const nodes = dayNodes(d);
            if (isRestDay(d)) {
                add(nodes[0], dayLabel + ': ' + L.restDay);
                continue;
            }
            if (i === 0) add(nodes[0], dayLabel + ': ' + L.start);
            for (let k = 1; k < nodes.length; k++) {
                const last = k === nodes.length - 1;
                const role = last
                    ? (i === days.length - 1 ? L.end : L.overnight)
                    : L.stop;
                add(nodes[k], dayLabel + ': ' + role);
            }
        }
        /* Places the engine ordered but no day reached (0-stop / no-day plans). */
        const order = arr(plan && plan.order);
        for (let i = 0; i < order.length; i++) add(order[i], '');

        let xml = '';
        for (let i = 0; i < roles.length; i++) {
            const p = roles[i].place;
            const desc = roles[i].labels.join('; ');
            xml += '  <wpt lat="' + coord(p.lat) + '" lon="' + coord(p.lon) + '">\n';
            xml += '    <name>' + escapeXml(placeName(p)) + '</name>\n';
            if (desc) xml += '    <desc>' + escapeXml(desc) + '</desc>\n';
            xml += '    <sym>Flag</sym>\n';
            xml += '  </wpt>\n';
        }
        return xml;
    }

    function dayTitle(day, index, L) {
        const d = day || {};
        const label = fill(L.day, { day: dayNumber(d, index) });
        const from = placeName(d.startPlace) || placeName((arr(d.legs)[0] || {}).from);
        const to = placeName(d.endPlace);
        if (isRestDay(d)) return label + ': ' + fill(L.restDayAt, { place: to || from });
        if (from && to) return label + ': ' + from + L.arrow + to;
        return label;
    }

    /* A day's figures WITH the sentence that says what kind of figures they
       are. The qualifier travels with the number, never in a separate place a
       reader can miss. */
    function dayMetrics(day, L, basis) {
        if (basis === 'unusable') return L.unreliable;
        return L.distance + ' ' + kmText(day && day.km, L) + ', ' +
            L.driveTime + ' ' + durationText(day && day.driveMin, L) +
            ' — ' + basisNote(basis, L);
    }

    function gpxRoutes(plan, L, basis, maxDriveMin) {
        const days = planDays(plan);
        let xml = '';
        for (let i = 0; i < days.length; i++) {
            const d = days[i];
            const pts = locatedNodes(d);
            /* One point is not a route. A rest day keeps its waypoint and its
               calendar entry; inventing a zero-length <rte> for it only makes
               importers draw a dot and call it a leg. */
            if (pts.length < 2) continue;
            const parts = [dayMetrics(d, L, basis)];
            const longDay = longDayNote(d, L, maxDriveMin);
            if (longDay) parts.push(longDay);
            parts.push(L.viaPoints);
            xml += '  <rte>\n';
            xml += '    <name>' + escapeXml(dayTitle(d, i, L)) + '</name>\n';
            xml += '    <desc>' + escapeXml(parts.join(' ')) + '</desc>\n';
            xml += '    <number>' + Math.max(1, dayNumber(d, i)) + '</number>\n';
            for (let k = 0; k < pts.length; k++) {
                xml += '    <rtept lat="' + coord(pts[k].lat) + '" lon="' + coord(pts[k].lon) + '">\n';
                xml += '      <name>' + escapeXml(placeName(pts[k])) + '</name>\n';
                xml += '    </rtept>\n';
            }
            xml += '  </rte>\n';
        }
        return xml;
    }

    function gpxTrackFrom(name, desc, path, L) {
        let xml = '  <trk>\n';
        xml += '    <name>' + escapeXml(name) + '</name>\n';
        if (desc) xml += '    <desc>' + escapeXml(desc) + '</desc>\n';
        xml += '    <trkseg>\n';
        for (let i = 0; i < path.length; i++) {
            xml += '      <trkpt lat="' + coord(path[i][0]) + '" lon="' + coord(path[i][1]) + '"/>\n';
        }
        xml += '    </trkseg>\n';
        xml += '  </trk>\n';
        return xml;
    }

    function gpxTracks(plan, geom, name, L, basis) {
        const days = planDays(plan);
        let xml = '';
        if (geom.days) {
            for (let i = 0; i < days.length && i < geom.days.length; i++) {
                const path = geom.days[i];
                if (!path) continue;
                xml += gpxTrackFrom(dayTitle(days[i], i, L),
                    dayMetrics(days[i], L, basis) + ' ' + L.roadTrack, path, L);
            }
            return xml;
        }
        if (geom.trip) xml += gpxTrackFrom(name, L.roadTrack, geom.trip, L);
        return xml;
    }

    function buildGpx(args) {
        const a = args || {};
        const L = labelsOf(a.labels);
        const plan = a.plan || null;
        const basis = distanceBasis(plan, a);
        const geom = normaliseGeometry(a.geometry);
        const name = tripName(plan, a.name, L);

        const notes = [];
        if (str(a.desc).trim()) notes.push(str(a.desc).trim());
        const extra = arr(a.notes);
        for (let i = 0; i < extra.length; i++) {
            const t = str(extra[i]).trim();
            if (t) notes.push(t);
        }
        if (basis === 'unusable') notes.push(L.unreliable);
        else {
            const days = planDays(plan);
            /* A total that skipped a day it could not read is a FLOOR and says
               so; a total with nothing readable in it at all is not a floor of
               zero, it is simply unknown. The two are tracked separately for
               distance and for time, because a day can be missing one and not
               the other. */
            let km = 0, min = 0, kmSeen = 0, minSeen = 0;
            for (let i = 0; i < days.length; i++) {
                const d = days[i] || {};
                const k = knownNonNeg(d.km), t = knownNonNeg(d.driveMin);
                if (k !== null) { km += roundKm(k); kmSeen++; }
                if (t !== null) { min += Math.round(t); minSeen++; }
            }
            if (days.length) {
                notes.push(L.distance + ' ' + totalText(km, kmSeen, days.length, formatKm, L) + ', ' +
                    L.driveTime + ' ' + totalText(min, minSeen, days.length, formatDuration, L) + '.');
                notes.push(basisNote(basis, L));
            }
        }
        const missing = countUnlocated(plan);
        if (missing > 0) notes.push(fill(L.unlocated, { count: missing }));
        /* Every engine warning not already stated above, verbatim. */
        const residual = residualWarnings(plan, a);
        for (let i = 0; i < residual.length; i++) notes.push(residual[i]);

        let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
        xml += '<gpx version="1.1" creator="' + escapeXml(GPX_CREATOR) + '"\n';
        xml += '     xmlns="http://www.topografix.com/GPX/1/1"\n';
        xml += '     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"\n';
        xml += '     xsi:schemaLocation="http://www.topografix.com/GPX/1/1 ' +
            'http://www.topografix.com/GPX/1/1/gpx.xsd">\n';
        xml += '  <metadata>\n';
        xml += '    <name>' + escapeXml(name) + '</name>\n';
        if (notes.length) xml += '    <desc>' + escapeXml(notes.join(' ')) + '</desc>\n';
        xml += '  </metadata>\n';
        xml += gpxWaypoints(plan, L);
        xml += gpxRoutes(plan, L, basis, a.maxDriveMin);
        xml += gpxTracks(plan, geom, name, L, basis);
        xml += '</gpx>\n';
        return xml;
    }

    /* ════════════════════════════════════════════════════════════════════════
       iCalendar (RFC 5545) — one VEVENT per day
       ════════════════════════════════════════════════════════════════════════ */

    /* A day's description. Everything above the "Suggestions" heading is the
       engine's; everything under it is model prose and says so. */
    function icsDescription(day, index, opts) {
        const L = opts.L;
        const lines = [];
        if (opts.basis === 'unusable') {
            lines.push(L.unreliable);
        } else if (!isRestDay(day)) {
            lines.push(L.distance + ': ' + kmText(day.km, L));
            lines.push(L.driveTime + ': ' + durationText(day.driveMin, L));
            /* The qualifier sits directly under the figures it qualifies. A
               calendar entry is read a week later with no app around it. */
            lines.push(basisNote(opts.basis, L));
        }
        const longDay = longDayNote(day, L, opts.maxDriveMin);
        if (longDay) lines.push(longDay);

        const nodes = dayNodes(day);
        const names = [];
        for (let k = 1; k < nodes.length - 1; k++) {
            const n = placeName(nodes[k]);
            if (n) names.push(n);
        }
        if (names.length) lines.push(L.stops + ': ' + names.join(', '));

        /* Cost. An unknown toll must NEVER surface as a zero, and a floor must
           never surface as a total — the day's own `incomplete` flag decides,
           and when the app cannot say what a day costs, the line is omitted
           rather than filled with a number nobody computed. */
        const cost = opts.costs && Array.isArray(opts.costs.days) ? opts.costs.days[index] : null;
        if (cost && opts.basis !== 'unusable') {
            const total = num(cost.total, NaN);
            if (isFinite(total)) {
                lines.push(cost.incomplete
                    ? fill(L.costFloor, { amount: formatMoney(total, L) })
                    : fill(L.cost, { amount: formatMoney(total, L) }));
            }
        }

        const en = opts.enrichment && Array.isArray(opts.enrichment.days)
            ? opts.enrichment.days[index] : null;
        if (en && en.present) {
            const block = [];
            const acts = arr(en.activities);
            for (let k = 0; k < acts.length; k++) {
                const t = str(acts[k]).trim();
                if (t) block.push('- ' + t);
            }
            if (str(en.lodging).trim()) block.push('- ' + L.lodging + ': ' + str(en.lodging).trim());
            if (str(en.tip).trim()) block.push('- ' + L.tip + ': ' + str(en.tip).trim());
            if (block.length) {
                lines.push('');
                lines.push(L.suggestions);
                for (let k = 0; k < block.length; k++) lines.push(block[k]);
            }
        }

        /* Engine warnings nothing else in the file states. They ride on the
           first day because calendar-level DESCRIPTION is invisible in most
           importers, and a warning nobody can see is a warning nobody got. */
        if (index === 0 && opts.notes.length) {
            lines.push('');
            lines.push(L.plannerNotes);
            for (let k = 0; k < opts.notes.length; k++) lines.push('- ' + opts.notes[k]);
        }
        return lines.join('\n');
    }

    function icsEvent(day, index, opts) {
        const L = opts.L;
        const date = addDays(opts.start, index);
        const lines = [];
        lines.push('BEGIN:VEVENT');
        lines.push('UID:travio-' + opts.seed + '-d' + (index + 1) + '@' + UID_DOMAIN);
        lines.push('DTSTAMP:' + opts.dtstamp);

        /* Timed when the engine actually produced a departure clock AND the day
           involves driving; a rest day, or a day the user gave no departure
           time for, is an all-day entry rather than an invented 09:00. */
        const startMin = parseClock(day && day.startTime);
        const known = knownNonNeg(day && day.driveMin);
        const driveMin = known === null ? 0 : Math.round(known);
        const timed = !opts.allDay && startMin !== null && driveMin > 0 &&
            opts.basis !== 'unusable';
        if (timed) {
            const endTotal = startMin + driveMin;
            lines.push('DTSTART:' + formatIcsDateTime(date, startMin));
            lines.push('DTEND:' + formatIcsDateTime(addDays(date, Math.floor(endTotal / 1440)), endTotal));
        } else {
            lines.push('DTSTART;VALUE=DATE:' + formatIcsDate(date));
            lines.push('DTEND;VALUE=DATE:' + formatIcsDate(addDays(date, 1)));
        }

        lines.push('SUMMARY:' + escapeIcs(dayTitle(day, index, L)));
        const desc = icsDescription(day, index, opts);
        if (desc) lines.push('DESCRIPTION:' + escapeIcs(desc));

        const nodes = dayNodes(day);
        const endPlace = (day && day.endPlace) || nodes[nodes.length - 1];
        const loc = placeName(endPlace);
        if (loc) lines.push('LOCATION:' + escapeIcs(loc));
        if (hasCoords(endPlace)) {
            lines.push('GEO:' + coord(endPlace.lat) + ';' + coord(endPlace.lon));
        }
        lines.push('TRANSP:TRANSPARENT');
        lines.push('END:VEVENT');
        return lines;
    }

    /* Returns '' when there is nothing legitimate to emit — no start date, or
       no days. An empty VCALENDAR is not valid (a calendar MUST carry at least
       one component), and inventing today's date to avoid that is exactly the
       impurity this module refuses. '' means "offer no download". */
    function buildIcs(args) {
        const a = args || {};
        const L = labelsOf(a.labels);
        const plan = a.plan || null;
        const days = planDays(plan);
        const start = parseDate(a.startDate);
        if (!start || days.length === 0) return '';
        /* A trip that runs past 9999-12-31 has no representable DTEND: the
           calendar date rolls into year 10000 and the date field grows a ninth
           digit, which no RFC 5545 parser accepts. Emitting nothing beats
           emitting a file that fails to import. */
        const lastDate = addDays(start, days.length);
        if (lastDate.y < 1 || lastDate.y > 9999) return '';

        const basis = distanceBasis(plan, a);
        /* A UID is an opaque identifier, not TEXT, so it has no escape form —
           a raw CRLF in a caller-supplied seed would close the VEVENT and open
           a forged one. Restrict it to characters that cannot mean anything to
           the parser instead of trying to escape them. */
        const seed = safeUidSeed(a.uidSeed) || planUidSeed(plan, start);
        /* DTSTAMP is required and must be a UTC date-time. With the clock off
           limits, the trip's own start midnight is the one date in scope that
           is both deterministic and defensible; callers holding a real save
           timestamp can pass it in. */
        const dtstamp = /^\d{8}T\d{6}Z$/.test(str(a.dtstamp))
            ? str(a.dtstamp) : formatIcsDate(start) + 'T000000Z';

        const opts = {
            L: L, start: start, seed: seed, dtstamp: dtstamp,
            costs: a.costs || null, enrichment: a.enrichment || null,
            allDay: a.allDay === true, basis: basis,
            maxDriveMin: a.maxDriveMin,
            notes: residualWarnings(plan, a)
        };

        const lines = [];
        lines.push('BEGIN:VCALENDAR');
        lines.push('VERSION:2.0');
        lines.push('PRODID:' + (escapeIcs(str(a.prodId).trim()) || ICS_PRODID));
        lines.push('CALSCALE:GREGORIAN');
        lines.push('METHOD:PUBLISH');
        const name = tripName(plan, a.name, L);
        lines.push('X-WR-CALNAME:' + escapeIcs(name));
        lines.push('NAME:' + escapeIcs(name));
        /* Calendar-level provenance. Most importers never show this, which is
           why the per-event copy exists too — but the ones that do should not
           have to dig into a day to find out what kind of numbers these are. */
        const calDesc = [basisNote(basis, L)].concat(opts.notes).join(' ');
        lines.push('DESCRIPTION:' + escapeIcs(calDesc));
        lines.push('X-WR-CALDESC:' + escapeIcs(calDesc));
        for (let i = 0; i < days.length; i++) {
            const ev = icsEvent(days[i], i, opts);
            for (let k = 0; k < ev.length; k++) lines.push(ev[k]);
        }
        lines.push('END:VCALENDAR');

        let out = '';
        for (let i = 0; i < lines.length; i++) out += foldIcsLine(lines[i]) + '\r\n';
        return out;
    }

    /* ════════════════════════════════════════════════════════════════════════
       Printable HTML
       ════════════════════════════════════════════════════════════════════════
       The cheapest artifact and the one a road trip actually uses. It does NOT
       re-render the itinerary: js/itinerary-render.js already produces both an
       escaped HTML view (renderItineraryHtml) and a plain-text mirror
       (buildPlainSummary), and a second renderer here would be a second set of
       numbers to keep in step. This wraps whichever the caller passes in a
       standalone document with a print stylesheet, because the app's CSS lives
       inside index.html and a printed window would otherwise lose it.

       `bodyHtml` is inserted verbatim — it is expected to come from
       renderItineraryHtml, which escapes every value it interpolates. Untrusted
       text belongs in `plainText`, which is escaped here. */
    const PRINT_CSS = [
        ':root{--ink:#1A1A1A;--accent:#10B981;--line:#D8DED9;--muted:#5A6660}',
        '*{box-sizing:border-box}',
        'body{margin:0;padding:24px;font-family:"DM Sans",system-ui,-apple-system,Segoe UI,sans-serif;',
        'color:var(--ink);background:#fff;line-height:1.5}',
        '.mono{font-family:"Space Mono",ui-monospace,SFMono-Regular,Menlo,monospace}',
        '.print-head{border-bottom:2px solid var(--accent);padding-bottom:10px;margin-bottom:18px}',
        '.print-title{font-size:22px;font-weight:700;margin:0}',
        '.print-sub{color:var(--muted);font-size:13px;margin-top:4px}',
        '.print-notes{margin:0 0 16px;padding:0;list-style:none;font-size:12px;color:var(--muted)}',
        '.print-notes li{margin:2px 0}',
        '.print-body pre{white-space:pre-wrap;word-wrap:break-word;font-size:12px}',
        '.summary-card{border:1px solid var(--line);border-radius:8px;padding:12px;margin-bottom:14px}',
        '.summary-grid{display:flex;flex-wrap:wrap;gap:14px;margin:8px 0}',
        '.summary-cell{display:flex;flex-direction:column}',
        '.summary-value{font-weight:700}',
        '.summary-label,.stat-label{font-size:11px;color:var(--muted)}',
        '.day-card{border:1px solid var(--line);border-radius:8px;padding:12px;margin-bottom:12px;',
        'page-break-inside:avoid;break-inside:avoid}',
        '.day-head{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline;font-weight:700}',
        '.day-num{color:var(--accent)}',
        '.day-stats{display:flex;flex-wrap:wrap;gap:14px;margin:8px 0}',
        '.stat{display:flex;flex-direction:column}',
        '.leg-list{margin:6px 0 6px 18px;padding:0}',
        '.leg{margin:2px 0}',
        '.leg-meta{color:var(--muted);font-size:11px;margin-left:6px}',
        '.cost-table{border-collapse:collapse;width:100%;max-width:320px;font-size:12px;margin-top:8px}',
        '.cost-table td{border-top:1px solid var(--line);padding:3px 6px}',
        '.cost-table td:last-child{text-align:right}',
        '.cost-total td{font-weight:700}',
        '.notice{border-left:3px solid var(--line);padding:4px 8px;margin:4px 0;font-size:12px}',
        '.notice-alert{border-left-color:#B91C1C}',
        '.notice-warn{border-left-color:#B45309}',
        '.notice-info{border-left-color:var(--accent)}',
        '.enrich-list{margin:4px 0 4px 18px;padding:0}',
        '.print-foot{margin-top:18px;padding-top:8px;border-top:1px solid var(--line);',
        'font-size:11px;color:var(--muted)}',
        '@media print{@page{margin:14mm}body{padding:0}.no-print{display:none!important}}'
    ].join('');

    function buildPrintHtml(args) {
        const a = args || {};
        const L = labelsOf(a.labels);
        const title = str(a.title).trim() || tripName(a.plan || null, a.name, L);
        const lang = /^[a-zA-Z]{2}(-[a-zA-Z0-9]+)*$/.test(str(a.lang)) ? str(a.lang) : 'en';

        let body = '';
        if (str(a.bodyHtml).trim()) {
            body = str(a.bodyHtml);
        } else if (str(a.plainText).trim()) {
            body = '<pre>' + escapeHtml(a.plainText) + '</pre>';
        }

        const notes = arr(a.notes);
        let notesHtml = '';
        for (let i = 0; i < notes.length; i++) {
            const t = str(notes[i]).trim();
            if (t) notesHtml += '<li>' + escapeHtml(t) + '</li>';
        }

        let html = '<!DOCTYPE html>\n';
        html += '<html lang="' + escapeHtml(lang) + '">\n<head>\n';
        html += '<meta charset="utf-8">\n';
        html += '<meta name="viewport" content="width=device-width, initial-scale=1">\n';
        html += '<title>' + escapeHtml(title) + '</title>\n';
        html += '<style>' + (typeof a.css === 'string' ? safeCss(a.css) : PRINT_CSS) + '</style>\n';
        html += '</head>\n<body>\n';
        html += '<header class="print-head">';
        html += '<h1 class="print-title">' + escapeHtml(title) + '</h1>';
        if (str(a.subtitle).trim()) {
            html += '<div class="print-sub">' + escapeHtml(a.subtitle) + '</div>';
        }
        html += '</header>\n';
        if (notesHtml) html += '<ul class="print-notes">' + notesHtml + '</ul>\n';
        html += '<main class="print-body">' + body + '</main>\n';
        if (str(a.footer).trim()) {
            html += '<footer class="print-foot">' + escapeHtml(a.footer) + '</footer>\n';
        }
        html += '</body>\n</html>\n';
        return html;
    }

    /* Suggested file names. Pure, ASCII-safe, no clock. */
    function safeFileName(base, ext) {
        let s = str(base).trim();
        if (s.normalize) s = s.normalize('NFD').replace(/[̀-ͯ]/g, '');
        s = s.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
        if (s.length > 60) s = s.slice(0, 60).replace(/-+$/, '');
        if (!s) s = 'travio-route';
        return s + '.' + str(ext).replace(/[^a-z]/gi, '').toLowerCase();
    }

    /* ── Exports ── */
    const api = {
        buildGpx: buildGpx,
        buildIcs: buildIcs,
        buildPrintHtml: buildPrintHtml,
        PRINT_CSS: PRINT_CSS,
        DEFAULT_LABELS: DEFAULT_LABELS,
        COVERED_WARNINGS: COVERED_WARNINGS,
        UNRELIABLE_WARNINGS: UNRELIABLE_WARNINGS,
        distanceBasis: distanceBasis,
        residualWarnings: residualWarnings,
        knownNonNeg: knownNonNeg,
        safeUidSeed: safeUidSeed,
        safeCss: safeCss,
        /* helpers, exported because they are separately testable units */
        escapeXml: escapeXml,
        escapeIcs: escapeIcs,
        escapeHtml: escapeHtml,
        foldIcsLine: foldIcsLine,
        unfoldIcs: unfoldIcs,
        utf8Length: utf8Length,
        parseDate: parseDate,
        addDays: addDays,
        formatIcsDate: formatIcsDate,
        planUidSeed: planUidSeed,
        planSignature: planSignature,
        normaliseGeometry: normaliseGeometry,
        numbersUnreliable: numbersUnreliable,
        safeFileName: safeFileName,
        coord: coord,
        FOLD_LIMIT: FOLD_LIMIT
    };

    if (typeof window !== 'undefined') window.TravioExport = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
