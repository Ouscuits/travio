/* ── Route Form & Claude API ── */
const CLAUDE_PROXY = 'https://sitoclaude-proxy.sito041971.workers.dev';

let currentRoute = null;
let isGenerating = false;

/* ── Initialization ── */
function initRouteForm() {
    const advBtn = document.getElementById('advancedToggle');
    if (advBtn) advBtn.onclick = toggleAdvancedOptions;

    const genBtn = document.getElementById('generateBtn');
    if (genBtn) genBtn.onclick = generateRoute;

    const clrBtn = document.getElementById('clearBtn');
    if (clrBtn) clrBtn.onclick = clearForm;

    const saveBtn = document.getElementById('saveRouteBtn');
    if (saveBtn) saveBtn.onclick = saveCurrentRoute;

    const durInput = document.getElementById('rfDuration');
    if (durInput) durInput.addEventListener('change', renderBudgetPerDay);

    const customChk = document.getElementById('rfCustomBudget');
    if (customChk) customChk.addEventListener('change', renderBudgetPerDay);
}

/* ── Advanced Options ── */
function toggleAdvancedOptions() {
    const panel = document.getElementById('advancedPanel');
    const icon  = document.getElementById('advancedIcon');
    if (!panel) return;
    const show = panel.style.display === 'none';
    panel.style.display = show ? '' : 'none';
    if (icon) icon.textContent = show ? '\u25B2' : '\u25BC';
}

/* ── Budget per day ── */
function renderBudgetPerDay() {
    const container = document.getElementById('budgetPerDayContainer');
    const chk = document.getElementById('rfCustomBudget');
    if (!container || !chk) return;
    if (!chk.checked) { container.innerHTML = ''; return; }

    const days = parseInt(document.getElementById('rfDuration').value) || 3;
    const base = parseInt(document.getElementById('rfDailyBudget').value) || 100;
    let html = '';
    for (let i = 1; i <= days; i++) {
        html += `<div class="budget-day-row">
            <span>${t('form.day')} ${i}:</span>
            <input type="number" id="rfBudgetDay${i}" value="${base}" min="10" step="10" class="budget-day-input">
            <span>EUR</span>
        </div>`;
    }
    container.innerHTML = html;
}

/* ── Validation ── */
function validateForm() {
    const s = document.getElementById('rfStartPoint').value.trim();
    const e = document.getElementById('rfEndPoint').value.trim();
    const d = document.getElementById('rfDestinations').value.trim();
    const dur = parseInt(document.getElementById('rfDuration').value);
    const bud = parseInt(document.getElementById('rfDailyBudget').value);
    return s && e && d && dur > 0 && bud > 0;
}

/* ── Collect form data ── */
function collectFormData() {
    return {
        startPoint:      document.getElementById('rfStartPoint').value.trim(),
        endPoint:        document.getElementById('rfEndPoint').value.trim(),
        destinations:    document.getElementById('rfDestinations').value.trim(),
        tripType:        document.getElementById('rfTripType').value,
        duration:        parseInt(document.getElementById('rfDuration').value) || 3,
        dailyBudget:     parseInt(document.getElementById('rfDailyBudget').value) || 100,
        tollPreference:  document.getElementById('rfTolls') ? document.getElementById('rfTolls').value : 'with-tolls',
        departureTime:   document.getElementById('rfDepartureTime') ? document.getElementById('rfDepartureTime').value : '09:00',
        language:        currentLang
    };
}

