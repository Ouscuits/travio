# Travio — Functional Baseline (pre-change)

> **This document is a historical record. It describes the app as it was at tag
> `baseline-pre-routing-fix` (commit 2852c09), not as it is now.** Everything in the
> "Baseline behaviour of the routing feature" table below has since been replaced:
> the route is computed by `js/route-engine.js`, distances and times come from a real
> road graph via `js/geo-provider.js`, and costs and provenance are handled in
> `js/itinerary-render.js`. See `docs/QUALITY_BAR.md` for where the work landed against
> the chosen bar, and `docs/ENGINE_CONTRACT.md` for the interfaces.
>
> It is kept unedited because the five workflows listed under "Workflows that must not
> regress" are still the regression contract, and because the table is the evidence for
> *why* the rewrite was necessary. Do not read it as documentation of current behaviour.

Captured 2026-08-06 from tag `baseline-pre-routing-fix` (commit 2852c09), served via
`python -m http.server 8099`, driven with Playwright/Chrome at 1440×1000.
Screenshot: `docs/img/baseline-planner.png`.

## How it runs

Static site, no build step. `index.html` loads vendored Firebase 9 compat SDKs, then
`firebase-config → i18n → firestore → route-form → auth` (auth last). Serving from any
static server works; the only runtime 404 is a missing icon reference — no JS errors.
All planner form fields exist and render: `rfStartPoint, rfEndPoint, rfDestinations,
rfDuration, rfDailyBudget, rfTolls, rfDepartureTime, generateBtn, resultBody`.

## Workflows that must not regress

1. **Auth** — email/password login (`js/auth.js`), role gate (`admin` / `user`),
   admin panel user CRUD, logout, password reset.
2. **i18n** — 5 locales (ES/EN/CA/FR/ZH) via `t()` + `applyTranslations()`, language
   selector on login and in the header, language persisted per user.
3. **Plan** — fill form → `generateRoute()` → POST to the Cloudflare Worker proxy
   (`sitoclaude-proxy.sito041971.workers.dev`) → render result.
4. **Save / load / delete routes** — Firestore `routes` collection scoped by `userId`
   (`fsSaveRoute`, `fsGetUserRoutes`, `fsDeleteRoute`, `viewSavedRoute` refills the form).
5. **PWA** — `manifest.json` + `service-worker.js`, installable, GitHub Pages hosting
   (`.nojekyll`, relative paths only — no root-absolute `/` asset paths).

## Baseline behaviour of the "routing" feature

There is **no routing logic in the codebase**. `js/route-form.js` builds one English
free-text prompt (`buildPrompt`, lines 84–143), sends it to Claude with `max_tokens:
4096`, and dumps the reply into `resultBody.textContent`. Consequences measured on the
baseline:

| Aspect | Baseline reality |
|---|---|
| Stop ordering | Delegated entirely to the model; no coordinates, no distances, unverifiable |
| Day allocation | Prompt says "for each day" but nothing enforces it; model frequently emits fewer or more days than `duration`, or crams all stops into day 1 |
| Return to origin | Nothing distinguishes a one-way trip from a loop; the model routinely closes the loop back to `startPoint` even when `endPoint` differs, and re-lists the origin between days |
| Distances / times | Model-hallucinated km and drive times; no ground truth |
| Costs | Fuel formula (7 L/100 km, €1.50/L) stated in prose only; never computed, never checked against `dailyBudget` |
| Output | Unstructured plain text — not parsable, not sortable, not exportable, no map |
| Per-day budget UI | `renderBudgetPerDay()` builds `rfBudgetDay{i}` inputs that **are never read** by `collectFormData()` — dead feature |
| `tripType` label | `displayRoute()` calls `t('form.' + tripType)`, but the i18n keys are `tripTypeLabel.*` — renders the raw key |

These are the root causes of the three reported bugs: bad routing, day/route mismatch,
and the spurious return-to-origin. They cannot be fixed by prompt wording alone — the
app needs a deterministic engine that computes the route and the day split, with the
model used only for enrichment.
