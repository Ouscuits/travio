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

        for (let i = 0; i < planDays.length; i++) {
            const d = planDays[i] || {};
            const km = nonNeg(d.km, 0);
            const fuel = round2((km / 100) * consumption * fuelPrice);

            let tolls = 0;
            if (tollsEnabled) {
                const raw = num(tollsIn[i], NaN);
                if (isFinite(raw) && raw > 0) { tolls = round2(raw); tollsEstimated = true; }
            }
            /* Lodging pays for the NIGHTS of the trip: no hotel after the final day. */
            const lodging = (i < planDays.length - 1) ? round2(lodgingRate) : 0;
            const meals = round2(mealsRate);

            const total = round2(fuel + tolls + lodging + meals);
            const budget = nonNeg(budgets[i], 0);
            const over = total > budget + 0.005;

            days.push({
                day: num(d.day, i + 1),
                km: round2(km),
                fuel: fuel,
                tolls: tolls,
                lodging: lodging,
                meals: meals,
                total: total,
                budget: round2(budget),
                over: over,
                overBy: over ? round2(total - budget) : 0
            });

            totalFuel += fuel; totalTolls += tolls; totalLodging += lodging;
            totalMeals += meals; totalCost += total; totalBudget += budget;
        }

        const overDays = [];
        for (let i = 0; i < days.length; i++) if (days[i].over) overDays.push(days[i].day);

        return {
            days: days,
            totalFuel: round2(totalFuel),
            totalTolls: round2(totalTolls),
            totalLodging: round2(totalLodging),
            totalMeals: round2(totalMeals),
            totalCost: round2(totalCost),
            totalBudget: round2(totalBudget),
            overBudgetDays: overDays,
            over: round2(totalCost) > round2(totalBudget) + 0.005,
            overBy: round2(totalCost) > round2(totalBudget) + 0.005 ? round2(totalCost - totalBudget) : 0,
            tollsEstimated: tollsEstimated,
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
            days: days, filledDays: 0
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
            let idx = Math.floor(num(entry.day, NaN));
            if (!isFinite(idx) || idx < 1 || idx > n) idx = i + 1;
            if (idx < 1 || idx > n) continue;

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

    /* ── Notices — derived from the PLAN, not from English warning strings, so
       every one of them is translatable. Engine warnings whose code is not
       covered here are still surfaced verbatim (code 'other'): never swallowed. */
    const COVERED_WARNINGS = {
        'rest-day': 1, 'over-drive-cap': 1, 'duplicate-stop-removed': 1,
        'unresolved-place': 1, 'distance-fallback': 1, 'distance-source': 1,
        'missing-matrix': 1, 'round-trip': 1, 'unknown-distance': 1, 'stop-ignored': 1
    };

    function buildNotices(plan, ctx) {
        const out = [];
        if (!plan || !Array.isArray(plan.days)) return out;
        const c = ctx || {};
        const days = plan.days;
        const order = Array.isArray(plan.order) ? plan.order : [];

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
                out.push({
                    code: 'overCap', level: 'warn',
                    params: {
                        day: num(d.day, i + 1),
                        drive: formatDuration(num(d.driveMin, 0), ctx),
                        cap: formatDuration(num(c.maxDriveMin, 360), ctx)
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

        /* Distance source. */
        if (c.matrixSource && c.matrixSource !== 'osrm') {
            out.push({ code: 'haversine', level: 'warn', params: {} });
        }

        if (plan.roundTrip) {
            out.push({
                code: 'roundTrip', level: 'info',
                params: { place: (order[0] && order[0].name) || c.startName || '' }
            });
        }

        /* Over-budget days. */
        if (c.costs && Array.isArray(c.costs.overBudgetDays) && c.costs.overBudgetDays.length) {
            out.push({
                code: 'overBudget', level: 'warn',
                params: { days: c.costs.overBudgetDays.join(', '), count: c.costs.overBudgetDays.length }
            });
        }

        /* Anything the engine reported that is not represented above. */
        const warnings = Array.isArray(plan.warnings) ? plan.warnings : [];
        for (let i = 0; i < warnings.length; i++) {
            const w = String(warnings[i] || '');
            const code = w.indexOf(':') > 0 ? w.slice(0, w.indexOf(':')) : w;
            if (COVERED_WARNINGS[code]) continue;
            out.push({ code: 'other', level: 'info', params: { text: w } });
        }
        return out;
    }

    function noticeText(notice, ctx) {
        if (!notice) return '';
        if (notice.code === 'other') return String(notice.params && notice.params.text || '');
        return trf(ctx, 'notice.' + notice.code, notice.params || {});
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

    function formatKm(km, ctx) {
        const v = num(km, 0);
        const label = tr(ctx, 'unit.km');
        return (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10) + ' ' + label;
    }

    function formatMoney(v) {
        const n = num(v, 0);
        return 'EUR ' + n.toFixed(2);
    }

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
            tolls: enrichment ? tollsFromEnrichment(enrichment) : []
        });
        const notices = buildNotices(plan, {
            requestedStops: a.requestedStops,
            startName: a.startName,
            endName: a.endName,
            places: a.places,
            matrixSource: a.matrixSource,
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
                tollPreference: a.tollPreference || '',
                consistent: totalsConsistent(plan, costs)
            }
        };
    }

    /* ── Rendering (pure HTML strings — the DOM write happens in route-form.js) ── */
    function renderNotices(notices, ctx) {
        if (!Array.isArray(notices) || notices.length === 0) return '';
        let html = '<div class="notice-list">';
        for (let i = 0; i < notices.length; i++) {
            const n = notices[i];
            const cls = n.level === 'warn' ? 'notice notice-warn' : 'notice notice-info';
            const icon = n.level === 'warn' ? '&#9888;&#65039;' : '&#8505;&#65039;';
            html += '<div class="' + cls + '"><span class="notice-icon">' + icon + '</span>' +
                '<span class="notice-text">' + esc(noticeText(n, ctx)) + '</span></div>';
        }
        return html + '</div>';
    }

    function renderSummary(view, ctx) {
        const plan = view.plan || {};
        const costs = view.costs || {};
        const overCls = costs.over ? ' summary-over' : '';
        let html = '<div class="summary-card' + overCls + '">';
        html += '<div class="summary-title">' + esc(tr(ctx, 'itin.summary')) + '</div>';
        html += '<div class="summary-grid">';
        html += '<div class="summary-cell"><span class="summary-value mono">' +
            esc(formatKm(plan.totalKm, ctx)) + '</span><span class="summary-label">' +
            esc(tr(ctx, 'itin.totalKm')) + '</span></div>';
        html += '<div class="summary-cell"><span class="summary-value mono">' +
            esc(formatDuration(plan.totalMin, ctx)) + '</span><span class="summary-label">' +
            esc(tr(ctx, 'itin.totalTime')) + '</span></div>';
        html += '<div class="summary-cell"><span class="summary-value mono">' +
            esc(formatMoney(costs.totalCost)) + '</span><span class="summary-label">' +
            esc(tr(ctx, 'itin.totalCost')) + '</span></div>';
        html += '<div class="summary-cell"><span class="summary-value mono">' +
            esc(formatMoney(costs.totalBudget)) + '</span><span class="summary-label">' +
            esc(tr(ctx, 'itin.totalBudget')) + '</span></div>';
        html += '</div>';
        html += '<div class="summary-flag ' + (costs.over ? 'flag-over' : 'flag-ok') + '">' +
            esc(costs.over
                ? trf(ctx, 'itin.overBudgetBy', { amount: formatMoney(costs.overBy) })
                : trf(ctx, 'itin.underBudgetBy', { amount: formatMoney(round2(num(costs.totalBudget, 0) - num(costs.totalCost, 0))) })) +
            '</div>';
        html += '<div class="summary-source mono">' +
            esc(trf(ctx, view.meta && view.meta.matrixSource === 'osrm'
                ? 'itin.sourceRoad' : 'itin.sourceEstimated', {})) + '</div>';
        return html + '</div>';
    }

    function renderCostTable(dayCost, ctx, tollsEstimated) {
        let html = '<table class="cost-table"><tbody>';
        const row = function (labelKey, value, extra) {
            html += '<tr><td>' + esc(tr(ctx, labelKey)) + (extra ? ' <span class="est-flag">' +
                esc(extra) + '</span>' : '') + '</td><td class="mono">' + esc(formatMoney(value)) + '</td></tr>';
        };
        row('itin.fuel', dayCost.fuel);
        row('itin.tolls', dayCost.tolls, tollsEstimated ? tr(ctx, 'itin.estimate') : '');
        row('itin.lodging', dayCost.lodging);
        row('itin.meals', dayCost.meals);
        html += '<tr class="cost-total"><td>' + esc(tr(ctx, 'itin.total')) +
            '</td><td class="mono">' + esc(formatMoney(dayCost.total)) + '</td></tr>';
        html += '<tr class="cost-budget"><td>' + esc(tr(ctx, 'itin.budget')) +
            '</td><td class="mono">' + esc(formatMoney(dayCost.budget)) + '</td></tr>';
        html += '</tbody></table>';
        html += '<div class="cost-flag ' + (dayCost.over ? 'flag-over' : 'flag-ok') + '">' +
            esc(dayCost.over
                ? trf(ctx, 'itin.overBudgetBy', { amount: formatMoney(dayCost.overBy) })
                : tr(ctx, 'itin.withinBudget')) + '</div>';
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
        html += '<div class="day-cost">' +
            renderCostTable(cost, ctx, view.costs && view.costs.tollsEstimated) + '</div>';
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
        lines.push(tr(ctx, 'itin.summary').toUpperCase());
        lines.push(view.meta.startName + ' -> ' + view.meta.endName);
        lines.push(tr(ctx, 'itin.totalKm') + ': ' + formatKm(plan.totalKm, ctx));
        lines.push(tr(ctx, 'itin.totalTime') + ': ' + formatDuration(plan.totalMin, ctx));
        lines.push(tr(ctx, 'itin.totalCost') + ': ' + formatMoney(costs.totalCost) +
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
            lines.push('  ' + tr(ctx, 'itin.total') + ': ' + formatMoney(c.total) +
                ' / ' + tr(ctx, 'itin.budget') + ': ' + formatMoney(c.budget) +
                (c.over ? '  ** ' + trf(ctx, 'itin.overBudgetBy', { amount: formatMoney(c.overBy) }) + ' **' : ''));
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

    function viewFromSaved(saved) {
        if (!isStructuredRoute(saved)) return null;
        const s = saved.structured;
        return {
            plan: s.plan,
            costs: s.costs || computeCosts(s.plan, {}),
            enrichment: s.enrichment || null,
            notices: Array.isArray(s.notices) ? s.notices : [],
            meta: s.meta || {}
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
        formatMoney: formatMoney,
        formatClock: formatClock,
        fill: fill,
        escapeText: esc
    };

    if (typeof window !== 'undefined') window.TravioItinerary = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