/* ── Build prompt for Claude ── */
function buildPrompt(fd) {
    const langName = { es: 'Spanish', en: 'English', ca: 'Catalan', fr: 'French', zh: 'Simplified Chinese' }[fd.language] || 'English';
    const tripLabel = t('tripTypeLabel.' + fd.tripType) || fd.tripType;
    const tollText  = fd.tollPreference === 'with-tolls'
        ? 'Use toll highways (faster)'
        : 'Avoid tolls (more economical/scenic)';

    const suggestions = {
        familiar: '   - Family-friendly restaurants\n   - Parks and attractions for children\n   - Hotels with family facilities',
        pareja:   '   - Romantic restaurants\n   - Viewpoints and special places\n   - Boutique or charming hotels',
        aventura: '   - Hiking trails\n   - Outdoor activities\n   - Camping or budget hostels',
        moto:     '   - Scenic roads and mountain passes\n   - Technical stops for motorcycles\n   - Biker-friendly hostels\n   - Routes with interesting curves'
    };

    return `You are an expert travel planner. I need you to help me plan an optimized route with the following details.

IMPORTANT: Please respond entirely in ${langName}.

**TRAVEL INFORMATION:**
- Starting point: ${fd.startPoint}
- End point: ${fd.endPoint}
- Destinations to visit: ${fd.destinations}
- Trip type: ${tripLabel}
- Duration: ${fd.duration} days
- Daily budget: EUR${fd.dailyBudget}
- Toll preference: ${tollText}
- Departure time: ${fd.departureTime}

**WHAT I NEED:**

1. **OPTIMIZED ROUTE**: Order the destinations logically to minimize distance and time. Consider toll preference.

2. **DETAILED DAILY ITINERARY**: For each day of the trip, provide:
   - Destinations to visit that day
   - Approximate distance in km
   - Estimated driving time
   - Estimated arrival time at each point
   - If there are tolls, mention them and estimate the approximate cost

3. **COST BREAKDOWN**: For each day, estimate:
   - Fuel (assume average consumption of 7L/100km and EUR1.50/liter)
   - Tolls (if applicable)
   - Suggested accommodation within budget
   - Meals (breakfast, lunch, dinner)
   - Total for the day vs available budget
   - ALERT if budget is exceeded

4. **PERSONALIZED SUGGESTIONS** according to trip type:
${suggestions[fd.tripType] || suggestions.familiar}

5. **INTERMEDIATE STOPS**: Suggest beautiful towns or rest areas along the way.

6. **FINAL SUMMARY**:
   - Total kilometers
   - Total driving time
   - Estimated total trip cost
   - Comparison with total available budget

Please structure the response clearly and professionally.`;
}

/* ── Generate route via Claude API ── */
async function generateRoute() {
    if (!validateForm()) {
        showFormMsg(t('form.required'), 'err');
        return;
    }
    if (isGenerating) return;
    isGenerating = true;

    const genBtn = document.getElementById('generateBtn');
    genBtn.disabled = true;
    genBtn.textContent = t('form.generating');
    showLoadingState();

    const fd = collectFormData();

    try {
        const resp = await fetch(CLAUDE_PROXY, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 4096,
                messages: [{ role: 'user', content: buildPrompt(fd) }]
            })
        });

        if (!resp.ok) throw new Error('Error ' + resp.status);

        const data = await resp.json();
        let result = '';
        if (data.content) {
            for (const block of data.content) {
                if (block.type === 'text') result += block.text + '\n';
            }
        }
        if (!result) throw new Error('Empty response');

        currentRoute = { formData: fd, result: result, language: currentLang };
        displayRoute(currentRoute);

    } catch (e) {
        console.error('Route generation error:', e);
        showRouteError(t('result.error') + ': ' + e.message);
    } finally {
        isGenerating = false;
        genBtn.disabled = false;
        genBtn.textContent = t('form.generate');
        hideLoadingState();
    }
}

/* ── Display route result ── */
function displayRoute(route) {
    const empty   = document.getElementById('resultEmpty');
    const loading = document.getElementById('resultLoading');
    const content = document.getElementById('resultContent');
    const saveBtn = document.getElementById('saveRouteBtn');

    if (empty)   empty.style.display = 'none';
    if (loading) loading.style.display = 'none';
    if (content) {
        content.style.display = '';
        // Route header
        document.getElementById('resultHeader').innerHTML =
            `<strong>${t('result.route')}:</strong> ${escapeHtml(route.formData.startPoint)} &rarr; ${escapeHtml(route.formData.endPoint)}` +
            `<br><span class="result-meta">${route.formData.duration} ${t('result.days')} &bull; ${escapeHtml(t('form.' + route.formData.tripType) || route.formData.tripType)} &bull; ${t('result.budget')}: EUR${route.formData.dailyBudget}/${t('result.days')}</span>`;
        // Route body — preserve whitespace for formatted AI response
        document.getElementById('resultBody').textContent = route.result;
    }
    if (saveBtn) saveBtn.style.display = '';
}

function showLoadingState() {
    const empty   = document.getElementById('resultEmpty');
    const loading = document.getElementById('resultLoading');
    const content = document.getElementById('resultContent');
    if (empty)   empty.style.display = 'none';
    if (content) content.style.display = 'none';
    if (loading) loading.style.display = '';
}

function hideLoadingState() {
    const loading = document.getElementById('resultLoading');
    if (loading) loading.style.display = 'none';
}

function showRouteError(msg) {
    const content = document.getElementById('resultContent');
    const empty   = document.getElementById('resultEmpty');
    if (content) content.style.display = 'none';
    if (empty)   empty.style.display = 'none';
    const loading = document.getElementById('resultLoading');
    if (loading) loading.style.display = 'none';

    const errDiv = document.getElementById('resultError');
    if (errDiv) {
        errDiv.style.display = '';
        errDiv.textContent = msg;
        setTimeout(() => { errDiv.style.display = 'none'; }, 8000);
    }
}

