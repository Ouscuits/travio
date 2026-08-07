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
 *   geocodeOutliers(places, opts) -> [{name,displayName,km}]  PURE, SYNC, no network
 *   distanceMatrix(places, opts)-> Promise<Matrix>      OSRM table, haversine fallback
 *   routeGeometry(places, opts) -> Promise<[lat,lon][]> OSRM route polyline, straight fallback
 *   decodePolyline, haversineKm, normalisePlaceName, clearGeoCache
 *   (`resetGeoRateLimit` is a Node-only test seam — see RATE LIMITING below)
 *
 * Injection seam — every network/time/storage dependency can be stubbed:
 *   opts = { fetchImpl, sleepImpl, now, storage, minIntervalMs, cacheTtlMs,
 *            timeoutMs, nominatimUrl, osrmBase, maxTablePlaces, maxSnapKm,
 *            roadFactor, speedKmh, userAgent, language, geocodeLimit,
 *            clusterMinAnchors, clusterMoveKm,
 *            outlierMultiple, outlierMinKm, outlierMinPlaces }
 *
 * GEOCODING PROVENANCE — the second half of this file's job, and the newer half.
 *   Ten review rounds went into validating what OSRM returns and none into validating
 *   what Nominatim returns. A real user typed `Santillana de Mar, Leon, Fisterra, Lugo`
 *   for a trip round northern Spain and got 24,179 km and 268 hours. Nothing was broken:
 *   the module took Nominatim's FIRST hit, checked only that the coordinates were in
 *   range, and a village in Mexico is perfectly in range. Verified live, 2026-08:
 *       'Santillana de Mar'  -> 22.136, -100.952   San Luis Potosi, MEXICO   1 candidate
 *       'Santillana del Mar' -> 43.391,   -4.108   Cantabria, correct        1 candidate
 *       'Finisterre'         -> 48.245,   -4.044   Finistere, FRANCE         1 candidate
 *       'Fisterra'           -> 42.929,   -9.263   A Coruna, correct         3 candidates
 *       'Leon'               -> 31.272,  -95.995   Leon County, TEXAS        5 candidates
 *       'Leon' (accented)    -> 45.758,    4.832   LYON, France              5 candidates
 *   Note the first three: ONE candidate each. Ambiguity detection cannot save them —
 *   Nominatim is not uncertain, it is confidently answering a different question. Only
 *   the three signals below can, and only the third reaches that case.
 *
 *   THE APP CANNOT KNOW THE USER MEANT SPAIN. Lyon -> Brittany is a real trip. So this
 *   module never rejects a geocode; it reports what it did:
 *     - displayName    the full label of what was chosen ("San Luis Potosi, Mexico"),
 *                      never discarded, '' when nothing was resolved. Costs no heuristic
 *                      and would by itself have shown the user the fault in two seconds.
 *     - candidates     how many USABLE results the geocoder offered, i.e. the size of the
 *                      set the choice was made from. Results whose coordinates are
 *                      unusable are dropped before anything is chosen, so they are not
 *                      counted — the number describes the choice, not the HTTP body.
 *                      >1 means the name was ambiguous. 0 when unresolved.
 *     - chosenByCluster  true when a NON-FIRST candidate was preferred (see below).
 *   A cache entry written before candidate lists existed reports candidates: 1, which is
 *   honest — one candidate is all that was kept. Such entries expire within 30 days.
 *
 *   CLUSTER PREFERENCE — allowed, but never silent.
 *   "Choosing a candidate nearer the cluster is allowed; doing it silently is not."
 *   ORDERING. Geocoding is sequential at >=1100 ms and the cluster does not exist until
 *   some places have resolved, so an incremental "pick against the cluster so far" would
 *   give a different answer depending on which name the user typed FIRST — a decision
 *   varying with irrelevant input — and would need a stabilising second pass anyway.
 *   Instead the request asks for `limit=GEO_GEOCODE_LIMIT` and keeps the WHOLE candidate
 *   list, so by the end of the (unchanged) network phase every candidate is already in
 *   hand. Selection is then a PURE second pass over the collected lists:
 *       phase 1  one request per uncached name, same queue, same >=1100 ms spacing,
 *                same single-flight guarantee, same number of requests as before;
 *                provisional choice = candidate[0], exactly today's behaviour
 *       phase 2  no network at all: anchor on the places whose name was UNAMBIGUOUS
 *                (exactly one candidate), take their median centre, and for each
 *                ambiguous place prefer the candidate nearest it
 *   Cost: zero extra requests, zero extra latency, and the result is order-independent.
 *   THE ANCHOR IS A MEDIAN, NOT A MEAN. In the user's real case the unambiguous places
 *   are Santillana de Mar (MEXICO), Finisterre (FRANCE), Bilbao and Gijon — a mean sits
 *   in the Atlantic, the component-wise median sits at 43.40, -4.85, in northern Spain.
 *   A median needs to be outvoted to be wrong, hence GEO_CLUSTER_MIN_ANCHORS = 3: with
 *   fewer anchors one bad one carries the centre, and relocating everything to match a
 *   wrong anchor would manufacture a coherent-looking wrong trip that the outlier check
 *   below could no longer see. Under three anchors NOTHING is relocated — no evidence,
 *   no decision — and `candidates > 1` still carries the ambiguity to the UI.
 *   GEO_CLUSTER_MOVE_KM = 100 stops the flag becoming noise. Nominatim routinely returns
 *   several nodes for ONE town, and picking a different node of the same town is not a
 *   relocation worth telling anyone about. Both anchors measured on the live answers
 *   above: the widest spread between duplicate entries for the same town is 34 km (the
 *   two "Leon, Castilla y Leon" nodes; Fisterra's three span 14 km, Lugo's Spanish three
 *   13 km, Oviedo's two 2.8 km), and the closest pair of genuinely DIFFERENT places
 *   inside one candidate list is ~1000 km (Leon County TX vs Leon County FL). 100 km is
 *   x2.9 above the largest duplicate and x10 below the smallest distinct pair.
 *   On the user's case this moves 'Leon' from Texas to Lyon — still not what he meant,
 *   but 852 km from his trip instead of 7,704, and FLAGGED, which is the whole point.
 *
 * OUTLIERS — geocodeOutliers(places, opts) -> [{ name, displayName, km }]
 *   PURE and SYNCHRONOUS: no network, no clock, no storage, no globals. Places whose
 *   distance from the median centre of the resolved set is a large multiple of the median
 *   spread AND large in absolute terms. Sorted furthest first. Empty for a coherent trip.
 *
 *   THRESHOLDS, from measurement. 60 itineraries were scored: real trips built from known
 *   coordinates, plus the user's real failure re-run with the live answers above.
 *   TWO constants are needed, and the second one is the interesting one:
 *
 *   1. GEO_OUTLIER_MIN_KM = 5000. A RATIO ALONE IS WORTHLESS, and this is the class the
 *      first fixture did not contain — exactly the trap this file has fallen into twice
 *      before (see RETRACTED, below). A hub-and-spoke trip (several stops inside one city
 *      plus one ordinary domestic destination) has a median spread of ~4 km, so the ratio
 *      explodes on a perfectly sane plan: London stops + Edinburgh x136, Tokyo stops +
 *      Sapporo x230, New York stops + Miami x470, Perth stops + Sydney x740. Every one of
 *      those is a legitimate itinerary and no ratio threshold survives them.
 *      Both anchors are real: the furthest LEGITIMATE hub-and-spoke destination measured
 *      is 3,289 km (Perth->Sydney, at ratio x740), and the nearest wrong-continent
 *      geocode that must be caught is 7,704 km ('Leon' -> Texas). Geometric midpoint
 *      sqrt(3289 x 7704) = 5,034, hence 5,000 km — x1.52 clear above the worst real case
 *      and x1.54 clear below the case it exists to catch.
 *   2. GEO_OUTLIER_MULTIPLE = 15. The floor alone is not enough either: real trips do
 *      cross 5,000 km. Anchors, again both real: the worst COHERENT ratio among places
 *      beyond the floor is x9.69 (Vladivostok in a Moscow-St Petersburg-Kazan-Vladivostok
 *      drive, 6,099 km out), and the weakest ratio among the wrong-continent cases that
 *      must be caught is x23.09 (four Spanish cities plus the Mexican "Santillana").
 *      sqrt(9.69 x 23.09) = 14.96, hence 15 — x1.55 and x1.54 clear on the two sides.
 *   The two derivations landed on nearly identical margins independently, and the clean
 *   region of the sweep is floor 4,000-7,000 x multiple 12-20; 5,000 x 15 is its centre,
 *   not its edge. Verified over the corpus: zero false positives, zero false negatives.
 *
 *   WHAT THIS DELIBERATELY DOES NOT CATCH, and why that is right. 'Finisterre' -> Brittany
 *   is 552 km from the Spanish cluster and 'Leon' -> Lyon is 852 km. Neither is flagged,
 *   because neither is distinguishable BY GEOMETRY from a trip that really does extend
 *   into France — the contract's own line, "the app cannot know the user meant Spain".
 *   Those two cases are served by `displayName` ("Finistere, Bretagne, France") and by
 *   `candidates`, which is what those fields are for. Trying to catch them with distance
 *   would mean flagging every trip that crosses a border, and a detector that fires on
 *   ordinary trips is one users learn to ignore — which would cost the Mexico case too.
 *
 *   ACCEPTED FALSE POSITIVES: a genuinely transoceanic itinerary is flagged. Paris stops
 *   plus Guadeloupe (6,754 km) or Reunion (9,363 km) are real French domestic trips and
 *   both fire. The output is a NOTE naming a place and a distance, not a rejection, and
 *   "Saint-Denis is 9,363 km from your other destinations" is true — while a road planner
 *   asked to drive there is producing exactly the plan this branch exists to make visible.
 *
 *   KNOWN LIMITATION: when roughly half the places are wrong, geometry has nothing to say.
 *   Six places in Spain and six in Mexico give a median centre in mid-Atlantic and a
 *   median spread of thousands of km, so the ratio collapses towards 1 and the list comes
 *   back empty. This is honest — there is no majority to be an outlier FROM — and it is
 *   the reason `displayName` is mandatory rather than a fallback.
 *
 * RATE LIMITING — ONE queue, ALL THREE network entry points.
 *   geocodePlaces (Nominatim), distanceMatrix (OSRM /table) and routeGeometry (OSRM
 *   /route) all go through geoRequest(): a single global serial queue, never more than
 *   one request in flight, spaced by minIntervalMs. Both hosts are OSM community demo
 *   servers with a usage policy, and geocoding used to be the only throttled path —
 *   a plan could fire its table and route requests unthrottled, in parallel with itself.
 *   The queue tail is released by the task OR by a hard timer (timeoutMs + slack), so a
 *   `fetchImpl` that ignores AbortSignal and never settles cannot wedge the queue for
 *   the lifetime of the page.
 *   `resetGeoRateLimit()` clears that state for the Node suite. Calling it mid-flight
 *   would let two Nominatim requests leave ~33 ms apart, so it is INERT whenever a
 *   `window` exists and is not published on `window` or `window.TravioGeo` at all.
 *
 * MATRIX SOURCE — describes the WHOLE matrix, never one lucky cell:
 *   'osrm'      every off-diagonal cell is entirely road-graph data (filledCells === 0)
 *   'mixed'     some road data, some estimated (islands, ferries, unroutable pairs, or
 *               a cell where only one of distance/duration came back)
 *   'haversine' NO road-graph value contributed to any cell (osrmCells === 0; also the
 *               degenerate n < 2 case, which has no off-diagonal cell at all — the
 *               contract carves that case out of the counter laws explicitly, and the
 *               engine skips the source check entirely when dim <= 1)
 *   NOTE  osrmCells/filledCells count off-diagonal CELLS, not undirected pairs: the
 *         matrix is symmetric, so one unroutable pair contributes two cells. This is
 *         what the engine's dim*(dim-1) denominator expects ("14 of 20 cells").
 *   NOTE  they are NOT a partition. osrmCells counts cells carrying at least one
 *         road-graph value; filledCells counts cells carrying at least one estimated
 *         value; a half-real cell is in BOTH. This is the fix for a real bug: OSRM's
 *         DEFAULT /table annotation is durations only, and a distances-only or
 *         durations-only answer used to be reported as 'haversine' with osrmCells 0 —
 *         so exact road-graph numbers were shipped under a flag that made the engine
 *         say "no road data at all — every distance is a straight-line estimate".
 *         `filledCells === 0` still means 'osrm' and `osrmCells === 0` still means
 *         'haversine', which is what the contract pins down.
 *   The engine warns on 'mixed' and 'haversine', so reporting 'osrm' for a matrix
 *   that is 30% real would silently show "Palma->Ibiza 161 km by road" across open sea.
 *
 * PLAUSIBILITY FLOOR — a number is only road data if it could physically be one.
 *   OSRM (or a proxy, or a cached error page) can return values that are numerically
 *   fine and physically impossible: 617 km in 1 second, or an all-zero grid between
 *   cities 500 km apart. Both used to ship as clean 'osrm', and because the engine caps
 *   days on `min`, a zero-minute leg packs the trip into too few days — the exact
 *   day-splitting bug this branch exists to kill.
 *
 *   WRONG-PAIR ANSWERS — READ THE SIGNAL, DO NOT INFER IT. OSRM answers about the nearest
 *   road, not about the coordinate you sent, and when nothing is reachable it will drag a
 *   waypoint an arbitrary distance to find one. It reports exactly how far in
 *   sources[k].distance / destinations[k].distance, in metres. This module inferred the
 *   same thing from a distance-ratio PROXY instead, and the proxy fails whenever the
 *   wrong place happens to sit at a plausible distance:
 *       Melilla -> Madrid   snap 155.8 km   ratio x0.97   MISSED, shipped as measured
 *       Ceuta   -> Madrid   snap  22.5 km   ratio x1.29   MISSED, shipped as measured
 *       Algeciras -> Ceuta  snap  22.5 km   ratio x0.39   caught, by luck
 *   Melilla is a Spanish exclave in North Africa: OSRM snapped it across the
 *   Mediterranean and answered about Almería, understating the journey by roughly half a
 *   day. Note the second line — the SAME mis-snapped waypoint was caught in one direction
 *   and missed in another, so the proxy's coverage was direction-dependent, which is what
 *   a proxy looks like when it is standing in for the thing you actually care about.
 *   Now: a waypoint snapped more than maxSnapKm is treated exactly as if it had never
 *   been sent, so EVERY cell touching it falls back to geometry — not just the ones whose
 *   distance happens to look wrong.
 *   THRESHOLD 10 km, and both anchors are real measurements (contrast the detour ceiling
 *   below, whose upper anchor is not):
 *     - largest snap where driving to the vicinity is still the honest answer: 4.44 km,
 *       Mont Blanc summit. Ordinary town and city geocodes measure <= 0.5 km across 60+
 *       routes; Ben Nevis 2.16, Preikestolen 2.48, remote fjord quays 1.35.
 *     - smallest snap that produces an answer about somewhere else: 22.49 km, Ceuta.
 *     - geometric midpoint 9.99, hence 10 km — x2.25 clear on each side.
 *   A ~25 km threshold was proposed and would sit ABOVE Ceuta, missing the case that
 *   motivated the whole rule. Absent fields yield NaN and condemn nothing: never condemn
 *   on missing evidence, because a proxy or an older OSRM may not report the field.
 *
 *   THE SHORTFALL RATIO IS STILL LOAD-BEARING, for the complementary case. Snap distance
 *   catches a waypoint dragged far away. It cannot catch two waypoints that each snapped
 *   to a road a few metres away, where those roads sit on opposite banks of something
 *   unbridged — the route then goes the long way round, or along one shore, and the
 *   snap distances look perfect. Measured: Mannheller -> Fodnes across the Sognefjord
 *   snapped only 2.04 km, but BOTH waypoints landed on the same road, "Erdalsvegen", on
 *   the same shore, and the 1.33 km answer is x0.49 of the great circle. Snap says
 *   nothing; the ratio condemns it. Neither guard subsumes the other:
 *       snap check      -> large snap, any resulting distance   (Melilla, x0.97)
 *       shortfall ratio -> any snap, impossible resulting distance (Mannheller, 2.0 km)
 *
 *   THE GOVERNING RULE: each half of a cell is judged against what is actually KNOWN
 *   about it — the great-circle distance — and NEVER against the other half's estimate.
 *   An estimate is not a reference for validating a measurement. Charging the estimate's
 *   error against a real duration destroyed real data: two places 9.3 km apart with a
 *   112 km / 140 min road between them (a 12x detour, entirely real) implied a fake
 *   4 km/h, so the 140-minute duration was thrown away and replaced by 7.8 minutes —
 *   18x too small, with no warning. Hence three separate tests:
 *     - DISTANCE (needs only geometry): a road is never materially shorter than the
 *       great circle beneath it (cellKm + 0.5 >= straightKm * 0.90, slack for OSRM
 *       snapping to the nearest road) and never more than 30x + 50 km longer.
 *     - PAIR SPEED (only when BOTH halves are measured): at most 200 km/h, and at most
 *       geoMaxDurationMin(km, crow) in total.
 *     - DURATION ALONE (measured duration, estimated distance): rejected only when NO
 *       credible road length makes it drivable — too fast even along the great circle,
 *       or longer than the ceiling allows even along the 30x road.
 *   A measured distance with no duration needs no time test at all: the duration is
 *   derived from it at the calibrated speed, so it is in band by construction.
 *   Legs under 1 km are exempt (rounding noise dominates and nothing is at stake).
 *   A value that fails is treated exactly like a null: discarded and haversine-filled.
 *
 *   THRESHOLDS, from measurement rather than taste:
 *     - detour ceiling 30x + 50 km. This one is DELIBERATELY NOT FITTED, and the reason
 *       is the most transferable thing in this file. It was fitted, at 10x, and it kept
 *       producing casualties: the worst real ratio grew every single time a new class of
 *       geography was measured — x4.45 Helsinki–Stockholm, x6.51 Athens–Chios, x7.73
 *       Oban–Craignure, x9.38 Oanes–Lauvvik, x13.86 Gedser–Rostock — and at 10x it
 *       destroyed three real routes outright (Gedser–Rostock, Brindisi–Igoumenitsa,
 *       Hirtshals–Kristiansand), while Naantali–Kapellskär survived at x9.83 by nothing
 *       at all. A bound fitted to the worst case yet seen is a bound that fails on the
 *       next geography anyone tries.
 *       It can be loose because it has almost no unique work left to do. A distance that
 *       is not a road is already condemned by the shortfall rule (whole cell), and one
 *       that disagrees with its duration by the 200 km/h pair-speed guard: 3000 km and
 *       6000 km in 360 min both clear a 30x ceiling and are both still rejected on speed.
 *       The ONLY thing the ceiling uniquely catches is a distance that is absurd AND
 *       internally consistent with its duration — the x60 case, 30 305 km in 202 h at
 *       150 km/h. That case pins the only remaining constraint: the ceiling must stay
 *       below x59.9, or it stops doing its one job.
 *       HONESTY ABOUT WHAT THAT DERIVATION IS. x59.9 is NOT a property of road networks.
 *       It is a property of a synthetic x60 fixture invented for this test suite: had
 *       that fabrication been written as x25, the same arithmetic would yield a different
 *       constant. So this is a fit with one real anchor (x13.86 measured) and one
 *       arbitrary one, dressed as a derivation. x30 is kept because the EVIDENCE supports
 *       it — 89 live routes measured across every geography anyone has thought to try,
 *       zero over the ceiling, worst x13.86 — not because the midpoint arithmetic proves
 *       anything. Compare the snap threshold above, where both anchors are measured; that
 *       is what a derived bound actually looks like.
 *       COST OF THE WIDENING, which the round-8 note omitted: moving x10 -> x30 admits
 *       self-consistent fabrications in the x10–x30 band that x10 refused — 15 200 km at
 *       152 km/h for a Madrid–Barcelona pair clears the ceiling, the 200 km/h guard and
 *       the duration cap alike. Nothing downstream catches that. What makes it acceptable
 *       is the snap check above: the realistic way such a number arises is a waypoint
 *       answered about somewhere else, and that is now detected at source rather than
 *       inferred from how odd the distance looks. The two changes belong together.
 *       For reference, the bound is placed at the geometric
 *       midpoint of the two things that actually constrain it — x13.86 (worst measured
 *       real) and x59.9 (junk) is x28.8, hence 30x. That is x2.16 clear of any real route
 *       and x2.00 clear of failing its purpose, and it is derived from the constraints
 *       rather than from the data's current extreme.
 *       The +50 km is headroom for short legs, where a large ratio is cheap and common
 *       (an estuary crossing to the nearest bridge). On short legs the slack, not the
 *       ratio, is what carries them.
 *     - speed ceiling 200 km/h, flat: OSRM's car profile tops out near 140 km/h on
 *       motorways, so 200 leaves 43% headroom and no real route averages above it.
 *
 *   THE SLOW SIDE — why no minimum-speed CONSTANT exists.
 *   There used to be one (5 km/h short, rising to a flat 30 km/h over 300 km) and it was
 *   wrong: Athens -> Iraklio is 644 km of real OSRM ferry route at 34.8 km/h, only 16%
 *   above that floor, so a slower sailing was rejected and 1290 real minutes became
 *   266.8 — a 4.8x understatement, silent. Widening the floor does not fix it. 36 routes
 *   were measured live against router.project-osrm.org over the worst geography
 *   available (Balearics, Aegean, Tyrrhenian, Adriatic, Baltic, Channel, Norwegian
 *   coast, Iceland, Hebrides, plus every short island hop that could stress the rule):
 *       Athens–Mykonos      176 km in 28.9 h =  6.09 km/h   REAL
 *       Madrid–Barcelona    620 km in 84 h   =  7.38 km/h   JUNK
 *       Palermo–Lampedusa   354 km in 46.9 h =  7.55 km/h   REAL
 *       Athens–Santorini    290 km in 37.8 h =  7.67 km/h   REAL
 *       Athens–Iraklio      644 km in 18.5 h = 34.81 km/h   REAL
 *   TWO real routes STRADDLE the junk, so any constant C would have to satisfy
 *   C <= 6.09 to keep Mykonos and C > 7.38 to reject the junk. No such C exists — that,
 *   and not "no speed test can work", is the proof. The shipped rule IS a speed floor,
 *       minSpeed(km) = km / (min(48 h, crow/3) + km/30)
 *   it simply never reaches a constant at any real distance: 3.27 km/h at Mykonos's
 *   176 km, 5.03 at Santorini's 290 km, 5.92 at Lampedusa's 354 km, 9.27 at Iraklio's
 *   644 km, and 9.03 for the 620 km junk — above its 7.38 km/h, which is how one junk
 *   case is rejected while two slower real ones are kept. It approaches 30 km/h only as
 *   km grows without bound. Average speed alone fails because it conflates a wait
 *   (which does not scale with distance) with progress (which does); stated as a
 *   duration ceiling those two separate cleanly:
 *       maxDuration = min(48 h, max(2 h, crow / 3)) + km / 30 km/h
 *   These constants are an EMPIRICAL ENVELOPE over measured OSRM output, not a model of
 *   ferry timetables — OSRM routes on way weights and does not know a schedule, and the
 *   long durations above come from its own low weighting of ferry ways. The envelope is
 *   fitted, and only its shape is argued: a term that does not scale with distance plus
 *   one that does, because that is the only way to separate the overlapping cases above.
 *   The distance-independent term is capped by the great-circle separation because it is
 *   only earned where a water crossing could exist at all: granting it flat let a 10 km
 *   city hop claim 48 hours and ship LABELLED AS MEASURED, which stripped the slow-side
 *   protection from exactly the legs a city itinerary is made of. It is FLOORED at 2 h
 *   because scaling alone drove it to nothing across a narrow channel — see the retracted
 *   premise below. Against all 51 measured routes the tightest headroom is x1.28
 *   (Palermo–Lampedusa, 46.9 h against a 59.8 h cap), the tightest among narrow crossings
 *   is x1.79 (Oanes–Lauvvik), and not one is rejected. OSRM's /table response carries no
 *   ferry flag — only distances and durations — so detecting the ferry directly, the
 *   other option considered, is not possible from what this module receives.
 *
 *   RETRACTED — this file previously asserted, as the justification for scaling the
 *   allowance by separation: "every slow route in the 36 has a crow line of at least
 *   74 km". FALSE, and false because the fixture behind it contained no narrow slow
 *   crossing — 14 short hops had been measured, but all across wide water (Messina
 *   7.7 km, Dover–Calais, Helsinki–Tallinn), none under 3 km with a slow sailing. The
 *   sentence generalised from a hole in the data and was then used as a premise. Fifteen
 *   narrow crossings measured since falsify it outright:
 *       Woolwich Ferry (Thames)   crow 0.34 km, road 2.67 km, 16.2 min
 *       Oanes–Lauvvik (Lysefjord) crow 1.28 km, road 12.0 km, 80.4 min
 *       Lavik–Oppedal (Sognefjord) crow 2.6–3.0 km, road ~9-10 km, ~74 min
 *   Under the unfloored rule the first two were condemned outright and the third sat on
 *   the cliff edge, surviving by 5% or dying depending on which quay coordinate you
 *   resolve. A measured duration was being replaced by an estimate 35x smaller — the
 *   same failure, in the same direction, that this file already treated as disqualifying
 *   at long range, reintroduced at short range and worse in degree.
 *
 *   RETRACTED, AGAIN, AND THIS IS THE PATTERN WORTH LEARNING. This file also asserted
 *   "the ceiling has never rejected a real route", and cited x5.23 of headroom at
 *   Oanes–Lauvvik as evidence it was safe. Both were false, and false the SAME WAY as
 *   the 74 km premise above: the headroom was computed over a population that contained
 *   no enclosed-sea crossing, so it characterised the wrong distribution and described a
 *   safety that did not exist. Measuring a bound's margin against the fixture is only
 *   meaningful if the fixture contains the class that would stress it — otherwise the
 *   margin is a statement about what was measured, not about the bound.
 *   Switching from a ratio band to headroom was the right instinct and is kept; it just
 *   cannot rescue a population with a hole in it.
 *   The two failures rhyme exactly: each new class of geography (narrow crossings, then
 *   enclosed seas) falsified a bound that looked safe, because the evidence for "safe"
 *   was drawn from data that excluded it. Hence:
 *     - BEFORE narrowing any bound here, check whether the fixture contains the case the
 *       new bound would exclude — and if the class does not exist in it, go and measure
 *       it rather than reasoning about it;
 *     - PREFER a bound derived from what actually constrains it (see the detour ceiling)
 *       over one fitted to the worst case observed so far. Every bound in this file that
 *       was fitted to observation has since produced a casualty; the failures were never
 *       mis-chosen constants, they were confident generalisations from incomplete data.
 *
 *   WHICH DIRECTION IS "SAFE" — this file makes two calls that look opposed:
 *   FALLBACK CALIBRATION says a pessimistic speed is bad because it over-splits days,
 *   and the slow-side rule above is deliberately generous towards over-long durations.
 *   They are not in tension because they govern different objects:
 *     - an INVENTED value must be ACCURATE. Nothing measured it, so a conservative guess
 *       is not caution, it is a fabricated warning: 75 km/h manufactured over-cap flags
 *       out of thin air. Hence 90 km/h, the measured mean.
 *     - DISCARDING A MEASUREMENT must require proof, not suspicion. The replacement is
 *       not a conservative value either — it is that same estimate, and for a ferry leg
 *       it is 4.8x too small. So when a measurement merely looks odd, it is kept.
 *   Ranked by harm: silently understating drive time (the plan looks feasible and the
 *   user drives 18 hours) is worse than overstating it (the flag is 'mixed', the engine's
 *   overDriveCap fires, the user sees it and can argue), which is worse than an estimate
 *   being a few percent off. Optimise the estimate for accuracy; optimise the decision to
 *   throw a measurement away for caution.
 *
 * FALLBACK CALIBRATION — haversine × 1.25 at 90 km/h.
 *   Measured against live OSRM on long Spanish routes: the 1.25 road factor is well
 *   calibrated on distance, but 75 km/h was 22–26% pessimistic on time. Because the
 *   engine enforces maxDriveMinPerDay on `min`, a pessimistic speed invents false
 *   over-cap warnings and over-splits days — the exact bug class this project set out
 *   to fix. Five long Spanish routes measured 87.6–92.8 km/h, mean 90.6.
 *   DIVERGENCE (deliberate, and it is a duplication, not a disagreement): this file
 *   used 88 while js/route-engine.js uses FALLBACK_SPEED_KMH = 90 for the matrix it
 *   synthesises when none is supplied. One physical constant living in two files will
 *   drift, so this file now carries 90 — the same number the engine uses and the one
 *   closest to the measured mean. The two are still two declarations; the permanent
 *   fix is for the provider to be the single publisher (it already exports
 *   GEO_SPEED_KMH / GEO_ROAD_FACTOR) and for the engine to read them when present.
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
    const GEO_SPEED_KMH       = 90;                 // fallback average driving speed
    const GEO_EARTH_R_KM      = 6371.0088;

    /* Plausibility floor for values claimed to come from the road graph.
       Every threshold below is derived from measurement — see PLAUSIBILITY FLOOR. */
    const GEO_MAX_SPEED_KMH      = 200;             // faster than this is not driving, at any length
    const GEO_STOPPAGE_ALLOWANCE_MIN = 48 * 60;     // upper bound on the distance-free term
    const GEO_ALLOWANCE_PER_CROW_MIN = 20;          // scaled by separation: crow / 3 in hours
    const GEO_MIN_CROSSING_ALLOWANCE_MIN = 120;     // floor: a narrow crossing is still a crossing
    const GEO_MIN_SUSTAINED_KMH  = 30;              // slowest sustained progress once moving
    const GEO_MAX_DETOUR         = 30;              // road / great circle — a LOOSE sanity
                                                    // bound, deliberately not fitted
    const GEO_DETOUR_SLACK_KM    = 50;              // absolute headroom for short legs
    const GEO_PLAUSIBLE_MIN_KM = 1;                 // below this, nothing is at stake
    const GEO_SHORTFALL_RATIO = 0.90;               // road vs great circle, with slack for
    const GEO_SHORTFALL_SLACK = 0.5;                // OSRM snapping to the nearest road
    const GEO_GEOMETRY_SLACK_KM = 1;                // polyline rounding, on top of the snap
    const GEO_MAX_SNAP_KM     = 10;                 // how far OSRM may move a waypoint onto
                                                    // a road before it is a different place
    const GEO_QUEUE_SLACK_MS  = 500;                // grace before the queue tail self-releases

    /* Geocoding provenance — see GEOCODING PROVENANCE and OUTLIERS in the header.
       Every constant below is derived from measurement, and the derivation is written
       down beside it there, not here. */
    const GEO_GEOCODE_LIMIT       = 5;      // candidates asked of Nominatim (was 1)
    const GEO_DISPLAY_NAME_MAX    = 300;    // defensive cap; live labels run 40-150 chars
    const GEO_CLUSTER_MIN_ANCHORS = 3;      // fewer unambiguous places -> relocate nothing
    const GEO_CLUSTER_MOVE_KM     = 100;    // below this it is the same town, not a move
    const GEO_OUTLIER_MULTIPLE    = 15;     // x median spread from the median centre
    const GEO_OUTLIER_MIN_KM      = 5000;   // and this far in absolute terms
    const GEO_OUTLIER_MIN_PLACES  = 3;      // two places are always equidistant from
                                            // their own median: nothing to compare

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
            maxSnapKm:      typeof o.maxSnapKm === 'number' && o.maxSnapKm >= 0 ? o.maxSnapKm : GEO_MAX_SNAP_KM,
            roadFactor:     typeof o.roadFactor === 'number' && o.roadFactor > 0 ? o.roadFactor : GEO_ROAD_FACTOR,
            speedKmh:       typeof o.speedKmh === 'number' && o.speedKmh > 0 ? o.speedKmh : GEO_SPEED_KMH,
            userAgent:      o.userAgent || '',
            language:       o.language || '',
            geocodeLimit:   typeof o.geocodeLimit === 'number' && o.geocodeLimit >= 1
                                ? Math.floor(o.geocodeLimit) : GEO_GEOCODE_LIMIT,
            clusterMinAnchors: typeof o.clusterMinAnchors === 'number' && o.clusterMinAnchors >= 1
                                ? Math.floor(o.clusterMinAnchors) : GEO_CLUSTER_MIN_ANCHORS,
            clusterMoveKm:  typeof o.clusterMoveKm === 'number' && o.clusterMoveKm >= 0
                                ? o.clusterMoveKm : GEO_CLUSTER_MOVE_KM
        };
    }

    /*
     * geocodeOutliers is PURE and SYNCHRONOUS by contract, so it deliberately does NOT go
     * through geoOptions — that would reach for fetch, localStorage and a clock it must
     * never touch. Three numbers, read directly, nothing else.
     */
    function geoOutlierOptions(opts) {
        const o = opts && typeof opts === 'object' ? opts : {};
        return {
            multiple:  typeof o.outlierMultiple === 'number' && o.outlierMultiple > 0
                           ? o.outlierMultiple : GEO_OUTLIER_MULTIPLE,
            minKm:     typeof o.outlierMinKm === 'number' && o.outlierMinKm >= 0
                           ? o.outlierMinKm : GEO_OUTLIER_MIN_KM,
            minPlaces: typeof o.outlierMinPlaces === 'number' && o.outlierMinPlaces >= 2
                           ? Math.floor(o.outlierMinPlaces) : GEO_OUTLIER_MIN_PLACES
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

    /* A label is a string or it is nothing. Capped, so a hostile or broken body cannot
       push an unbounded blob into localStorage; live Nominatim labels run 40-150 chars. */
    function geoDisplayName(v) {
        if (typeof v !== 'string') return '';
        return v.length > GEO_DISPLAY_NAME_MAX ? v.slice(0, GEO_DISPLAY_NAME_MAX) : v;
    }

    /*
     * Every Place this module produces carries the three provenance fields, always, with
     * the same types — a consumer must never have to test for their presence, and an
     * `undefined` displayName would read on screen as a place with no name rather than as
     * a place that could not be resolved.
     */
    function geoMakePlace(name, lat, lon, source, extra) {
        const ok = geoIsFiniteNumber(lat) && geoIsFiniteNumber(lon) && geoValidLatLon(lat, lon);
        const place = {
            name: (name === null || name === undefined) ? '' : String(name),
            lat: ok ? lat : null,
            lon: ok ? lon : null,
            resolved: ok,
            source: source,
            displayName: '',
            candidates: 0,
            chosenByCluster: false
        };
        if (extra) {
            for (const k in extra) {
                if (Object.prototype.hasOwnProperty.call(extra, k)) place[k] = extra[k];
            }
        }
        place.displayName = geoDisplayName(place.displayName);
        place.candidates = geoIsFiniteNumber(place.candidates) && place.candidates >= 0
            ? Math.floor(place.candidates) : 0;
        place.chosenByCluster = place.chosenByCluster === true;
        /* Nothing was chosen, so there is no label of what was chosen. */
        if (!ok) {
            place.displayName = '';
            place.chosenByCluster = false;
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

    /* ── Robust centre of a set of points ── */
    /*
     * MEDIAN, not mean, and the reason is the bug this exists for: in the user's real
     * case one of four anchors was in Mexico, and a mean sits in the Atlantic while the
     * component-wise median sits in northern Spain. A median has to be OUTVOTED to move.
     */
    function geoMedian(values) {
        const s = values.slice().sort(function (a, b) { return a - b; });
        const n = s.length;
        if (n === 0) return 0;
        const mid = n >> 1;
        return (n % 2) ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    }

    /*
     * Longitude is circular, so a plain median is wrong across the antimeridian: the
     * middle of 179 and -179 is 180, not 0. Placing the trip's centre on the far side of
     * the planet would make every place in it look like an outlier. Cut the circle at the
     * WIDEST empty gap — the one arrangement in which the points form a single arc — then
     * take an ordinary median of the unwrapped values. O(n log n), n <= a few dozen.
     */
    function geoMedianLon(values) {
        const n = values.length;
        if (n === 0) return 0;
        const s = values.slice().sort(function (a, b) { return a - b; });
        let widest = -1, cut = n - 1;
        for (let i = 0; i < n; i++) {
            const gap = (i === n - 1) ? (s[0] + 360 - s[i]) : (s[i + 1] - s[i]);
            if (gap > widest) { widest = gap; cut = i; }
        }
        const unwrapped = new Array(n);
        for (let i = 0; i < n; i++) {
            const idx = (cut + 1 + i) % n;
            unwrapped[i] = idx <= cut ? s[idx] + 360 : s[idx];
        }
        let m = geoMedian(unwrapped);
        while (m > 180) m -= 360;
        while (m < -180) m += 360;
        return m;
    }

    /* points: [{lat, lon}, ...] — caller guarantees they are valid coordinates. */
    function geoMedianCentre(points) {
        const lats = new Array(points.length);
        const lons = new Array(points.length);
        for (let i = 0; i < points.length; i++) { lats[i] = points[i].lat; lons[i] = points[i].lon; }
        return { lat: geoMedian(lats), lon: geoMedianLon(lons) };
    }

    function geoNoop() { /* deliberately empty */ }

    /*
     * Resolve with `promise`, or with `fallback` after `ms` — and NEVER hang.
     * AbortController is a request to stop; it is not a guarantee. A fetch polyfill,
     * a service worker, or a patched XHR shim can ignore `signal` entirely, and then
     * `timeoutMs` releases nothing: the awaiting task never settles, the serial queue
     * never advances, and the only escape is a page reload. So the WAIT is guarded
     * here, independently of whether the abort ever lands.
     * Rejection is folded into `fallback` too: callers of this module never see throws.
     */
    function geoWithDeadline(promise, ms, fallback) {
        const g = geoGlobalObject();
        if (!(ms > 0) || typeof g.setTimeout !== 'function') {
            return Promise.resolve(promise).then(null, function () { return fallback; });
        }
        return new Promise(function (resolve) {
            let settled = false;
            const timer = g.setTimeout(function () {
                if (settled) return;
                settled = true;
                resolve(fallback);
            }, ms);
            const finish = function (value) {
                if (settled) return;
                settled = true;
                if (typeof g.clearTimeout === 'function') g.clearTimeout(timer);
                resolve(value);
            };
            Promise.resolve(promise).then(
                function (v) { finish(v); },
                function () { finish(fallback); }
            );
        });
    }

    /* ── HTTP (never throws, never hangs, returns null on any failure) ── */
    async function geoFetchOnce(url, cfg) {
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

    function geoFetchJson(url, cfg) {
        if (typeof cfg.fetchImpl !== 'function') return Promise.resolve(null);
        /* The abort above is the polite ask; this deadline is the guarantee. */
        return geoWithDeadline(geoFetchOnce(url, cfg), cfg.timeoutMs, null);
    }

    /* ── Serial request queue + rate limiter (OSM: 1 request per second, one in flight) ── */
    let geoQueueTail = Promise.resolve();
    let geoLastRequestAt = 0;

    /*
     * The tail advances when the task settles OR when a cap expires — whichever comes
     * first. Without the cap, one task that never settles blocks every future request in
     * the page permanently, and the only escape is a reload.
     * The cap clock starts when the task actually BEGINS, not when it was enqueued: the
     * fifth item of a queue may sit for seconds before it runs, and a cap measured from
     * enqueue time would expire under a request that is still perfectly healthy — which
     * would put two requests in flight, the thing the queue exists to prevent.
     * It also covers the throttle sleep, not just the fetch, because a hostile
     * `sleepImpl` is one more way to never come back.
     */
    function geoEnqueue(task, cfg) {
        const capMs = (cfg && cfg.timeoutMs > 0 ? cfg.timeoutMs : GEO_TIMEOUT_MS) +
                      (cfg && cfg.minIntervalMs > 0 ? cfg.minIntervalMs : GEO_MIN_INTERVAL_MS) +
                      GEO_QUEUE_SLACK_MS;

        let release = geoNoop;
        const gate = new Promise(function (resolve) { release = resolve; });
        const previous = geoQueueTail;
        geoQueueTail = gate;

        function runTask() {
            const started = Promise.resolve().then(task);
            geoWithDeadline(started.then(geoNoop, geoNoop), capMs, undefined)
                .then(release, release);
            return started;
        }
        return previous.then(runTask, runTask);
    }

    async function geoThrottle(cfg) {
        const elapsed = cfg.now() - geoLastRequestAt;
        const wait = cfg.minIntervalMs - elapsed;
        if (wait > 0) await cfg.sleepImpl(wait);
        geoLastRequestAt = cfg.now();
    }

    /*
     * The ONLY way out of this module. Nominatim and both OSRM endpoints share it, so
     * "one request in flight, spaced by minIntervalMs" is a property of the module and
     * not of one lucky call site. Never throws.
     */
    function geoRequest(url, cfg) {
        return geoEnqueue(async function () {
            try {
                await geoThrottle(cfg);
                return await geoFetchJson(url, cfg);
            } catch (e) {
                return null;                    // e.g. a hostile sleepImpl
            }
        }, cfg);
    }

    /*
     * Test seam: forget the last-request timestamp and drain the queue reference.
     * INERT in the browser. It is reachable there only by accident, and a mid-flight
     * call collapses the spacing between two Nominatim requests to a few milliseconds,
     * which is precisely the OSM usage policy this module exists to respect. The Node
     * suite has no `window`, so it keeps the seam. Returns whether it did anything.
     */
    function resetGeoRateLimit() {
        if (typeof window !== 'undefined') return false;
        geoQueueTail = Promise.resolve();
        geoLastRequestAt = 0;
        return true;
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
     * rejected, because those coordinates go straight into the OSRM URL. That now applies
     * per CANDIDATE as well as to the entry as a whole. A future-dated timestamp (beyond
     * a small clock skew) is treated as expired: `now - ts > ttl` is false forever for
     * `ts = 9e15`, so it would otherwise be an immortal entry.
     *
     * Returns the CANDIDATE LIST, never a single point.
     *
     * FORMAT, and why it is compatible in both directions. `lat`/`lon`/`displayName` still
     * describe the geocoder's FIRST candidate exactly as before, so an entry written by
     * this version is readable by the previous one; `cands` is additive, so an entry
     * written by the previous version is readable here and simply yields one candidate.
     * Bumping the key prefix instead would have orphaned every existing entry in the
     * user's localStorage with no code left that knows how to remove them.
     *
     * WHAT IS CACHED IS THE GEOCODER'S ANSWER, NEVER THE TRIP'S CHOICE. Cluster preference
     * depends on the other places in the same request, so caching a cluster-chosen point
     * would bake a decision made for one trip into every later trip that names the same
     * place. The list is stored raw and in the geocoder's own order; the choice is redone
     * from scratch on every call.
     */
    function geoCacheCandidate(c) {
        let lat, lon, label;
        if (Array.isArray(c)) {
            lat = geoCoordNum(c[0]); lon = geoCoordNum(c[1]); label = geoDisplayName(c[2]);
        } else if (c && typeof c === 'object') {
            lat = geoCoordNum(c.lat); lon = geoCoordNum(c.lon); label = geoDisplayName(c.displayName);
        } else {
            return null;
        }
        if (!geoValidLatLon(lat, lon)) return null;
        return { lat: lat, lon: lon, displayName: label };
    }

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

        const list = [{ lat: lat, lon: lon, displayName: geoDisplayName(entry.displayName) }];
        if (Array.isArray(entry.cands) && entry.cands.length) {
            const parsed = [];
            for (let i = 0; i < entry.cands.length && parsed.length < cfg.geocodeLimit; i++) {
                const c = geoCacheCandidate(entry.cands[i]);
                if (c) parsed.push(c);            // an unusable candidate is dropped, not served
            }
            if (parsed.length) return parsed;
        }
        return list;
    }

    /* `list` is the candidate list as the geocoder returned it — see the note above. */
    function geoCacheWrite(name, list, cfg) {
        if (!cfg.storage || typeof cfg.storage.setItem !== 'function') return;
        if (!Array.isArray(list) || !list.length) return;
        if (!geoValidLatLon(list[0].lat, list[0].lon)) return;
        const cands = [];
        for (let i = 0; i < list.length && i < cfg.geocodeLimit; i++) {
            cands.push([list[i].lat, list[i].lon, list[i].displayName]);
        }
        try {
            cfg.storage.setItem(geoCacheKey(name), JSON.stringify({
                lat: list[0].lat, lon: list[0].lon,
                displayName: list[0].displayName || '',
                ts: cfg.now(), cands: cands
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
    /*
     * limit=GEO_GEOCODE_LIMIT, not 1. Asking for one answer makes ambiguity invisible:
     * 'Leon' has five candidates and 'Lugo' has five, and the module could not say so
     * because it never asked. It is the SAME request either way — no extra round trip,
     * no extra spacing, nothing the OSM usage policy notices.
     */
    function geoNominatimUrl(name, cfg) {
        return cfg.nominatimUrl + '?format=jsonv2&limit=' + cfg.geocodeLimit +
               '&q=' + encodeURIComponent(name);
    }

    /*
     * -> [{ lat, lon, displayName }, ...] in the geocoder's own order, or null if nothing
     * usable came back. A result whose coordinates are unusable is dropped rather than
     * failing the whole lookup: it is not a destination anyone could have meant, and it
     * is not counted in `candidates` either — that number describes the set the choice
     * was made from, not the size of the HTTP body.
     */
    function geoParseNominatim(data, cfg) {
        if (!data) return null;
        const arr = Array.isArray(data) ? data : [data];
        const limit = cfg && cfg.geocodeLimit > 0 ? cfg.geocodeLimit : GEO_GEOCODE_LIMIT;
        const out = [];
        for (let i = 0; i < arr.length && out.length < limit; i++) {
            const r = arr[i];
            if (!r || typeof r !== 'object') continue;
            const lat = geoCoordNum(r.lat);
            const lon = geoCoordNum(r.lon);
            if (!geoValidLatLon(lat, lon)) continue;
            out.push({ lat: lat, lon: lon, displayName: geoDisplayName(r.display_name) });
        }
        return out.length ? out : null;
    }

    function geoPlaceFromCandidates(name, list, source) {
        const c = list[0];
        return geoMakePlace(name, c.lat, c.lon, source, {
            displayName: c.displayName,
            candidates: list.length,
            chosenByCluster: false
        });
    }

    /*
     * PHASE 2 of geocoding — pure, no network, runs once every candidate list is in hand.
     * See CLUSTER PREFERENCE in the header for why the choice is made here rather than
     * incrementally during the (rate-limited, sequential) network phase.
     *
     * Mutates `out` in place. Every relocation sets `chosenByCluster`, without exception:
     * a user whose trip really does span continents must not have a destination quietly
     * moved, so the flag is what makes the choice reviewable rather than imposed.
     */
    function geoPreferCluster(out, candidateLists, cfg) {
        /* Anchors: resolved places whose name was UNAMBIGUOUS. A name repeated by the
           user is one place, not two votes — normalised-name dedup keeps the median
           honest about how many distinct anchors there really are. */
        const anchors = [];
        const seen = Object.create(null);
        for (let i = 0; i < out.length; i++) {
            const list = candidateLists[i];
            if (!out[i] || !out[i].resolved || !list || list.length !== 1) continue;
            const key = normalisePlaceName(out[i].name);
            if (seen[key]) continue;
            seen[key] = true;
            anchors.push({ lat: list[0].lat, lon: list[0].lon });
        }
        if (anchors.length < cfg.clusterMinAnchors) return;

        const centre = geoMedianCentre(anchors);

        for (let i = 0; i < out.length; i++) {
            const list = candidateLists[i];
            if (!out[i] || !out[i].resolved || !list || list.length < 2) continue;

            let best = 0;
            let bestKm = haversineKm(centre.lat, centre.lon, list[0].lat, list[0].lon);
            for (let k = 1; k < list.length; k++) {
                const d = haversineKm(centre.lat, centre.lon, list[k].lat, list[k].lon);
                if (d < bestKm) { bestKm = d; best = k; }   // strict: ties keep the earlier
            }
            if (best === 0) continue;

            /* Nominatim routinely returns several nodes for ONE town. Swapping between
               them is not a relocation and must not raise a flag the UI would have to
               explain — see GEO_CLUSTER_MOVE_KM in the header. */
            const moved = haversineKm(list[0].lat, list[0].lon, list[best].lat, list[best].lon);
            if (moved <= cfg.clusterMoveKm) continue;

            out[i].lat = list[best].lat;
            out[i].lon = list[best].lon;
            out[i].displayName = list[best].displayName;
            out[i].chosenByCluster = true;
        }
    }

    /*
     * geocodePlaces(names, opts) -> Promise<Place[]>
     * Sequential (>=1100ms apart, one request in flight at a time), cached, and
     * strictly index-aligned to `names`: never throws, never reorders, never drops.
     * A failed lookup yields { lat:null, lon:null, resolved:false } at its own index.
     * Two phases — network, then a pure cluster pass. Phase 2 issues no requests.
     */
    async function geocodePlaces(names, opts) {
        const cfg = geoOptions(opts);
        const list = Array.isArray(names) ? names : (names ? [names] : []);
        const out = new Array(list.length);
        const candidateLists = new Array(list.length);
        const localCache = new Map();   // dedupe repeated names inside one call

        for (let i = 0; i < list.length; i++) {
            const raw = list[i];
            const name = (raw === null || raw === undefined) ? '' : String(raw);
            const key = normalisePlaceName(name);
            candidateLists[i] = null;

            if (!key) {
                out[i] = geoMakePlace(name, null, null, 'osm', { error: 'empty-name' });
                continue;
            }

            if (localCache.has(key)) {
                const hit = localCache.get(key);
                candidateLists[i] = hit;
                out[i] = geoPlaceFromCandidates(name, hit, 'cache');
                continue;
            }

            const cached = geoCacheRead(name, cfg);
            if (cached) {
                localCache.set(key, cached);
                candidateLists[i] = cached;
                out[i] = geoPlaceFromCandidates(name, cached, 'cache');
                continue;
            }

            /* Network path — serialised and throttled through the shared queue. */
            const hit = geoParseNominatim(await geoRequest(geoNominatimUrl(name, cfg), cfg), cfg);

            if (hit) {
                localCache.set(key, hit);
                geoCacheWrite(name, hit, cfg);
                candidateLists[i] = hit;
                out[i] = geoPlaceFromCandidates(name, hit, 'osm');
            } else {
                /* Failures are NOT cached — a transient outage must not poison the cache. */
                out[i] = geoMakePlace(name, null, null, 'osm', { error: 'not-found' });
            }
        }

        geoPreferCluster(out, candidateLists, cfg);
        return out;
    }

    /*
     * geocodeOutliers(places, opts) -> [{ name, displayName, km }]
     * PURE and SYNCHRONOUS. No network, no clock, no storage, no globals — see OUTLIERS
     * in the header for both thresholds and the evidence behind them.
     *
     * A place is named only when it is BOTH a large multiple of the median spread from the
     * median centre AND far in absolute terms. Either test alone has a measured failure
     * mode: the ratio alone fires on any hub-and-spoke trip (median spread ~4 km makes
     * every ratio explode), and the floor alone fires on real continental drives.
     *
     * Zero median spread is not a special case: the tests are written as MULTIPLICATION,
     * so a set of places at identical coordinates yields 0 > 0 (false, nothing flagged)
     * and identical places plus one far one yields km > 0 (true) — both correct, and
     * neither divides.
     */
    function geocodeOutliers(places, opts) {
        const cfg = geoOutlierOptions(opts);
        const list = Array.isArray(places) ? places : [];
        const pts = [];

        for (let i = 0; i < list.length; i++) {
            const p = list[i];
            if (!p || typeof p !== 'object') continue;
            const lat = geoCoordNum(p.lat);
            const lon = geoCoordNum(p.lon);
            if (!geoValidLatLon(lat, lon) || p.resolved === false) continue;
            pts.push({
                name: (p.name === null || p.name === undefined) ? '' : String(p.name),
                displayName: geoDisplayName(p.displayName),
                lat: lat, lon: lon
            });
        }
        if (pts.length < cfg.minPlaces) return [];

        const centre = geoMedianCentre(pts);
        const dist = new Array(pts.length);
        for (let i = 0; i < pts.length; i++) {
            dist[i] = haversineKm(centre.lat, centre.lon, pts[i].lat, pts[i].lon);
        }
        const spread = geoMedian(dist);

        const found = [];
        for (let i = 0; i < pts.length; i++) {
            if (dist[i] > spread * cfg.multiple && dist[i] > cfg.minKm) {
                found.push({ name: pts[i].name, displayName: pts[i].displayName, km: geoRound(dist[i], 1) });
            }
        }
        /* Furthest first; name breaks ties so the order is total and deterministic. */
        found.sort(function (a, b) {
            if (b.km !== a.km) return b.km - a.km;
            return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
        });
        return found;
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

    function geoHaversineCell(straightKm, cfg) {
        const km = straightKm * cfg.roadFactor;
        const min = (km / cfg.speedKmh) * 60;
        return { km: geoRound(km, 2), min: geoRound(min, 1) };
    }

    /*
     * ── Plausibility floor ──
     * A value is road data only if it could physically BE road data. OSRM, a proxy, or a
     * cached error page can hand back numbers that parse perfectly and describe nothing:
     * 617 km in 1 second, or 0 km between Madrid and Barcelona. Those used to ship as
     * clean 'osrm' with zero warnings, and the engine caps days on `min`, so a
     * zero-minute leg silently packs the trip into too few days.
     * Legs under GEO_PLAUSIBLE_MIN_KM are exempt: rounding noise dominates there and a
     * false rejection would replace a good short value with a worse estimate.
     */
    function geoTrivialLeg(cellKm, straightKm) {
        const scale = Math.max(isFinite(cellKm) ? cellKm : 0, isFinite(straightKm) ? straightKm : 0);
        return scale < GEO_PLAUSIBLE_MIN_KM;
    }

    /*
     * The longest credible duration for a road of this length between points this far
     * apart. There is deliberately no floor on average SPEED (see SLOW SIDE in the
     * header); the bound separates the two things average speed conflates — a wait that
     * does not scale with distance, and progress that does.
     * The distance-free term is bounded at BOTH ends:
     *  - a flat 48 h for every leg let a 10 km city hop claim 48 hours and ship LABELLED
     *    AS MEASURED, stripping the slow-side protection from the legs a city itinerary
     *    is made of — hence scaling it by the great-circle separation;
     *  - but scaling alone drove it to nothing across a narrow channel, and a narrow
     *    crossing is still a crossing. Measured live: the Woolwich Ferry over the Thames
     *    is 0.34 km of separation, 2.67 km of road and 16.2 min (cap was 12.2 — dead),
     *    and Oanes–Lauvvik across the Lysefjord is 1.28 km / 12.0 km / 80.4 min (cap was
     *    49.5 — dead). Hence the 2 h floor, which is what a slow short sailing costs.
     */
    function geoMaxDurationMin(roadKm, straightKm) {
        const road = isFinite(roadKm) && roadKm > 0 ? roadKm : 0;
        const crow = isFinite(straightKm) && straightKm > 0 ? straightKm : 0;
        const allowance = Math.min(GEO_STOPPAGE_ALLOWANCE_MIN,
            Math.max(GEO_MIN_CROSSING_ALLOWANCE_MIN, crow * GEO_ALLOWANCE_PER_CROW_MIN));
        return allowance + (road / GEO_MIN_SUSTAINED_KMH) * 60;
    }

    /* The longest road length that could credibly join two points this far apart. */
    function geoMaxRoadKm(straightKm) {
        return (isFinite(straightKm) ? straightKm : 0) * GEO_MAX_DETOUR + GEO_DETOUR_SLACK_KM;
    }

    /*
     * A road cannot be materially shorter than the great circle beneath it, and it cannot
     * wander an order of magnitude further than it either. Either verdict condemns the
     * WHOLE cell, not just the distance, because both halves come out of ONE path
     * computation — if the path is not a road, the duration timed that same non-road:
     *   - too short: measured, asking OSRM for Algeciras -> Ceuta (30 km across the
     *     strait) snapped the Ceuta endpoint 22.5 km away onto the Spanish coast and
     *     answered 12 km / 18 min — a real journey, just not the one requested;
     *   - too long: a x60 detour reported 30 305 km with 202 h beside it, and
     *     30305/202 = 150 km/h, so the duration corroborates the absurd path rather
     *     than contradicting it.
     * Only an ABSENT distance leaves the duration to stand on its own merits.
     */
    function geoDistancePlausible(cellKm, straightKm) {
        if (!isFinite(cellKm) || cellKm < 0) return false;
        if (geoTrivialLeg(cellKm, straightKm)) return true;
        if (cellKm + GEO_SHORTFALL_SLACK < straightKm * GEO_SHORTFALL_RATIO) return false;
        return cellKm <= geoMaxRoadKm(straightKm);
    }

    /*
     * BOTH halves are real, so the pair validates itself: no estimate is involved and
     * the implied speed is the genuine article.
     */
    function geoPairSpeedPlausible(cellKm, cellMin, straightKm) {
        if (!isFinite(cellKm) || !isFinite(cellMin) || cellKm < 0 || cellMin < 0) return false;
        if (geoTrivialLeg(cellKm, straightKm)) return true;
        if (!(cellMin > 0)) return false;                       // distance in zero time
        const kmh = cellKm / (cellMin / 60);
        if (!isFinite(kmh) || kmh > GEO_MAX_SPEED_KMH) return false;
        return cellMin <= geoMaxDurationMin(cellKm, straightKm);
    }

    /*
     * ONLY the duration is real. The distance we would divide by is the haversine
     * ESTIMATE, and an estimate is not a reference for judging a measurement: a leg
     * whose road detour is 12x the great circle (9.3 km apart, 112 km by road) implies a
     * fake 4 km/h and the real 140-minute duration gets destroyed and replaced by 7.8.
     * So the duration is tested only against what geometry actually pins down — the road
     * is at least the great circle and at most geoMaxRoadKm — and is rejected only when
     * NO credible road length makes it drivable.
     * Deliberately permissive towards over-long durations: that error over-splits days,
     * which is the safe direction. Under-stating drive time is the bug class this branch
     * exists to kill.
     */
    function geoDurationPlausible(cellMin, straightKm) {
        if (!isFinite(cellMin) || cellMin < 0) return false;
        if (geoTrivialLeg(0, straightKm)) return true;
        if (!(cellMin > 0)) return false;                       // a real leg in zero time
        const hours = cellMin / 60;
        /* Too fast even along the shortest road that could possibly exist. */
        if (straightKm / hours > GEO_MAX_SPEED_KMH) return false;
        /* Too long even for the longest road that could possibly exist. */
        return cellMin <= geoMaxDurationMin(geoMaxRoadKm(straightKm), straightKm);
    }

    /*
     * How far OSRM had to move a waypoint to put it on a road, in metres. It reports this
     * itself, per waypoint, in sources[k].distance and destinations[k].distance — this
     * module simply never read it, and inferred "the answer is about a different place"
     * from a distance-ratio proxy instead. The proxy fails whenever the wrong place
     * happens to sit at a plausible-looking distance: Melilla is a Spanish exclave in
     * North Africa, OSRM snapped it 155.8 km across the Mediterranean and answered about
     * Almería, and the resulting 556 km against a 574 km great circle cleared the
     * shortfall guard at x0.97.
     * NaN when the field is absent — never condemn on missing evidence.
     */
    function geoSnapMetres(data, k) {
        let worst = NaN;
        const lists = [data.sources, data.destinations];
        for (let l = 0; l < lists.length; l++) {
            const arr = lists[l];
            if (!Array.isArray(arr) || !arr[k] || typeof arr[k] !== 'object') continue;
            const v = arr[k].distance;
            const isNumber = typeof v === 'number';
            const isNumericString = typeof v === 'string' && v.trim() !== '';
            if (!isNumber && !isNumericString) continue;
            const n = Number(v);
            if (!isFinite(n) || n < 0) continue;
            worst = isFinite(worst) ? Math.max(worst, n) : n;
        }
        return worst;
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
            /* Same queue and same spacing as geocoding — see RATE LIMITING in the header. */
            const data = await geoRequest(geoOsrmTableUrl(coords, cfg), cfg);
            if (data && (data.code === undefined || data.code === 'Ok')) {
                const dStatus = geoGridStatus(data.distances, coords.length);
                const tStatus = geoGridStatus(data.durations, coords.length);
                const usable = dStatus !== 'bad' && tStatus !== 'bad' &&
                               (dStatus === 'ok' || tStatus === 'ok');
                if (usable) {
                    /* A waypoint OSRM had to drag a long way to reach a road is not the
                       place we asked about, and EVERY cell touching it is an answer about
                       somewhere else — not just the ones whose distance looks wrong. */
                    const misplaced = new Array(coords.length);
                    for (let k = 0; k < coords.length; k++) {
                        const snap = geoSnapMetres(data, k);
                        misplaced[k] = isFinite(snap) && snap > cfg.maxSnapKm * 1000;
                    }
                    table = {
                        distances: dStatus === 'ok' ? data.distances : null,
                        durations: tStatus === 'ok' ? data.durations : null,
                        misplaced: misplaced
                    };
                }
            }
        }

        /* Position of each place inside the OSRM sub-matrix (-1 = not sent, or sent and
           answered about somewhere else — a misplaced waypoint is treated exactly as if
           it had never been sent, so every one of its cells falls back to geometry). */
        const sub = new Array(n);
        for (let i = 0; i < n; i++) sub[i] = -1;
        for (let k = 0; k < realIdx.length; k++) {
            if (table && table.misplaced && table.misplaced[k]) continue;
            sub[realIdx[k]] = k;
        }

        /* Pairs carrying at least one road-graph value / at least one estimated value.
           A half-real cell is in BOTH — see the MATRIX SOURCE note in the header. */
        let osrmPairs = 0;
        let filledPairs = 0;

        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                let rawKm = NaN;
                let rawMin = NaN;

                if (table && sub[i] >= 0 && sub[j] >= 0) {
                    const a = sub[i], b = sub[j];
                    rawKm = geoSymmetric(
                        geoTableValue(table.distances, a, b, 1000),
                        geoTableValue(table.distances, b, a, 1000)
                    );
                    rawMin = geoSymmetric(
                        geoTableValue(table.durations, a, b, 60),
                        geoTableValue(table.durations, b, a, 60)
                    );
                }

                const straightKm = haversineKm(eff[i].lat, eff[i].lon, eff[j].lat, eff[j].lon);
                const hav = geoHaversineCell(straightKm, cfg);

                /* A distance that is PRESENT but is not a road condemns the duration with
                   it: one path computation produced both. An ABSENT distance does not. */
                const haveRawKm = isFinite(rawKm);
                let realKm = haveRawKm && geoDistancePlausible(rawKm, straightKm);
                let realMin = isFinite(rawMin) && (realKm || !haveRawKm);

                /* Each half is judged against what is actually KNOWN about it, never
                   against the other half's estimate. */
                if (realKm && realMin) {
                    /* Both measured: the pair validates itself. When it fails there is no
                       way to tell which half lied, so both go and the cell is filled
                       exactly like a null. */
                    if (!geoPairSpeedPlausible(rawKm, rawMin, straightKm)) {
                        realKm = false;
                        realMin = false;
                    }
                } else if (realMin) {
                    /* Measured duration, estimated distance — geometry only. */
                    if (!geoDurationPlausible(rawMin, straightKm)) realMin = false;
                }
                /* A measured distance with no duration needs no time check: the duration
                   is derived below at the calibrated speed, so it is in band by
                   construction. */

                let cellKm = realKm ? rawKm : hav.km;
                /* A real road distance is a better base for an estimated time than the
                   great circle is — prefer it whenever the duration is the missing half. */
                let cellMin = realMin ? rawMin
                    : (realKm ? (rawKm / cfg.speedKmh) * 60 : hav.min);

                if (realKm || realMin) osrmPairs++;
                if (!realKm || !realMin) filledPairs++;

                cellKm = geoRound(cellKm, 2);
                cellMin = geoRound(cellMin, 1);
                if (!isFinite(cellKm) || cellKm < 0) cellKm = 0;
                if (!isFinite(cellMin) || cellMin < 0) cellMin = 0;

                km[i][j] = km[j][i] = cellKm;
                min[i][j] = min[j][i] = cellMin;
            }
            km[i][i] = 0;
            min[i][i] = 0;
        }

        /* The flag describes the whole matrix, not one lucky cell — and not one lucky
           annotation either: a distances-only answer is 'mixed', never 'haversine'. */
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
    /*
     * /route reports the SAME snap signal /table does, in waypoints[k].distance, and this
     * path never read it either — so the very waypoint distanceMatrix condemns could still
     * produce a polyline tagged as measured road geometry. Melilla: matrix says
     * 'haversine', geometry said 'osrm' and drew a line starting near Almería.
     * Absent or unusable field -> not evidence; never condemn on missing evidence.
     */
    function geoRouteWaypointsOk(data, cfg) {
        const wps = data.waypoints;
        if (!Array.isArray(wps)) return true;
        for (let k = 0; k < wps.length; k++) {
            const w = wps[k];
            if (!w || typeof w !== 'object') continue;
            const v = w.distance;
            const isNumber = typeof v === 'number';
            const isNumericString = typeof v === 'string' && v.trim() !== '';
            if (!isNumber && !isNumericString) continue;
            const metres = Number(v);
            if (!isFinite(metres) || metres < 0) continue;
            if (metres > cfg.maxSnapKm * 1000) return false;
        }
        return true;
    }

    /*
     * Geometry must describe the journey that was asked for. `points.length >= 2` did not
     * establish that: '????????????????' decodes to eight copies of [0,0] and shipped as
     * measured road geometry — a map line through Null Island. So every point must be a
     * usable coordinate, and the line must begin and end at the places requested.
     * Measured on live /route, the first and last polyline points sit almost exactly the
     * waypoint snap distance from the request (0.09/0.09, 4.44/4.43, 2.48/2.47, and
     * 155.76/156.08 for the mis-snapped one), so maxSnapKm plus a kilometre for polyline
     * rounding is the honest tolerance — anything legitimate has already cleared the
     * snap test above.
     */
    function geoGeometryDescribes(points, coords, cfg) {
        if (!Array.isArray(points) || points.length < 2 || !coords.length) return false;
        for (let i = 0; i < points.length; i++) {
            const p = points[i];
            if (!Array.isArray(p) || !geoValidLatLon(p[0], p[1])) return false;
        }
        const tol = cfg.maxSnapKm + GEO_GEOMETRY_SLACK_KM;
        const first = points[0];
        const last = points[points.length - 1];
        const from = coords[0];
        const to = coords[coords.length - 1];
        if (haversineKm(first[0], first[1], from.lat, from.lon) > tol) return false;
        if (haversineKm(last[0], last[1], to.lat, to.lon) > tol) return false;
        return true;
    }

    function geoOsrmRouteUrl(coords, cfg) {
        const parts = coords.map(function (c) { return c.lon + ',' + c.lat; }).join(';');
        return cfg.osrmBase + '/route/v1/driving/' + parts + '?overview=full&geometries=polyline';
    }

    /*
     * routeGeometry(places, opts) -> Promise<[lat,lon][]>
     * OSRM overview polyline decoded to points. On any failure returns the resolved
     * place coordinates in order, i.e. straight segments between places.
     * The returned array carries a NON-ENUMERABLE `source` marker for the UI — it stays
     * a plain Array for every consumer (deep-equality, JSON.stringify, map libraries).
     *
     * WHAT `source` MEANS — the map may rely on exactly this, and nothing more:
     *   'osrm'     Every point came off the road graph AND the line was verified to
     *              describe the journey requested: no waypoint snapped further than
     *              maxSnapKm, every point a usable coordinate, and the line begins and
     *              ends at the places asked for. Safe to draw as a real driving route.
     *   'straight' NOT road geometry. The points are the resolved place coordinates in
     *              order, so the array is still drawable and still index-aligned to the
     *              resolved places — but it is an ESTIMATE and must be presented as one.
     *              Covers every degraded case together: the request failed, OSRM declined
     *              or returned no route, there were too many places for one call, a
     *              waypoint was answered about somewhere else, or the geometry decoded to
     *              garbage. The distinction between those does not change what the user
     *              must be told, so it is deliberately not exposed.
     *   'none'     No resolved coordinates at all; the array is empty.
     * The guarantee that matters: 'osrm' is never returned for a line this module could
     * not verify. It is the same law the matrix path enforces — an estimate is never
     * presented as measured — and the two paths now agree about the same waypoint.
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

        /* Same queue and same spacing as geocoding — see RATE LIMITING in the header. */
        const data = await geoRequest(geoOsrmRouteUrl(coords, cfg), cfg);
        if (data && (data.code === undefined || data.code === 'Ok') &&
            Array.isArray(data.routes) && data.routes[0] && geoRouteWaypointsOk(data, cfg)) {
            const geom = data.routes[0].geometry;
            let points = null;
            if (typeof geom === 'string') {
                points = decodePolyline(geom, 5);
            } else if (geom && Array.isArray(geom.coordinates)) {
                /* geometries=geojson — [lon,lat] pairs */
                points = [];
                for (let i = 0; i < geom.coordinates.length; i++) {
                    const c = geom.coordinates[i];
                    if (Array.isArray(c) && isFinite(Number(c[0])) && isFinite(Number(c[1]))) {
                        points.push([Number(c[1]), Number(c[0])]);
                    }
                }
            }
            if (geoGeometryDescribes(points, coords, cfg)) {
                return geoTagSource(points, 'osrm');
            }
        }

        return geoTagSource(straight, 'straight');
    }

    /* ── Exports ── only the documented API leaves this scope ── */
    const api = {
        geocodePlaces: geocodePlaces,
        geocodeOutliers: geocodeOutliers,
        distanceMatrix: distanceMatrix,
        routeGeometry: routeGeometry,
        decodePolyline: decodePolyline,
        haversineKm: haversineKm,
        normalisePlaceName: normalisePlaceName,
        clearGeoCache: clearGeoCache,
        resetGeoRateLimit: resetGeoRateLimit,
        GEO_MIN_INTERVAL_MS: GEO_MIN_INTERVAL_MS,
        GEO_ROAD_FACTOR: GEO_ROAD_FACTOR,
        GEO_SPEED_KMH: GEO_SPEED_KMH,
        /* Published so the UI can explain its own thresholds instead of restating them —
           one physical constant living in two files will drift (see the 88 vs 90 note). */
        GEO_GEOCODE_LIMIT: GEO_GEOCODE_LIMIT,
        GEO_OUTLIER_MULTIPLE: GEO_OUTLIER_MULTIPLE,
        GEO_OUTLIER_MIN_KM: GEO_OUTLIER_MIN_KM
    };

    if (typeof window !== 'undefined') {
        /* The rate-limit seam is withheld from the browser surface entirely — it is a
           way to break the OSM usage policy and has no use in the app. It is also inert
           when a `window` exists, so a captured reference cannot resurrect it. */
        const browserApi = {};
        for (const k in api) {
            if (Object.prototype.hasOwnProperty.call(api, k) && k !== 'resetGeoRateLimit') {
                browserApi[k] = api[k];
            }
        }
        window.TravioGeo = browserApi;
        /* Same eight documented functions bound directly, for the UI wiring. */
        window.geocodePlaces      = geocodePlaces;
        window.geocodeOutliers    = geocodeOutliers;
        window.distanceMatrix     = distanceMatrix;
        window.routeGeometry      = routeGeometry;
        window.decodePolyline     = decodePolyline;
        window.haversineKm        = haversineKm;
        window.normalisePlaceName = normalisePlaceName;
        window.clearGeoCache      = clearGeoCache;
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})();
