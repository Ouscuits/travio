/* ── Travio Itinerary ── costs · model-enrichment parsing · structured rendering ── */
/*
 * Classic script. No ES modules, no bundler, no npm dependency.
 * Works in the browser (attaches to `window`) and in Node for tests
 * (`module.exports`). NOTHING here touches the DOM, the network or Date.now():
 * every function is pure and takes its translations through `ctx.t` / `ctx.tf`,
 * so the same code renders identically in all 5 locales and can be unit-tested.
 *
 * The deterministic plan produced by js/route-engine.js is the SOURCE OF TRUTH.
 * The model can only add prose (activities / meals / lodging / tip) and a toll
 * ESTIMATE. Route, days, distances and times never come from the model.
 */

(function () {
    'use strict';

    /* ── Cost defaults (all overridable from the advanced options panel) ── */
    const ITIN_DEFAULTS = {
        consumption:     7,      // L / 100 km
        fuelPrice:       1.50,   // EUR / L
        lodgingPerNight: 60,     // EUR / night
        mealsPerDay:     35      // EUR / day
    };

    const MAX_ACTIVITIES = 6;
    const MAX_TEXT       = 400;

    /* ── Bounds on the ONE number the model is allowed to contribute ──
       A toll estimate is prose with a euro sign in front of it: unbounded, it can
       double the trip cost and flip the budget verdict on its own.

       European tolls have TWO shapes and the bound has to model both, or it rejects
       true values:
         · per-kilometre networks — the priciest real ones run 0.07-0.12 EUR/km
           (Paris-Lyon 465 km / EUR 40 = 0.086; Madrid-Barcelona 620 km / EUR 45 =
           0.073), so 0.25 EUR/km leaves more than double the headroom;
         · fixed-price crossings — a flat charge that owes nothing to distance:
           Oresund EUR 60.00, Mont Blanc EUR 49.60, Frejus EUR 49.60, Storebaelt
           EUR 33.00, Great St Bernard EUR 30.60. A per-km-only bound caps a 40 km
           Mont Blanc day at pocket change and calls the model a liar for being right.
       The allowance is sized to the priciest realistic PAIR of crossings in one day —
       Storebaelt + Oresund = EUR 93.00 (the Copenhagen-Malmo run), Mont Blanc + Frejus
       = EUR 99.20 — so EUR 100, ADDED to the per-km term rather than maxed against it,
       because a day can legitimately have both. A day with no driving has no tolls.

       Anything above the bound is a typo or a hallucination. It is clamped, the clamp
       is reported, and — because a clamped figure is a reduced one — the day's total
       becomes a floor with its budget verdict withheld, exactly like an unknown. */
    const MAX_TOLL_EUR_PER_KM         = 0.25;
    const FIXED_CROSSING_ALLOWANCE_EUR = 100;
    const MAX_TOLL_EUR_PER_DAY        = 200;

    /* A toll under the bound passes unclamped and lands inside the headline total. When
       it is a large enough slice of that total, the headline is substantially a model
       guess and has to say so — otherwise "Over budget by EUR 198.50" reads as arithmetic
       when EUR 190.00 of it is unverified. A fifth of the total is the line: below that,
       removing the estimate would not change what the figure is telling the user; above
       it, it would. */
    const MATERIAL_ESTIMATE_SHARE = 0.2;

    function tollCapForDay(km) {
        const k = nonNeg(km, 0);
        if (k <= 0) return 0;           // no driving, no tolls
        return Math.min(MAX_TOLL_EUR_PER_DAY,
            round2(FIXED_CROSSING_ALLOWANCE_EUR + k * MAX_TOLL_EUR_PER_KM));
    }

    /* ── Tiny pure helpers ── */
    function num(v, def) {
        if (v === null || v === undefined || v === '') return def;
        const n = Number(v);
        return isFinite(n) ? n : def;
    }
    function pos(v, def) { const n = num(v, NaN); return isFinite(n) && n > 0 ? n : def; }
    function nonNeg(v, def) { const n = num(v, NaN); return isFinite(n) && n >= 0 ? n : def; }
    function round2(n) { return isFinite(n) ? Math.round(n * 100) / 100 : 0; }

    function esc(s) {
        if (s === null || s === undefined) return '';
        return String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function normName(s) {
        if (s === null || s === undefined) return '';
        let v = String(s).toLowerCase().trim();
        if (v.normalize) v = v.normalize('NFD').replace(/[̀-ͯ]/g, '');
        return v.replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
    }

    function clip(s, max) {
        const v = String(s === null || s === undefined ? '' : s).trim();
        const m = max || MAX_TEXT;
        return v.length > m ? v.slice(0, m) + '…' : v;
    }

    /* Template fill: 'Day {day}' + {day:2} -> 'Day 2'. */
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

    /* ── Input parsing ── */
    function parseDestinations(text) {
        if (text === null || text === undefined) return [];
        return String(text)
            .split(/[,\n;]+/)
            .map(function (s) { return s.trim(); })
            .filter(function (s) { return s.length > 0; });
    }

    /* ── Per-day budgets (fixes the dead rfBudgetDay{i} inputs) ── */
    function perDayBudgets(dayCount, dailyBudget, custom) {
        const n = Math.max(0, Math.floor(num(dayCount, 0)));
        const base = nonNeg(dailyBudget, 0);
        const out = [];
        for (let i = 0; i < n; i++) {
            const raw = custom && custom[i] !== undefined && custom[i] !== null ? custom[i] : null;
            const v = raw === null ? NaN : num(raw, NaN);
            out.push(isFinite(v) && v >= 0 ? v : base);
        }
        return out;
    }

    /* ── Costs — computed here, NEVER read from the model (tolls excepted, flagged) ── */
    function computeCosts(plan, opts) {
        const o = opts || {};
        const consumption = pos(o.consumption, ITIN_DEFAULTS.consumption);
        const fuelPrice   = pos(o.fuelPrice, ITIN_DEFAULTS.fuelPrice);
        const lodgingRate = nonNeg(o.lodgingPerNight, ITIN_DEFAULTS.lodgingPerNight);
        const mealsRate   = nonNeg(o.mealsPerDay, ITIN_DEFAULTS.mealsPerDay);
        const tollsEnabled = o.tollsEnabled !== false;
        const tollsIn = Array.isArray(o.tolls) ? o.tolls : [];

        const planDays = plan && Array.isArray(plan.days) ? plan.days : [];
        const budgets = perDayBudgets(planDays.length, o.dailyBudget, o.budgets);

        const days = [];
        let totalFuel = 0, totalTolls = 0, totalLodging = 0, totalMeals = 0;
        let totalCost = 0, totalBudget = 0;
        let tollsEstimated = false;
        const unknownTollDays = [];
        const notAvoidedTollDays = [];
        const incompleteDays = [];
        const clampedTolls = [];

        for (let i = 0; i < planDays.length; i++) {
            const d = planDays[i] || {};
            const km = nonNeg(d.km, 0);
            const fuel = round2((km / 100) * consumption * fuelPrice);

            /* Four genuinely different toll states, and the UI must be able to tell
               them apart. None of them is a computed zero, because nothing in this
               app computes tolls:
                 'estimated'   — the model supplied a plausible number (flagged);
                 'clamped'     — the model's number was outside the plausible bound, so
                                 what is shown is a REDUCED figure: a floor, not a total;
                 'unknown'     — nobody supplied anything. A 0 here silently drops a
                                 whole cost component and then lets a "within budget"
                                 verdict rest on the gap;
                 'not-avoided' — the traveller asked to avoid tolls, but NOTHING in the
                                 pipeline re-plans the route to do it (no exclude=toll on
                                 the road-graph calls). So either the distances shown are
                                 for a route that uses toll roads, or they are not the
                                 route the traveller will drive. Printing EUR 0.00 here
                                 would be inventing the one fact the app never
                                 established. It is not applicable, not zero. */
            let tolls = 0, tollsKnown = true, fromModel = false, clamped = null;
            let basis = 'estimated';
            if (km <= 0) {
                /* A day with no driving is the ONE case where a zero really is computed:
                   no road travelled, no toll incurred, whatever the model claims. */
                basis = 'none';
            } else if (!tollsEnabled) {
                basis = 'not-avoided';
                tollsKnown = false;
            } else {
                const rawIn = tollsIn[i];
                const raw = (rawIn === null || rawIn === undefined || rawIn === '')
                    ? NaN : num(rawIn, NaN);
                if (isFinite(raw) && raw >= 0) {
                    const cap = tollCapForDay(km);
                    fromModel = true;
                    if (raw > cap) {
                        clamped = { requested: round2(raw), capped: cap, km: round2(km) };
                        tolls = cap;
                        basis = 'clamped';
                    } else {
                        tolls = round2(raw);
                        basis = 'estimated';
                    }
                } else {
                    basis = 'unknown';
                    tollsKnown = false;
                }
            }
            if (fromModel) tollsEstimated = true;
            /* A settled figure is a plausible model estimate, or a no-driving day. A
               clamped one has been cut down, an unknown was never given, and a "without
               tolls" route was never actually re-planned — all three make the day total
               a FLOOR, so they all get the floor treatment the unknown branch already had. */
            const incomplete = !(basis === 'estimated' || basis === 'none');

            /* Lodging pays for the NIGHTS of the trip: no hotel after the final day. */
            const lodging = (i < planDays.length - 1) ? round2(lodgingRate) : 0;
            const meals = round2(mealsRate);

            const total = round2(fuel + tolls + lodging + meals);
            const budget = nonNeg(budgets[i], 0);
            const over = total > budget + 0.005;
            /* An over-budget verdict that only exists because of the model's number is
               a verdict the model made up; it has to say so out loud. */
            const overFromEstimate = over && fromModel && tolls > 0 &&
                round2(total - tolls) <= budget + 0.005;
            /* Over budget for other reasons too, but with enough model money inside the
               figure that the figure is not really arithmetic. */
            const overWithEstimate = over && fromModel && tolls > 0 && !overFromEstimate &&
                total > 0 && tolls >= MATERIAL_ESTIMATE_SHARE * total;

            const dayNo = num(d.day, i + 1);
            days.push({
                day: dayNo,
                km: round2(km),
                fuel: fuel,
                tolls: tolls,
                tollsKnown: tollsKnown,
                tollsBasis: basis,
                tollsEstimated: fromModel,
                tollsClamped: clamped,
                lodging: lodging,
                meals: meals,
                total: total,
                /* `total` counts only what is settled: anything else makes it a FLOOR. */
                incomplete: incomplete,
                budget: round2(budget),
                over: over,
                overBy: over ? round2(total - budget) : 0,
                overDependsOnEstimate: overFromEstimate,
                overIncludesEstimate: overWithEstimate
            });
            if (basis === 'unknown') unknownTollDays.push(dayNo);
            if (basis === 'not-avoided') notAvoidedTollDays.push(dayNo);
            if (incomplete) incompleteDays.push(dayNo);
            if (clamped) clampedTolls.push({ day: dayNo, requested: clamped.requested, capped: clamped.capped, km: clamped.km });

            totalFuel += fuel; totalTolls += tolls; totalLodging += lodging;
            totalMeals += meals; totalCost += total; totalBudget += budget;
        }

        const overDays = [];
        for (let i = 0; i < days.length; i++) if (days[i].over) overDays.push(days[i].day);

        const cost = round2(totalCost), budgetTotal = round2(totalBudget);
        const tollsTotal = round2(totalTolls);
        const over = cost > budgetTotal + 0.005;

        /* "Over budget ONLY because of the estimate" is a claim about the whole trip, and
           it is false the moment any single day is over budget on its computed costs
           alone — a reader scanning the summary and then a day card would otherwise see
           "only because of the AI-estimated toll" sitting above a day that is over by
           EUR 8.69 with no toll at all. Both were arithmetically true at their own
           aggregate, which is exactly what makes the pair misleading. When a day owns its
           overrun, the trip falls back to the weaker, still-true "includes X of
           AI-estimated tolls". */
        let dayOverWithoutEstimate = false;
        for (let i = 0; i < days.length; i++) {
            if (days[i].over && !days[i].overDependsOnEstimate) { dayOverWithoutEstimate = true; break; }
        }
        const tripOverFromEstimate = over && tollsEstimated && tollsTotal > 0 &&
            round2(cost - tollsTotal) <= budgetTotal + 0.005 && !dayOverWithoutEstimate;

        return {
            days: days,
            totalFuel: round2(totalFuel),
            totalTolls: tollsTotal,
            totalLodging: round2(totalLodging),
            totalMeals: round2(totalMeals),
            totalCost: cost,
            totalBudget: budgetTotal,
            overBudgetDays: overDays,
            over: over,
            overBy: over ? round2(cost - budgetTotal) : 0,
            tollsEstimated: tollsEstimated,
            tollsUnknown: unknownTollDays.length > 0,
            unknownTollDays: unknownTollDays,
            tollsNotAvoided: notAvoidedTollDays.length > 0,
            notAvoidedTollDays: notAvoidedTollDays,
            clampedTolls: clampedTolls,
            /* The trip total is a floor whenever any day's is. */
            incomplete: incompleteDays.length > 0,
            incompleteDays: incompleteDays,
            overDependsOnEstimate: tripOverFromEstimate,
            overIncludesEstimate: over && tollsEstimated && tollsTotal > 0 &&
                !tripOverFromEstimate &&
                cost > 0 && tollsTotal >= MATERIAL_ESTIMATE_SHARE * cost,
            rates: {
                consumption: consumption, fuelPrice: fuelPrice,
                lodgingPerNight: lodgingRate, mealsPerDay: mealsRate
            }
        };
    }

    /* ── Defensive parsing of the model's JSON enrichment ──
       Never throws. A malformed / partial answer degrades to "no enrichment"
       for the days it could not deliver; the computed itinerary is unaffected. */
    function extractJsonText(raw) {
        let s = String(raw === null || raw === undefined ? '' : raw).trim();
        /* strip ``` / ```json fences wherever they appear */
        s = s.replace(/^\s*```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();
        if (s.charAt(0) === '{' || s.charAt(0) === '[') return s;
        const a = s.indexOf('{');
        const b = s.lastIndexOf('}');
        if (a >= 0 && b > a) return s.slice(a, b + 1);
        return s;
    }

    function cleanStringList(v) {
        let list = [];
        if (Array.isArray(v)) list = v;
        else if (typeof v === 'string') list = v.split(/\r?\n|;/);
        else if (v && typeof v === 'object') {
            for (const k in v) if (Object.prototype.hasOwnProperty.call(v, k)) list.push(v[k]);
        }
        const out = [];
        for (let i = 0; i < list.length && out.length < MAX_ACTIVITIES; i++) {
            const item = list[i];
            let s = '';
            if (typeof item === 'string' || typeof item === 'number') s = String(item);
            else if (item && typeof item === 'object') {
                s = String(item.name || item.title || item.text || item.activity || '');
            }
            s = clip(s, MAX_TEXT);
            if (s) out.push(s);
        }
        return out;
    }

    function cleanMeals(v) {
        const out = [];
        const push = function (labelKey, text) {
            const s = clip(text, MAX_TEXT);
            if (s) out.push({ key: labelKey, text: s });
        };
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            push('breakfast', v.breakfast);
            push('lunch', v.lunch);
            push('dinner', v.dinner);
            if (out.length === 0) {
                for (const k in v) {
                    if (Object.prototype.hasOwnProperty.call(v, k) && typeof v[k] === 'string') {
                        push('other', v[k]);
                    }
                }
            }
        } else if (Array.isArray(v) || typeof v === 'string') {
            const list = cleanStringList(v);
            for (let i = 0; i < list.length; i++) push('other', list[i]);
        }
        return out;
    }

    function emptyEnrichmentDay(day) {
        return { day: day, activities: [], meals: [], lodging: '', tip: '', tolls: null, present: false };
    }

    function parseEnrichment(raw, dayCount) {
        const n = Math.max(0, Math.floor(num(dayCount, 0)));
        const days = [];
        for (let i = 0; i < n; i++) days.push(emptyEnrichmentDay(i + 1));

        const result = {
            available: false, error: null, missingDays: [],
            days: days, filledDays: 0, droppedEntries: 0
        };

        if (raw === null || raw === undefined || raw === '') {
            result.error = 'empty';
            for (let i = 0; i < n; i++) result.missingDays.push(i + 1);
            return result;
        }

        let data = null;
        if (typeof raw === 'object') {
            data = raw;
        } else {
            try {
                data = JSON.parse(extractJsonText(raw));
            } catch (e) {
                data = null;
            }
        }

        if (!data || typeof data !== 'object') {
            result.error = 'malformed';
            for (let i = 0; i < n; i++) result.missingDays.push(i + 1);
            return result;
        }

        let list = null;
        if (Array.isArray(data)) list = data;
        else if (Array.isArray(data.days)) list = data.days;
        else if (Array.isArray(data.itinerary)) list = data.itinerary;

        if (!list) {
            result.error = 'no-days';
            for (let i = 0; i < n; i++) result.missingDays.push(i + 1);
            return result;
        }

        for (let i = 0; i < list.length; i++) {
            const entry = list[i];
            if (!entry || typeof entry !== 'object') continue;
            /* A `day` the model actually stated is a claim about WHICH day the prose
               belongs to. When it points outside the trip the claim is unusable — and
               re-homing it onto the positional index attaches "visit the cathedral in
               Burgos" to a day spent in Valencia. Drop it instead; only an ABSENT or
               unparseable day falls back to the position in the array. */
            const stated = num(entry.day, NaN);
            let idx;
            if (isFinite(stated)) {
                idx = Math.floor(stated);
                if (idx < 1 || idx > n) { result.droppedEntries++; continue; }
            } else {
                idx = i + 1;
                if (idx < 1 || idx > n) { result.droppedEntries++; continue; }
            }

            const target = days[idx - 1];
            const activities = cleanStringList(entry.activities !== undefined ? entry.activities : entry.activity);
            const meals = cleanMeals(entry.meals);
            const lodging = clip(typeof entry.lodging === 'object' && entry.lodging
                ? (entry.lodging.name || entry.lodging.text || '')
                : entry.lodging, MAX_TEXT);
            const tip = clip(entry.tip !== undefined ? entry.tip : entry.localTip, MAX_TEXT);
            const tollsRaw = num(entry.tollsEur !== undefined ? entry.tollsEur : entry.tolls, NaN);

            target.activities = activities;
            target.meals = meals;
            target.lodging = lodging;
            target.tip = tip;
            target.tolls = isFinite(tollsRaw) && tollsRaw >= 0 ? round2(tollsRaw) : null;
            target.present = !!(activities.length || meals.length || lodging || tip);
        }

        for (let i = 0; i < n; i++) {
            if (days[i].present) result.filledDays++;
            else result.missingDays.push(i + 1);
        }
        result.available = result.filledDays > 0;
        if (!result.available) result.error = result.error || 'no-content';
        else if (result.missingDays.length) result.error = 'partial';
        return result;
    }

    function tollsFromEnrichment(enrichment) {
        const out = [];
        if (!enrichment || !Array.isArray(enrichment.days)) return out;
        for (let i = 0; i < enrichment.days.length; i++) {
            const t = enrichment.days[i] ? enrichment.days[i].tolls : null;
            out.push(t === null || t === undefined ? 0 : t);
        }
        return out;
    }

    /* Same list, but "the model said nothing" stays `null` instead of collapsing into
       a euro-zero. computeCosts needs that distinction to report an honest UNKNOWN. */
    function tollEstimates(enrichment) {
        const out = [];
        if (!enrichment || !Array.isArray(enrichment.days)) return out;
        for (let i = 0; i < enrichment.days.length; i++) {
            const t = enrichment.days[i] ? enrichment.days[i].tolls : null;
            out.push(t === null || t === undefined ? null : t);
        }
        return out;
    }

    /* ── Notices — derived from the PLAN, not from English warning strings, so
       every one of them is translatable. Engine warnings whose code is not
       covered here are still surfaced verbatim (code 'other'): never swallowed. */
    const COVERED_WARNINGS = {
        'rest-day': 1, 'over-drive-cap': 1, 'duplicate-stop-removed': 1,
        'unresolved-place': 1, 'distance-fallback': 1, 'distance-source': 1,
        'missing-matrix': 1, 'round-trip': 1, 'unknown-distance': 1, 'stop-ignored': 1,
        'zero-distance': 1
    };

    /* Engine warnings that mean "the numbers below are not real". These are not
       colour-coded trivia: they invalidate every distance, time and cost on the page,
       so they get the top severity, a translated string in all five locales, and they
       suppress any reassuring budget verdict downstream. */
    const UNRELIABLE_WARNINGS = {
        'zero-distance': 'zeroDistance',
        'unknown-distance': 'unknownDistance'
    };
    const UNRELIABLE_NOTICES = { zeroDistance: 1, unknownDistance: 1 };

    /* info < warn < alert. Rendered top-down so the loudest is never buried. */
    const LEVEL_RANK = { alert: 0, warn: 1, info: 2 };

    /* Stable sort by severity: the loudest notice must never be printed under a list of
       blue trivia. */
    function sortNoticesBySeverity(list) {
        if (!Array.isArray(list)) return [];
        return list.map(function (n, i) { return { n: n, i: i }; })
            .sort(function (a, b) {
                const ra = LEVEL_RANK[a.n && a.n.level] === undefined ? 2 : LEVEL_RANK[a.n.level];
                const rb = LEVEL_RANK[b.n && b.n.level] === undefined ? 2 : LEVEL_RANK[b.n.level];
                return ra === rb ? a.i - b.i : ra - rb;
            })
            .map(function (x) { return x.n; });
    }

    function hasUnreliableNumbers(notices) {
        if (!Array.isArray(notices)) return false;
        for (let i = 0; i < notices.length; i++) {
            if (notices[i] && UNRELIABLE_NOTICES[notices[i].code]) return true;
        }
        return false;
    }

    function buildNotices(plan, ctx) {
        const out = [];
        if (!plan || !Array.isArray(plan.days)) return out;
        const c = ctx || {};
        const days = plan.days;
        const order = Array.isArray(plan.order) ? plan.order : [];

        /* Decided up front, because it gates what may be asserted below: once the
           distances are declared unusable, every judgement computed FROM them —
           including the over-budget one — is unusable too. */
        const planWarnings = Array.isArray(plan.warnings) ? plan.warnings : [];
        let unusableNumbers = false;
        for (let i = 0; i < planWarnings.length; i++) {
            const w = String(planWarnings[i] || '');
            const code = w.indexOf(':') > 0 ? w.slice(0, w.indexOf(':')) : w;
            if (UNRELIABLE_WARNINGS[code]) { unusableNumbers = true; break; }
        }

        /* Dropped destinations (duplicates / same as start or end). */
        const requested = Array.isArray(c.requestedStops) ? c.requestedStops : [];
        const inOrder = {};
        for (let i = 0; i < order.length; i++) {
            const k = normName(order[i] && order[i].name);
            if (k) inOrder[k] = true;
        }
        const startKey = normName(c.startName);
        const endKey = normName(c.endName);
        const seen = {};
        for (let i = 0; i < requested.length; i++) {
            const name = requested[i];
            const k = normName(name);
            if (!k) continue;
            /* Start/end matches are checked first: those places DO appear in the
               order (as the origin or the destination), but not as this stop. */
            if (k === startKey) out.push({ code: 'sameAsStart', level: 'info', params: { name: name } });
            else if (k === endKey) out.push({ code: 'sameAsEnd', level: 'info', params: { name: name } });
            else if (inOrder[k] && !seen[k]) { seen[k] = true; continue; }
            else out.push({ code: 'duplicate', level: 'info', params: { name: name } });
            seen[k] = true;
        }

        /* Rest days and over-cap days. */
        for (let i = 0; i < days.length; i++) {
            const d = days[i] || {};
            const legs = Array.isArray(d.legs) ? d.legs : [];
            if (legs.length === 0) {
                out.push({
                    code: 'restDay', level: 'info',
                    params: { day: num(d.day, i + 1), place: (d.endPlace && d.endPlace.name) || '' }
                });
            }
            if (d.overDriveCap) {
                /* Raw minutes, NOT a formatted string: the units belong to the locale
                   the notice is READ in, not the one it was built in. */
                out.push({
                    code: 'overCap', level: 'warn',
                    params: {
                        day: num(d.day, i + 1),
                        drive: num(d.driveMin, 0),
                        cap: num(c.maxDriveMin, 360)
                    }
                });
            }
        }

        /* Places that could not be geocoded. */
        const places = Array.isArray(c.places) ? c.places : [];
        for (let i = 0; i < places.length; i++) {
            if (places[i] && places[i].resolved === false) {
                out.push({ code: 'unresolved', level: 'warn', params: { name: places[i].name || '' } });
            }
        }

        /* Distance source. 'mixed' is NOT 'haversine': a matrix that is 70% real road
           data must not tell the user there is no road data at all. The engine already
           counts the straight-line fills — carry the counts through instead of
           throwing them away. */
        if (c.matrixSource && c.matrixSource !== 'osrm') {
            if (c.matrixSource === 'mixed') {
                const filled = num(c.matrixFilledCells, NaN);
                const osrm = num(c.matrixOsrmCells, NaN);
                const total = (isFinite(filled) && isFinite(osrm)) ? filled + osrm : NaN;
                if (isFinite(filled) && filled >= 0 && isFinite(total) && total > 0) {
                    out.push({
                        code: 'mixed', level: 'warn',
                        params: { filled: Math.round(filled), total: Math.round(total) }
                    });
                } else {
                    out.push({ code: 'mixedUnknownCount', level: 'warn', params: {} });
                }
            } else {
                out.push({ code: 'haversine', level: 'alert', params: {} });
            }
        }

        /* Tolls. Nothing in this app computes them, so every branch that is not a
           plausible model estimate has to say what it actually is. */
        if (c.costs && c.costs.tollsUnknown) {
            out.push({
                code: 'tollsUnknown', level: 'warn',
                params: { days: (c.costs.unknownTollDays || []).join(', ') }
            });
        }
        /* "Without tolls" is a preference the pipeline never acts on: the road-graph
           calls carry no exclude=toll, so the route below is the same route. */
        if (c.costs && c.costs.tollsNotAvoided) {
            out.push({ code: 'tollsNotAvoided', level: 'warn', params: {} });
        }
        const clamped = (c.costs && Array.isArray(c.costs.clampedTolls)) ? c.costs.clampedTolls : [];
        for (let i = 0; i < clamped.length; i++) {
            out.push({
                code: 'tollsClamped', level: 'warn',
                params: {
                    day: clamped[i].day,
                    value: clamped[i].requested,
                    capped: clamped[i].capped,
                    km: clamped[i].km
                }
            });
        }

        if (plan.roundTrip) {
            out.push({
                code: 'roundTrip', level: 'info',
                params: { place: (order[0] && order[0].name) || c.startName || '' }
            });
        }

        /* Over-budget days — but not when the distances they were computed from have
           already been declared unusable. Withholding the verdict in the summary while
           still asserting it in a notice is the same lie in a smaller font. */
        if (!unusableNumbers && c.costs && Array.isArray(c.costs.overBudgetDays) && c.costs.overBudgetDays.length) {
            out.push({
                code: 'overBudget', level: 'warn',
                params: { days: c.costs.overBudgetDays.join(', '), count: c.costs.overBudgetDays.length }
            });
        }

        /* Engine warnings. The "numbers are not real" class gets a translated string
           and the top severity; anything else not represented above is still surfaced
           verbatim (code 'other') so nothing is ever swallowed. */
        const warnings = planWarnings;
        const seenUnreliable = {};
        for (let i = 0; i < warnings.length; i++) {
            const w = String(warnings[i] || '');
            const code = w.indexOf(':') > 0 ? w.slice(0, w.indexOf(':')) : w;
            const unreliable = UNRELIABLE_WARNINGS[code];
            if (unreliable) {
                if (seenUnreliable[unreliable]) continue;
                seenUnreliable[unreliable] = true;
                out.push({ code: unreliable, level: 'alert', params: {} });
                continue;
            }
            if (COVERED_WARNINGS[code]) continue;
            out.push({ code: 'other', level: 'info', params: { text: w } });
        }

        return sortNoticesBySeverity(out);
    }

    /* Which notice params are NUMBERS carrying a unit, and which unit. Notices store
       the raw value; the unit is attached here, at read time, so a notice built in one
       language and re-rendered in another does not keep the old locale's units baked
       into the sentence ("7 h 21 min" surviving inside a Chinese string). */
    const NOTICE_NUMERIC_PARAMS = {
        overCap:      { drive: 'duration', cap: 'duration' },
        tollsClamped: { km: 'km', value: 'amount', capped: 'amount' }
    };

    function noticeFillParams(notice, ctx) {
        const raw = (notice && notice.params) || {};
        const spec = NOTICE_NUMERIC_PARAMS[notice && notice.code];
        if (!spec) return raw;
        const out = {};
        for (const k in raw) if (Object.prototype.hasOwnProperty.call(raw, k)) out[k] = raw[k];
        for (const k in spec) {
            if (!Object.prototype.hasOwnProperty.call(spec, k)) continue;
            const v = num(raw[k], NaN);
            /* A value already formatted by an older saved route is left as it is. */
            if (!isFinite(v)) continue;
            out[k] = spec[k] === 'duration' ? formatDuration(v, ctx)
                : (spec[k] === 'km' ? formatKm(v, ctx) : formatAmount(v));
        }
        return out;
    }

    function noticeText(notice, ctx) {
        if (!notice) return '';
        if (notice.code === 'other') return String(notice.params && notice.params.text || '');
        return trf(ctx, 'notice.' + notice.code, noticeFillParams(notice, ctx));
    }

    /* ── Formatting ── */
    function formatDuration(minutes, ctx) {
        const m = Math.max(0, Math.round(num(minutes, 0)));
        const h = Math.floor(m / 60);
        const r = m % 60;
        const hLabel = tr(ctx, 'unit.hour');
        const mLabel = tr(ctx, 'unit.minute');
        if (h === 0) return r + ' ' + mLabel;
        if (r === 0) return h + ' ' + hLabel;
        return h + ' ' + hLabel + ' ' + r + ' ' + mLabel;
    }

    function roundKmForDisplay(km) {
        const v = num(km, 0);
        return v >= 10 ? Math.round(v) : Math.round(v * 10) / 10;
    }

    function formatKm(km, ctx) {
        return roundKmForDisplay(km) + ' ' + tr(ctx, 'unit.km');
    }

    /* Trip totals are the sum of the values the user can SEE, printed without a second
       rounding pass. Rounding the raw total independently of the per-day values makes
       them disagree by a kilometre or a minute (1682 vs 1681 was the worst observed) —
       quality bar B9 says the displayed numbers must add up, so round once. */
    function displayTotals(plan) {
        const days = (plan && Array.isArray(plan.days)) ? plan.days : [];
        let km = 0, min = 0;
        for (let i = 0; i < days.length; i++) {
            km += roundKmForDisplay(days[i] && days[i].km);
            min += Math.max(0, Math.round(num(days[i] && days[i].driveMin, 0)));
        }
        return { km: round2(km), min: min };
    }

    function formatKmTotal(km, ctx) {
        const n = round2(num(km, 0));
        const s = Math.abs(n - Math.round(n)) < 0.005 ? String(Math.round(n)) : String(Math.round(n * 10) / 10);
        return s + ' ' + tr(ctx, 'unit.km');
    }

    function formatMoney(v) {
        const n = num(v, 0);
        return 'EUR ' + n.toFixed(2);
    }

    /* Bare amount, for strings that already carry their own currency word. */
    function formatAmount(v) { return num(v, 0).toFixed(2); }

    function parseClock(value) {
        if (typeof value !== 'string') return null;
        const m = /^\s*(\d{1,2})\s*:\s*(\d{2})\s*$/.exec(value);
        if (!m) return null;
        const h = parseInt(m[1], 10), mi = parseInt(m[2], 10);
        if (!(h >= 0 && h <= 23 && mi >= 0 && mi <= 59)) return null;
        return h * 60 + mi;
    }

    function formatClock(totalMin) {
        const m = ((Math.round(totalMin) % 1440) + 1440) % 1440;
        const h = Math.floor(m / 60), r = m % 60;
        return (h < 10 ? '0' : '') + h + ':' + (r < 10 ? '0' : '') + r;
    }

    /* Arrival clock per leg, from the day's departure time. Pure. */
    function legTimes(day, departureTime) {
        const legs = day && Array.isArray(day.legs) ? day.legs : [];
        const start = parseClock(departureTime !== undefined && departureTime !== null
            ? departureTime : (day && day.startTime));
        const out = [];
        let acc = 0;
        for (let i = 0; i < legs.length; i++) {
            acc += num(legs[i].min, 0);
            out.push(start === null ? null : formatClock(start + acc));
        }
        return out;
    }

    /* ── Consistency check (quality bar B9) ── */
    function totalsConsistent(plan, costs) {
        if (!plan || !Array.isArray(plan.days)) return false;
        let km = 0, min = 0;
        for (let i = 0; i < plan.days.length; i++) {
            km += num(plan.days[i].km, 0);
            min += num(plan.days[i].driveMin, 0);
        }
        if (Math.abs(round2(km) - num(plan.totalKm, 0)) > 0.02) return false;
        if (Math.abs(round2(min) - num(plan.totalMin, 0)) > 0.02) return false;
        if (costs && Array.isArray(costs.days)) {
            let c = 0;
            for (let i = 0; i < costs.days.length; i++) c += num(costs.days[i].total, 0);
            if (Math.abs(round2(c) - num(costs.totalCost, 0)) > 0.02) return false;
        }
        return true;
    }

    /* ── The full view model: everything the renderer and the saved document need.
       `enrichment` is optional — the itinerary is identical without it. ── */
    function buildItineraryView(args) {
        const a = args || {};
        const plan = a.plan;
        const enrichment = a.enrichment || null;
        const costs = computeCosts(plan, {
            consumption: a.consumption,
            fuelPrice: a.fuelPrice,
            lodgingPerNight: a.lodgingPerNight,
            mealsPerDay: a.mealsPerDay,
            dailyBudget: a.dailyBudget,
            budgets: a.budgets,
            tollsEnabled: a.tollsEnabled,
            tolls: enrichment ? tollEstimates(enrichment) : []
        });
        const notices = buildNotices(plan, {
            requestedStops: a.requestedStops,
            startName: a.startName,
            endName: a.endName,
            places: a.places,
            matrixSource: a.matrixSource,
            matrixFilledCells: a.matrixFilledCells,
            matrixOsrmCells: a.matrixOsrmCells,
            maxDriveMin: a.maxDriveMin,
            costs: costs,
            t: a.t, tf: a.tf
        });
        return {
            plan: plan,
            costs: costs,
            enrichment: enrichment,
            notices: notices,
            meta: {
                startName: a.startName || '',
                endName: a.endName || '',
                tripType: a.tripType || '',
                duration: plan && Array.isArray(plan.days) ? plan.days.length : 0,
                dailyBudget: nonNeg(a.dailyBudget, 0),
                departureTime: a.departureTime || '',
                matrixSource: a.matrixSource || '',
                matrixFilledCells: isFinite(num(a.matrixFilledCells, NaN)) ? num(a.matrixFilledCells, 0) : null,
                matrixOsrmCells: isFinite(num(a.matrixOsrmCells, NaN)) ? num(a.matrixOsrmCells, 0) : null,
                tollPreference: a.tollPreference || '',
                consistent: totalsConsistent(plan, costs),
                numbersUnreliable: hasUnreliableNumbers(notices)
            }
        };
    }

    /* ── Rendering (pure HTML strings — the DOM write happens in route-form.js) ── */
    const NOTICE_STYLE = {
        alert: { cls: 'notice notice-alert', icon: '&#9940;' },
        warn:  { cls: 'notice notice-warn',  icon: '&#9888;&#65039;' },
        info:  { cls: 'notice notice-info',  icon: '&#8505;&#65039;' }
    };

    function renderNotices(notices, ctx) {
        if (!Array.isArray(notices) || notices.length === 0) return '';
        let html = '<div class="notice-list">';
        for (let i = 0; i < notices.length; i++) {
            const n = notices[i];
            const style = NOTICE_STYLE[n.level] || NOTICE_STYLE.info;
            html += '<div class="' + style.cls + '"><span class="notice-icon">' + style.icon + '</span>' +
                '<span class="notice-text">' + esc(noticeText(n, ctx)) + '</span></div>';
        }
        return html + '</div>';
    }

    /* ── The budget verdict, and the one rule that governs it ──
       A FLOOR is always safe to assert: if the known costs already exceed the budget,
       the trip is over budget whatever the unknowns turn out to be. A CEILING is not:
       "within budget" is a promise about money nobody has counted. So an over-budget
       verdict survives missing or unreliable data, and a reassuring one does not. */
    function budgetVerdict(entry, flags, ctx) {
        const over = !!(entry && entry.over);
        if (flags.unreliable) {
            return { cls: 'flag-unknown', text: tr(ctx, 'itin.budgetNotAssessable') };
        }
        if (over) {
            const amount = formatMoney(entry.overBy);
            const tolls = formatMoney(entry.tolls !== undefined ? entry.tolls : entry.totalTolls);
            if (entry.overDependsOnEstimate) {
                return {
                    cls: 'flag-over',
                    text: trf(ctx, 'itin.overBudgetByEstimated', { amount: amount, tolls: tolls })
                };
            }
            /* Over budget on its own merits, but the figure is substantially model money. */
            if (entry.overIncludesEstimate) {
                return {
                    cls: 'flag-over',
                    text: trf(ctx, 'itin.overBudgetByWithEstimate', { amount: amount, tolls: tolls })
                };
            }
            return { cls: 'flag-over', text: trf(ctx, 'itin.overBudgetBy', { amount: amount }) };
        }
        if (entry && entry.incomplete) {
            return { cls: 'flag-unknown', text: tr(ctx, 'itin.withinBudgetIncomplete') };
        }
        return null;   /* caller supplies the reassuring wording it wants */
    }

    /* ── Toll provenance for a day that may predate the basis field ──
       The FIRST rule is not about provenance at all, it is about arithmetic: a day that
       carries money in `tolls` has that money inside its `total`, so it must render as
       money. Round-1 saved documents (the first structured save) stored only the amount,
       and reading them as "not estimated / —" left a cost table whose rows did not sum
       to their own stated total — the app declaring it had never estimated a toll it was
       at that moment charging the user for. Quality bar B9 is not negotiable on a load
       path, so a positive toll wins over every other signal. */
    function tollBasisOf(dayCost) {
        const d = dayCost || {};
        if (d.tollsBasis) return d.tollsBasis;
        if (num(d.tolls, 0) > 0) return 'estimated';
        if (d.tollsKnown === false) return 'unknown';
        if (num(d.km, 0) <= 0) return 'none';
        return d.tollsEstimated ? 'estimated' : 'unknown';
    }

    /* An amount that only counts what is known is a minimum, and is labelled as one. */
    function amountText(value, incomplete, ctx) {
        const money = formatMoney(value);
        return incomplete ? trf(ctx, 'itin.atLeast', { amount: money }) : money;
    }

    function viewFlags(view) {
        const costs = (view && view.costs) || {};
        const meta = (view && view.meta) || {};
        return {
            unreliable: meta.numbersUnreliable === true ||
                hasUnreliableNumbers(view && view.notices),
            incomplete: costs.incomplete === true || costs.tollsUnknown === true
        };
    }

    function renderSummary(view, ctx) {
        const plan = view.plan || {};
        const costs = view.costs || {};
        const flags = viewFlags(view);
        const totals = displayTotals(plan);

        let cardCls = '';
        if (flags.unreliable) cardCls = ' summary-unreliable';
        else if (costs.over) cardCls = ' summary-over';
        else if (flags.incomplete) cardCls = ' summary-unknown';

        let html = '<div class="summary-card' + cardCls + '">';
        html += '<div class="summary-title">' + esc(tr(ctx, 'itin.summary')) + '</div>';
        html += '<div class="summary-grid">';
        html += '<div class="summary-cell"><span class="summary-value mono">' +
            esc(formatKmTotal(totals.km, ctx)) + '</span><span class="summary-label">' +
            esc(tr(ctx, 'itin.totalKm')) + '</span></div>';
        html += '<div class="summary-cell"><span class="summary-value mono">' +
            esc(formatDuration(totals.min, ctx)) + '</span><span class="summary-label">' +
            esc(tr(ctx, 'itin.totalTime')) + '</span></div>';
        html += '<div class="summary-cell"><span class="summary-value mono">' +
            esc(amountText(costs.totalCost, flags.incomplete, ctx)) + '</span><span class="summary-label">' +
            esc(tr(ctx, 'itin.totalCost')) + '</span></div>';
        html += '<div class="summary-cell"><span class="summary-value mono">' +
            esc(formatMoney(costs.totalBudget)) + '</span><span class="summary-label">' +
            esc(tr(ctx, 'itin.totalBudget')) + '</span></div>';
        html += '</div>';

        const verdict = budgetVerdict({
            over: costs.over, overBy: costs.overBy, totalTolls: costs.totalTolls,
            overDependsOnEstimate: costs.overDependsOnEstimate,
            overIncludesEstimate: costs.overIncludesEstimate, incomplete: flags.incomplete
        }, flags, ctx) || {
            cls: 'flag-ok',
            text: trf(ctx, 'itin.underBudgetBy', {
                amount: formatMoney(round2(num(costs.totalBudget, 0) - num(costs.totalCost, 0)))
            })
        };
        html += '<div class="summary-flag ' + verdict.cls + '">' + esc(verdict.text) + '</div>';

        const src = view.meta && view.meta.matrixSource;
        const srcKey = src === 'osrm' ? 'itin.sourceRoad'
            : (src === 'mixed' ? 'itin.sourcePartial' : 'itin.sourceEstimated');
        html += '<div class="summary-source mono">' + esc(trf(ctx, srcKey, {})) + '</div>';
        return html + '</div>';
    }

    function renderCostTable(dayCost, ctx, flags) {
        const f = flags || { unreliable: false };
        let html = '<table class="cost-table"><tbody>';
        const row = function (labelKey, valueText, extra, rowCls) {
            html += '<tr' + (rowCls ? ' class="' + rowCls + '"' : '') + '><td>' +
                esc(tr(ctx, labelKey)) + (extra ? ' <span class="est-flag">' + esc(extra) + '</span>' : '') +
                '</td><td class="mono">' + esc(valueText) + '</td></tr>';
        };
        row('itin.fuel', formatMoney(dayCost.fuel));
        /* Nothing computes tolls, so every state prints the marker that says exactly
           what its number is: an estimate, a capped estimate, a certainty because there
           was no driving, or one of the two different non-answers. Five states, five
           markers — none of them distinguished by colour alone. */
        const basis = tollBasisOf(dayCost);
        if (basis === 'not-avoided') {
            row('itin.tolls', tr(ctx, 'itin.unknownValue'), tr(ctx, 'itin.tollsNotApplicable'), 'cost-unknown');
        } else if (basis === 'unknown') {
            row('itin.tolls', tr(ctx, 'itin.unknownValue'), tr(ctx, 'itin.tollsNotEstimated'), 'cost-unknown');
        } else if (basis === 'clamped') {
            row('itin.tolls', formatMoney(dayCost.tolls), tr(ctx, 'itin.tollsCapped'), 'cost-unknown');
        } else if (basis === 'none') {
            row('itin.tolls', formatMoney(dayCost.tolls), tr(ctx, 'itin.tollsNoDriving'), '');
        } else {
            row('itin.tolls', formatMoney(dayCost.tolls), tr(ctx, 'itin.estimate'), '');
        }
        row('itin.lodging', formatMoney(dayCost.lodging));
        row('itin.meals', formatMoney(dayCost.meals));
        html += '<tr class="cost-total"><td>' + esc(tr(ctx, 'itin.total')) +
            '</td><td class="mono">' + esc(amountText(dayCost.total, dayCost.incomplete, ctx)) + '</td></tr>';
        html += '<tr class="cost-budget"><td>' + esc(tr(ctx, 'itin.budget')) +
            '</td><td class="mono">' + esc(formatMoney(dayCost.budget)) + '</td></tr>';
        html += '</tbody></table>';

        const verdict = budgetVerdict(dayCost, f, ctx) ||
            { cls: 'flag-ok', text: tr(ctx, 'itin.withinBudget') };
        html += '<div class="cost-flag ' + verdict.cls + '">' + esc(verdict.text) + '</div>';
        return html;
    }

    function renderEnrichmentBlock(day, ctx) {
        if (!day || !day.present) return '';
        let html = '<div class="day-enrich">';
        if (day.activities.length) {
            html += '<div class="enrich-group"><div class="enrich-title">' +
                esc(tr(ctx, 'itin.activities')) + '</div><ul class="enrich-list">';
            for (let i = 0; i < day.activities.length; i++) {
                html += '<li>' + esc(day.activities[i]) + '</li>';
            }
            html += '</ul></div>';
        }
        if (day.meals.length) {
            html += '<div class="enrich-group"><div class="enrich-title">' +
                esc(tr(ctx, 'itin.mealsIdeas')) + '</div><ul class="enrich-list">';
            for (let i = 0; i < day.meals.length; i++) {
                const m = day.meals[i];
                const label = m.key === 'other' ? '' :
                    '<b>' + esc(tr(ctx, 'itin.meal_' + m.key)) + ':</b> ';
                html += '<li>' + label + esc(m.text) + '</li>';
            }
            html += '</ul></div>';
        }
        if (day.lodging) {
            html += '<div class="enrich-group"><div class="enrich-title">' +
                esc(tr(ctx, 'itin.lodgingIdea')) + '</div><p class="enrich-text">' +
                esc(day.lodging) + '</p></div>';
        }
        if (day.tip) {
            html += '<div class="enrich-tip"><span class="tip-icon">&#128161;</span><span>' +
                '<b>' + esc(tr(ctx, 'itin.tip')) + ':</b> ' + esc(day.tip) + '</span></div>';
        }
        return html + '</div>';
    }

    function renderDayCard(index, view, ctx) {
        const plan = view.plan || {};
        const d = (plan.days || [])[index] || {};
        const cost = (view.costs && view.costs.days || [])[index] || {};
        const enrichDay = view.enrichment && Array.isArray(view.enrichment.days)
            ? view.enrichment.days[index] : null;
        const legs = Array.isArray(d.legs) ? d.legs : [];
        const times = legTimes(d, view.meta && view.meta.departureTime);
        const fromName = (d.startPlace && d.startPlace.name) || '';
        const toName = (d.endPlace && d.endPlace.name) || '';
        const rest = legs.length === 0;

        let html = '<div class="day-card' + (cost.over ? ' day-over' : '') + '">';
        html += '<div class="day-head">';
        html += '<span class="day-num mono">' + esc(trf(ctx, 'itin.dayN', { day: num(d.day, index + 1) })) + '</span>';
        html += '<span class="day-route">' + esc(fromName) +
            (rest ? '' : ' &rarr; ' + esc(toName)) + '</span>';
        if (d.overDriveCap) {
            html += '<span class="day-badge badge-warn">' + esc(tr(ctx, 'itin.longDay')) + '</span>';
        }
        if (rest) {
            html += '<span class="day-badge badge-rest">' + esc(tr(ctx, 'itin.restDay')) + '</span>';
        }
        html += '</div>';

        html += '<div class="day-stats">';
        html += '<div class="stat"><span class="stat-value mono">' + esc(formatKm(d.km, ctx)) +
            '</span><span class="stat-label">' + esc(tr(ctx, 'itin.distance')) + '</span></div>';
        html += '<div class="stat"><span class="stat-value mono">' + esc(formatDuration(d.driveMin, ctx)) +
            '</span><span class="stat-label">' + esc(tr(ctx, 'itin.driveTime')) + '</span></div>';
        if (!rest && d.startTime) {
            html += '<div class="stat"><span class="stat-value mono">' + esc(d.startTime) + ' &rarr; ' +
                esc(d.endTime || '') + '</span><span class="stat-label">' +
                esc(tr(ctx, 'itin.departureArrival')) + '</span></div>';
        }
        html += '</div>';

        if (rest) {
            html += '<p class="day-rest-text">' +
                esc(trf(ctx, 'itin.restDayAt', { place: toName })) + '</p>';
        } else {
            /* A single leg is already fully described by the day header and the
               stats row — only list legs when the day has more than one hop. */
            if (legs.length > 1) html += '<ol class="leg-list">';
            for (let i = 0; legs.length > 1 && i < legs.length; i++) {
                const leg = legs[i];
                html += '<li class="leg"><span class="leg-name">' +
                    esc((leg.to && leg.to.name) || '') + '</span>' +
                    '<span class="leg-meta mono">' + esc(formatKm(leg.km, ctx)) + ' &middot; ' +
                    esc(formatDuration(leg.min, ctx)) +
                    (times[i] ? ' &middot; ' + esc(trf(ctx, 'itin.arriveAt', { time: times[i] })) : '') +
                    '</span></li>';
            }
            if (legs.length > 1) html += '</ol>';
            html += '<div class="day-overnight mono">' +
                esc(trf(ctx, 'itin.overnight', { place: toName })) + '</div>';
        }

        html += renderEnrichmentBlock(enrichDay, ctx);
        html += '<div class="day-cost">' + renderCostTable(cost, ctx, viewFlags(view)) + '</div>';
        return html + '</div>';
    }

    function renderItineraryHtml(view, ctx) {
        if (!view || !view.plan) return '';
        let html = '';
        html += renderNotices(view.notices, ctx);
        if (view.enrichment && view.enrichment.error && view.enrichment.error !== 'partial') {
            html += '<div class="notice notice-info"><span class="notice-icon">&#8505;&#65039;</span>' +
                '<span class="notice-text">' + esc(tr(ctx, 'itin.enrichUnavailable')) + '</span></div>';
        } else if (view.enrichment && view.enrichment.error === 'partial') {
            html += '<div class="notice notice-info"><span class="notice-icon">&#8505;&#65039;</span>' +
                '<span class="notice-text">' + esc(trf(ctx, 'itin.enrichPartial',
                    { days: view.enrichment.missingDays.join(', ') })) + '</span></div>';
        }
        html += renderSummary(view, ctx);
        html += '<div class="day-list">';
        const days = view.plan.days || [];
        for (let i = 0; i < days.length; i++) html += renderDayCard(i, view, ctx);
        html += '</div>';
        html += '<div class="rates-note mono">' + esc(trf(ctx, 'itin.ratesNote', {
            consumption: view.costs.rates.consumption,
            price: view.costs.rates.fuelPrice.toFixed(2),
            lodging: view.costs.rates.lodgingPerNight,
            meals: view.costs.rates.mealsPerDay
        })) + '</div>';
        return html;
    }

    /* ── Plain-text mirror, stored in the legacy `result` field so old readers,
       exports and copy/paste keep working. ── */
    function buildPlainSummary(view, ctx) {
        if (!view || !view.plan) return '';
        const lines = [];
        const plan = view.plan, costs = view.costs;
        const flags = viewFlags(view);
        const totals = displayTotals(plan);
        lines.push(tr(ctx, 'itin.summary').toUpperCase());
        lines.push(view.meta.startName + ' -> ' + view.meta.endName);
        lines.push(tr(ctx, 'itin.totalKm') + ': ' + formatKmTotal(totals.km, ctx));
        lines.push(tr(ctx, 'itin.totalTime') + ': ' + formatDuration(totals.min, ctx));
        lines.push(tr(ctx, 'itin.totalCost') + ': ' + amountText(costs.totalCost, flags.incomplete, ctx) +
            ' / ' + tr(ctx, 'itin.totalBudget') + ': ' + formatMoney(costs.totalBudget));
        lines.push('');
        for (let i = 0; i < plan.days.length; i++) {
            const d = plan.days[i];
            const c = costs.days[i] || {};
            lines.push(trf(ctx, 'itin.dayN', { day: d.day }) + ': ' +
                ((d.startPlace && d.startPlace.name) || '') + ' -> ' +
                ((d.endPlace && d.endPlace.name) || '') +
                '  [' + formatKm(d.km, ctx) + ' / ' + formatDuration(d.driveMin, ctx) + ']');
            const stops = (d.stops || []).map(function (s) { return s && s.name; }).filter(Boolean);
            if (stops.length) lines.push('  ' + tr(ctx, 'itin.stops') + ': ' + stops.join(', '));
            const dayVerdict = budgetVerdict(c, flags, ctx);
            lines.push('  ' + tr(ctx, 'itin.total') + ': ' + amountText(c.total, c.incomplete, ctx) +
                ' / ' + tr(ctx, 'itin.budget') + ': ' + formatMoney(c.budget) +
                (dayVerdict ? '  ** ' + dayVerdict.text + ' **' : ''));
            const en = view.enrichment && view.enrichment.days ? view.enrichment.days[i] : null;
            if (en && en.present) {
                if (en.activities.length) lines.push('  ' + tr(ctx, 'itin.activities') + ': ' + en.activities.join('; '));
                if (en.lodging) lines.push('  ' + tr(ctx, 'itin.lodgingIdea') + ': ' + en.lodging);
                if (en.tip) lines.push('  ' + tr(ctx, 'itin.tip') + ': ' + en.tip);
            }
            lines.push('');
        }
        for (let i = 0; i < view.notices.length; i++) {
            lines.push('! ' + noticeText(view.notices[i], ctx));
        }
        return lines.join('\n');
    }

    /* ── Serialisable plan for Firestore (no matrices, no nested arrays) ── */
    function serialisePlace(p) {
        if (!p) return null;
        return {
            name: p.name || '',
            lat: typeof p.lat === 'number' ? p.lat : null,
            lon: typeof p.lon === 'number' ? p.lon : null,
            resolved: p.resolved === true,
            source: p.source || ''
        };
    }

    function serialiseView(view) {
        if (!view || !view.plan) return null;
        const plan = view.plan;
        const days = [];
        for (let i = 0; i < plan.days.length; i++) {
            const d = plan.days[i];
            const legs = [];
            for (let k = 0; k < (d.legs || []).length; k++) {
                legs.push({
                    from: serialisePlace(d.legs[k].from),
                    to: serialisePlace(d.legs[k].to),
                    km: d.legs[k].km, min: d.legs[k].min
                });
            }
            days.push({
                day: d.day, km: d.km, driveMin: d.driveMin,
                startPlace: serialisePlace(d.startPlace),
                endPlace: serialisePlace(d.endPlace),
                startTime: d.startTime || null, endTime: d.endTime || null,
                overDriveCap: !!d.overDriveCap,
                stops: (d.stops || []).map(serialisePlace),
                legs: legs
            });
        }
        return {
            version: 2,
            plan: {
                days: days,
                order: (plan.order || []).map(serialisePlace),
                totalKm: plan.totalKm, totalMin: plan.totalMin,
                roundTrip: !!plan.roundTrip,
                warnings: (plan.warnings || []).slice()
            },
            costs: view.costs,
            enrichment: view.enrichment ? {
                available: view.enrichment.available,
                error: view.enrichment.error,
                missingDays: view.enrichment.missingDays,
                days: view.enrichment.days
            } : null,
            notices: view.notices,
            meta: view.meta
        };
    }

    /* A saved document written by this version carries `structured.version === 2`.
       Anything else is a legacy plain-text route and must fall back to the old view. */
    function isStructuredRoute(saved) {
        return !!(saved && saved.structured && saved.structured.version === 2 &&
            saved.structured.plan && Array.isArray(saved.structured.plan.days) &&
            saved.structured.plan.days.length > 0);
    }

    /* ── Loading a document written before the toll states existed ──
       Round-1 v2 documents carry `tolls` and nothing else about it. Deriving the basis
       here rather than in the renderer keeps one source of truth, and lets the trip-level
       flags agree with the per-day ones — otherwise the rows floor their totals while the
       summary keeps asserting a complete one. Documents that already carry `tollsBasis`
       (round 2 onwards) are returned untouched. */
    function migrateSavedCosts(costs) {
        if (!costs || !Array.isArray(costs.days) || costs.days.length === 0) return costs;
        let legacy = false;
        for (let i = 0; i < costs.days.length; i++) {
            if (costs.days[i] && costs.days[i].tollsBasis === undefined) { legacy = true; break; }
        }
        if (!legacy) return costs;

        const out = {};
        for (const k in costs) if (Object.prototype.hasOwnProperty.call(costs, k)) out[k] = costs[k];

        const days = [], unknownDays = [], incompleteDays = [];
        for (let i = 0; i < costs.days.length; i++) {
            const src = costs.days[i] || {};
            const d = {};
            for (const k in src) if (Object.prototype.hasOwnProperty.call(src, k)) d[k] = src[k];
            const basis = tollBasisOf(d);
            d.tollsBasis = basis;
            d.tollsKnown = (basis === 'estimated' || basis === 'clamped' || basis === 'none');
            d.tollsEstimated = (basis === 'estimated' || basis === 'clamped');
            d.tollsClamped = d.tollsClamped || null;
            d.incomplete = !(basis === 'estimated' || basis === 'none');
            const tolls = num(d.tolls, 0), total = num(d.total, 0), budget = num(d.budget, 0);
            d.overDependsOnEstimate = !!d.over && d.tollsEstimated && tolls > 0 &&
                round2(total - tolls) <= budget + 0.005;
            d.overIncludesEstimate = !!d.over && d.tollsEstimated && tolls > 0 &&
                !d.overDependsOnEstimate && total > 0 && tolls >= MATERIAL_ESTIMATE_SHARE * total;
            if (basis === 'unknown') unknownDays.push(num(d.day, i + 1));
            if (d.incomplete) incompleteDays.push(num(d.day, i + 1));
            days.push(d);
        }
        out.days = days;
        out.unknownTollDays = unknownDays;
        out.tollsUnknown = unknownDays.length > 0;
        /* A round-1 document cannot say whether "without tolls" was chosen — it stored
           the same zero either way — so this stays false rather than being guessed. */
        out.tollsNotAvoided = false;
        out.notAvoidedTollDays = [];
        out.clampedTolls = Array.isArray(costs.clampedTolls) ? costs.clampedTolls : [];
        out.incompleteDays = incompleteDays;
        out.incomplete = incompleteDays.length > 0;

        const totalTolls = num(out.totalTolls, 0), totalCost = num(out.totalCost, 0),
            totalBudget = num(out.totalBudget, 0);
        out.tollsEstimated = totalTolls > 0 || costs.tollsEstimated === true;
        let dayOverWithoutEstimate = false;
        for (let i = 0; i < days.length; i++) {
            if (days[i].over && !days[i].overDependsOnEstimate) { dayOverWithoutEstimate = true; break; }
        }
        out.overDependsOnEstimate = !!out.over && out.tollsEstimated && totalTolls > 0 &&
            round2(totalCost - totalTolls) <= totalBudget + 0.005 && !dayOverWithoutEstimate;
        out.overIncludesEstimate = !!out.over && out.tollsEstimated && totalTolls > 0 &&
            !out.overDependsOnEstimate && totalCost > 0 &&
            totalTolls >= MATERIAL_ESTIMATE_SHARE * totalCost;
        return out;
    }

    /* ── The other trip-level input to viewFlags: the notice list ──
       Migrating `costs` alone is not enough. Whether the budget verdict may be given at
       all is decided by the notices, and a document written by an older build recorded
       the "numbers are not real" class the way that build understood it: round 1 had no
       `zeroDistance` code, so it stored the engine's English sentence as an untranslated
       {code:'other', level:'info'}, and it had `unknown-distance` in COVERED_WARNINGS
       with nothing rendering it, so it stored nothing at all. Trusting that array
       reproduces the exact screen this whole piece was opened to eliminate — reached by
       loading a saved route instead of generating one.

       The evidence is in the document: plan.warnings holds both strings verbatim. Derive
       the class from there, drop the stale untranslated duplicate, and let the normal
       machinery translate, rank and sort it. */
    function reconcileSavedNotices(plan, stored) {
        const warnings = (plan && Array.isArray(plan.warnings)) ? plan.warnings : [];
        const list = Array.isArray(stored) ? stored : [];

        /* What the plan itself reports. Derived first, so a stale untranslated duplicate
           is only dropped when there is a real alert to replace it — a document with the
           prose but no warnings keeps the prose rather than losing the information. */
        const derived = {};
        for (let i = 0; i < warnings.length; i++) {
            const w = String(warnings[i] || '');
            const code = w.indexOf(':') > 0 ? w.slice(0, w.indexOf(':')) : w;
            const mapped = UNRELIABLE_WARNINGS[code];
            if (mapped) derived[mapped] = true;
        }

        const present = {};
        const out = [];
        for (let i = 0; i < list.length; i++) {
            const n = list[i];
            if (!n || !n.code) continue;
            if (UNRELIABLE_NOTICES[n.code]) { present[n.code] = true; out.push(n); continue; }
            if (n.code === 'other') {
                const text = String((n.params && n.params.text) || '');
                const code = text.indexOf(':') > 0 ? text.slice(0, text.indexOf(':')) : text;
                const mapped = UNRELIABLE_WARNINGS[code];
                if (mapped && derived[mapped]) continue;   // replaced by the derived alert
            }
            out.push(n);
        }
        for (const code in derived) {
            if (!Object.prototype.hasOwnProperty.call(derived, code) || present[code]) continue;
            out.push({ code: code, level: 'alert', params: {} });
        }
        return out;
    }

    function viewFromSaved(saved) {
        if (!isStructuredRoute(saved)) return null;
        const s = saved.structured;
        const costs = migrateSavedCosts(s.costs || computeCosts(s.plan, {}));
        const notices = reconcileSavedNotices(s.plan, s.notices);
        /* If the migration discovered a gap the document never recorded, say so — the
           day rows now withhold their verdicts and the reader is owed the reason. */
        if (costs && costs.tollsUnknown) {
            let stated = false;
            for (let i = 0; i < notices.length; i++) {
                if (notices[i] && notices[i].code === 'tollsUnknown') { stated = true; break; }
            }
            if (!stated) {
                notices.push({
                    code: 'tollsUnknown', level: 'warn',
                    params: { days: (costs.unknownTollDays || []).join(', ') }
                });
            }
        }
        const sorted = sortNoticesBySeverity(notices);
        /* Copy, never mutate: the caller still holds the stored document and a re-save
           must not write our derivations back over it. */
        const meta = {};
        const savedMeta = s.meta || {};
        for (const k in savedMeta) if (Object.prototype.hasOwnProperty.call(savedMeta, k)) meta[k] = savedMeta[k];
        meta.numbersUnreliable = hasUnreliableNumbers(sorted);
        return {
            plan: s.plan,
            costs: costs,
            enrichment: s.enrichment || null,
            notices: sorted,
            meta: meta
        };
    }

    /* ── Exports ── */
    const api = {
        ITIN_DEFAULTS: ITIN_DEFAULTS,
        parseDestinations: parseDestinations,
        perDayBudgets: perDayBudgets,
        computeCosts: computeCosts,
        parseEnrichment: parseEnrichment,
        tollsFromEnrichment: tollsFromEnrichment,
        tollEstimates: tollEstimates,
        tollCapForDay: tollCapForDay,
        hasUnreliableNumbers: hasUnreliableNumbers,
        displayTotals: displayTotals,
        buildNotices: buildNotices,
        noticeText: noticeText,
        buildItineraryView: buildItineraryView,
        renderItineraryHtml: renderItineraryHtml,
        buildPlainSummary: buildPlainSummary,
        serialiseView: serialiseView,
        viewFromSaved: viewFromSaved,
        isStructuredRoute: isStructuredRoute,
        totalsConsistent: totalsConsistent,
        legTimes: legTimes,
        formatDuration: formatDuration,
        formatKm: formatKm,
        formatKmTotal: formatKmTotal,
        formatMoney: formatMoney,
        formatClock: formatClock,
        fill: fill,
        escapeText: esc
    };

    if (typeof window !== 'undefined') window.TravioItinerary = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