function showFormMsg(msg, type) {
    const el = document.getElementById('formMsg');
    if (!el) return;
    el.textContent = msg;
    el.className = 'form-msg ' + type;
    el.style.display = '';
    setTimeout(() => { el.style.display = 'none'; }, 4000);
}

/* ── Save route to Firestore ── */
async function saveCurrentRoute() {
    if (!currentRoute || !currentUser) return;
    const btn = document.getElementById('saveRouteBtn');
    btn.disabled = true;
    try {
        await fsSaveRoute({
            startPoint:     currentRoute.formData.startPoint,
            endPoint:       currentRoute.formData.endPoint,
            destinations:   currentRoute.formData.destinations,
            tripType:       currentRoute.formData.tripType,
            duration:       currentRoute.formData.duration,
            dailyBudget:    currentRoute.formData.dailyBudget,
            tollPreference: currentRoute.formData.tollPreference,
            departureTime:  currentRoute.formData.departureTime,
            result:         currentRoute.result,
            language:       currentRoute.language
        });
        showFormMsg(t('result.routeSaved'), 'ok');
    } catch (e) {
        console.error('Save error:', e);
        showFormMsg(t('common.error'), 'err');
    } finally {
        btn.disabled = false;
    }
}

/* ── Clear form ── */
function clearForm() {
    document.getElementById('rfStartPoint').value = '';
    document.getElementById('rfEndPoint').value = '';
    document.getElementById('rfDestinations').value = '';
    document.getElementById('rfTripType').value = 'familiar';
    document.getElementById('rfDuration').value = '3';
    document.getElementById('rfDailyBudget').value = '100';
    const tolls = document.getElementById('rfTolls');
    if (tolls) tolls.value = 'with-tolls';
    const time = document.getElementById('rfDepartureTime');
    if (time) time.value = '09:00';
    const chk = document.getElementById('rfCustomBudget');
    if (chk) { chk.checked = false; renderBudgetPerDay(); }

    currentRoute = null;
    document.getElementById('resultEmpty').style.display = '';
    document.getElementById('resultContent').style.display = 'none';
    document.getElementById('resultLoading').style.display = 'none';
    const saveBtn = document.getElementById('saveRouteBtn');
    if (saveBtn) saveBtn.style.display = 'none';
    const errDiv = document.getElementById('resultError');
    if (errDiv) errDiv.style.display = 'none';
}

/* ── Load saved routes list ── */
async function loadSavedRoutesList() {
    if (!currentUser) return;
    const container = document.getElementById('savedRoutesList');
    if (!container) return;

    try {
        const routes = await fsGetUserRoutes(currentUser.uid);
        if (routes.length === 0) {
            container.innerHTML = `<p class="empty-text" data-i18n="routes.noRoutes">${t('routes.noRoutes')}</p>`;
            return;
        }
        container.innerHTML = routes.map(r => {
            const date = r.createdAt && r.createdAt.toDate ? r.createdAt.toDate().toLocaleDateString() : '';
            return `<div class="route-card">
                <div class="route-card-info">
                    <strong>${escapeHtml(r.startPoint)} &rarr; ${escapeHtml(r.endPoint)}</strong>
                    <span class="route-card-meta">${r.duration} ${t('result.days')} &bull; ${date}</span>
                </div>
                <div class="route-card-actions">
                    <button class="btn btn-sm btn-outline" onclick="viewSavedRoute('${r.id}')">${t('routes.load')}</button>
                    <button class="btn btn-sm btn-ghost" onclick="deleteSavedRoute('${r.id}')">${t('routes.delete')}</button>
                </div>
            </div>`;
        }).join('');
    } catch (e) {
        console.error('Load routes error:', e);
        container.innerHTML = '<p class="empty-text">Error</p>';
    }
}

async function viewSavedRoute(routeId) {
    try {
        const doc = await db.collection('routes').doc(routeId).get();
        if (!doc.exists) return;
        const r = doc.data();
        currentRoute = { formData: r, result: r.result, language: r.language };

        // Fill form
        document.getElementById('rfStartPoint').value   = r.startPoint || '';
        document.getElementById('rfEndPoint').value     = r.endPoint || '';
        document.getElementById('rfDestinations').value = r.destinations || '';
        document.getElementById('rfTripType').value     = r.tripType || 'familiar';
        document.getElementById('rfDuration').value     = r.duration || 3;
        document.getElementById('rfDailyBudget').value  = r.dailyBudget || 100;

        displayRoute(currentRoute);
        showView('userHomeView');
        applyTranslations();
    } catch (e) {
        console.error('View route error:', e);
    }
}

async function deleteSavedRoute(routeId) {
    if (!confirm(t('routes.confirmDelete'))) return;
    try {
        await fsDeleteRoute(routeId);
        await loadSavedRoutesList();
    } catch (e) {
        console.error('Delete route error:', e);
    }
}
