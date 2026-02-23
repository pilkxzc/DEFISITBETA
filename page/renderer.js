/**
 * DEFIS Browser — Renderer (browser chrome logic)
 */

// ── App loading overlay ───────────────────────────────────────────
const _appLoading   = document.getElementById('app-loading');
const _alStatus     = document.getElementById('al-status');
let   _appLoadingDone = false;

function setLoadingStatus(text) {
    if (_alStatus) _alStatus.textContent = text;
}

function hideLoadingScreen() {
    if (_appLoadingDone || !_appLoading) return;
    _appLoadingDone = true;
    _appLoading.classList.add('fade-out');
    setTimeout(() => { _appLoading.classList.add('hidden'); }, 420);
}

// Safety fallback: hide after 8 s regardless
setTimeout(hideLoadingScreen, 8000);

// ── Clock ────────────────────────────────────────────────────────
const clockEl = document.getElementById('clock-display');
function updateClock() {
    if (!clockEl) return;
    clockEl.textContent = new Date().toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
}
updateClock();
setInterval(updateClock, 60000);

// ── Toast ────────────────────────────────────────────────────────
const toastContainer = document.getElementById('toast-container');
function showToast(msg, type = 'info', duration = 4000) {
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.textContent = msg;
    toastContainer.appendChild(t);
    setTimeout(() => {
        t.style.opacity = '0'; t.style.transition = 'opacity .4s';
        setTimeout(() => t.remove(), 400);
    }, duration);
}

// ── Overlay helpers ───────────────────────────────────────────────
// BrowserViews always render above BrowserWindow HTML → modals & menus
// appear UNDER the web page. Fix: ref-counted hide/restore via IPC.
const activeOverlays = new Set();

function overlayOpened(name) {
    const wasEmpty = activeOverlays.size === 0;
    activeOverlays.add(name);
    if (wasEmpty) window.api.overlayOpen();
}

function overlayClosed(name) {
    if (!activeOverlays.has(name)) return;
    activeOverlays.delete(name);
    if (activeOverlays.size === 0) window.api.overlayClose();
}

// ── Tab state ────────────────────────────────────────────────────
const tabsState  = new Map();
let   activeTabId = null;

const tabsContainer = document.getElementById('tabs-container');
const addressBar    = document.getElementById('address-bar');
const btnBack       = document.getElementById('btn-back');
const btnForward    = document.getElementById('btn-forward');
const btnReload     = document.getElementById('btn-reload');
const newtabArea    = document.getElementById('newtab-area');

// ── Tab drag: reorder + detach ────────────────────────────────────
// • Drag within tab bar → reorder tabs (shows blue insertion line)
// • Drag outside window → detach into a new window
// BrowserView intercepts mouse events outside the chrome area, so we
// call overlayOpened() when drag starts to hide it for the duration.
let _drag = null;      // { tabId, startX, startY, active }
let _dragGhost = null;
const _titlebar = document.getElementById('chrome-titlebar');

// ── Reorder tabsState Map (display order) ─────────────────────────
function _reorderTabs(tabId, beforeId) {
    const entries = [...tabsState.entries()];
    const fromIdx = entries.findIndex(([k]) => k === tabId);
    if (fromIdx < 0) return;
    const [item] = entries.splice(fromIdx, 1);
    if (beforeId == null) {
        entries.push(item);
    } else {
        const toIdx = entries.findIndex(([k]) => k === beforeId);
        entries.splice(toIdx < 0 ? entries.length : toIdx, 0, item);
    }
    tabsState.clear();
    entries.forEach(([k, v]) => tabsState.set(k, v));
}

// ── Drop indicator: vertical blue line between tabs ───────────────
function _showDropLine(cursorX, excludeId) {
    _hideDropLine();
    const els = [...tabsContainer.querySelectorAll('.tab')]
        .filter(el => parseInt(el.dataset.tabId, 10) !== excludeId);
    let insertX = null;
    for (const el of els) {
        const r = el.getBoundingClientRect();
        if (cursorX < r.left + r.width / 2) { insertX = r.left; break; }
    }
    if (insertX === null && els.length) {
        insertX = els[els.length - 1].getBoundingClientRect().right;
    }
    if (insertX === null) return;
    const tbRect = tabsContainer.getBoundingClientRect();
    const line = document.createElement('div');
    line.id = '__tab_drop_line';
    line.style.cssText =
        `position:fixed;z-index:99998;pointer-events:none;width:3px;border-radius:2px;` +
        `background:#89b4fa;box-shadow:0 0 8px rgba(137,180,250,.7);` +
        `left:${Math.round(insertX) - 1}px;top:${tbRect.top + 3}px;height:${tbRect.height - 6}px;`;
    document.body.appendChild(line);
}
function _hideDropLine() {
    document.getElementById('__tab_drop_line')?.remove();
}

// ── Which tab slot does cursorX fall before? ──────────────────────
function _dropBeforeId(cursorX, excludeId) {
    const els = [...tabsContainer.querySelectorAll('.tab')]
        .filter(el => parseInt(el.dataset.tabId, 10) !== excludeId);
    for (const el of els) {
        const r = el.getBoundingClientRect();
        if (cursorX < r.left + r.width / 2) return parseInt(el.dataset.tabId, 10);
    }
    return null;  // append to end
}

// ── Geometry helpers ──────────────────────────────────────────────
function _inTabBar(cx, cy) {
    const r = _titlebar.getBoundingClientRect();
    return cy >= r.top && cy <= r.bottom && cx >= r.left && cx <= r.right;
}
function _outsideWindow(cx, cy) {
    return cx < 0 || cx > window.innerWidth || cy < 0 || cy > window.innerHeight;
}

function _cancelDrag() {
    if (!_drag) return;
    if (_drag.active) { overlayClosed('tabDrag'); document.body.style.userSelect = ''; }
    _hideDropLine();
    if (_dragGhost) { _dragGhost.remove(); _dragGhost = null; }
    _drag = null;
}

// ── Mouse events ──────────────────────────────────────────────────
document.addEventListener('pointermove', e => {
    if (!_drag) return;
    const dx = e.clientX - _drag.startX, dy = e.clientY - _drag.startY;

    // Activate drag after 6px movement
    if (!_drag.active && Math.sqrt(dx * dx + dy * dy) > 6) {
        _drag.active = true;
        overlayOpened('tabDrag');   // hide BrowserView so mouse tracks everywhere
        document.body.style.userSelect = 'none';

        const tab = tabsState.get(_drag.tabId);
        _dragGhost = document.createElement('div');
        _dragGhost.style.cssText =
            'position:fixed;z-index:999999;pointer-events:none;background:#1e1e2e;' +
            'border:2px solid #9d7cce;border-radius:8px;padding:5px 14px 5px 10px;' +
            'font-size:13px;color:#cdd6f4;display:flex;align-items:center;gap:8px;' +
            'box-shadow:0 6px 28px rgba(0,0,0,.7);white-space:nowrap;max-width:240px;' +
            'opacity:.93;transition:border-color .1s,box-shadow .1s;';
        const fav = tab?.favicon
            ? `<img src="${tab.favicon}" width="13" height="13" style="flex-shrink:0" onerror="this.style.display='none'">`
            : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/></svg>`;
        _dragGhost.innerHTML = fav +
            `<span style="overflow:hidden;text-overflow:ellipsis;">${tab?.title || 'Вкладка'}</span>`;
        document.body.appendChild(_dragGhost);
    }
    if (!_drag.active) return;

    // Move ghost
    _dragGhost.style.left = (e.clientX + 14) + 'px';
    _dragGhost.style.top  = (e.clientY  +  8) + 'px';

    if (_outsideWindow(e.clientX, e.clientY)) {
        // Will detach → blue glow, hide reorder line
        _dragGhost.style.borderColor = '#89b4fa';
        _dragGhost.style.boxShadow   = '0 6px 28px rgba(137,180,250,.5)';
        _hideDropLine();
    } else if (_inTabBar(e.clientX, e.clientY)) {
        // Will reorder → show drop line
        _dragGhost.style.borderColor = '#9d7cce';
        _dragGhost.style.boxShadow   = '0 6px 28px rgba(0,0,0,.7)';
        _showDropLine(e.clientX, _drag.tabId);
    } else {
        // Neutral zone (below tab bar, inside window)
        _dragGhost.style.borderColor = '#555';
        _dragGhost.style.boxShadow   = '0 6px 28px rgba(0,0,0,.5)';
        _hideDropLine();
    }
});

document.addEventListener('pointerup', e => {
    if (!_drag) return;
    const { tabId, active } = _drag;
    _drag = null;
    _hideDropLine();
    if (!active) return;
    overlayClosed('tabDrag');
    document.body.style.userSelect = '';
    if (_dragGhost) { _dragGhost.remove(); _dragGhost = null; }

    if (_outsideWindow(e.clientX, e.clientY)) {
        // ── Detach into new window ────────────────────────────────
        const tab = tabsState.get(tabId);
        const url = tab?.url && !tab.url.startsWith('about:') ? tab.url : null;
        window.api.openExtraWindow({ url });
        if (tabsState.size > 1) window.api.closeTab(tabId);
    } else if (_inTabBar(e.clientX, e.clientY)) {
        // ── Reorder within tab bar ────────────────────────────────
        const beforeId = _dropBeforeId(e.clientX, tabId);
        if (beforeId !== tabId) {
            _reorderTabs(tabId, beforeId);
            renderTabs();
        }
    }
    // else: dropped inside window but not in tab bar → no action
});

document.addEventListener('keydown', e => { if (e.key === 'Escape' && _drag?.active) _cancelDrag(); });
window.addEventListener('blur', () => { if (_drag?.active) _cancelDrag(); });

function renderTabs() {
    tabsContainer.innerHTML = '';
    tabsState.forEach((tab, tabId) => {
        const el = document.createElement('div');
        el.className = 'tab' + (tabId === activeTabId ? ' active' : '');
        el.dataset.tabId = tabId;

        let faviconHtml;
        if (tab.favicon) {
            faviconHtml = `<span class="tab-favicon"><img src="${tab.favicon}" alt="" onerror="this.style.display='none'"></span>`;
        } else if (tab.loading) {
            faviconHtml = `<span class="tab-favicon" style="color:#9d7cce">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <path d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20" stroke-linecap="round">
                        <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur=".8s" repeatCount="indefinite"/>
                    </path>
                </svg>
            </span>`;
        } else {
            faviconHtml = `<span class="tab-favicon">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20" stroke-linecap="round"/>
                </svg>
            </span>`;
        }

        el.innerHTML = `
            ${faviconHtml}
            <span class="tab-title">${tab.title || 'Нова вкладка'}</span>
            <button class="tab-close" data-close="${tabId}" title="Закрити">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <path stroke-linecap="round" d="M6 18L18 6M6 6l12 12"/>
                </svg>
            </button>`;

        el.addEventListener('pointerdown', e => {
            if (e.button !== 0 || e.target.closest('[data-close]')) return;
            el.setPointerCapture(e.pointerId);  // keep events even outside window
            _drag = { tabId, startX: e.clientX, startY: e.clientY, active: false };
        });
        el.addEventListener('click', e => {
            if (e.target.closest('[data-close]')) return;
            window.api.switchTab(tabId);
        });
        el.addEventListener('contextmenu', e => {
            e.preventDefault();
            e.stopPropagation();
            showTabCtx(tabId, e.clientX, e.clientY);
        });
        el.querySelector('[data-close]').addEventListener('click', e => {
            e.stopPropagation();
            window.api.closeTab(tabId);
        });
        tabsContainer.appendChild(el);
    });
}

function setAddressBar(url) {
    if (document.activeElement !== addressBar)
        addressBar.value = (url && !url.startsWith('about:')) ? url : '';
}

function setNavBtns(canBack, canForward) {
    btnBack.disabled    = !canBack;
    btnForward.disabled = !canForward;
}

function setReloadBtn(loading) {
    const icon = document.getElementById('reload-icon');
    if (loading) {
        icon.innerHTML = `<path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>`;
        btnReload.title = 'Зупинити';
    } else {
        icon.innerHTML = `<path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>`;
        btnReload.title = 'Оновити (Ctrl+R)';
    }
}

function showNewtab(show) {
    newtabArea.style.display = show ? 'flex' : 'none';
}

// ── Closed tab history (for Ctrl+Shift+T) ────────────────────────
const closedTabsHistory = [];   // [{url, title}], max 20

// ── Tab navigation helpers ────────────────────────────────────────
function getTabIds()           { return [...tabsState.keys()]; }
function switchToNextTab()     { const ids = getTabIds(); if (ids.length < 2) return; const i = ids.indexOf(activeTabId); window.api.switchTab(ids[(i + 1) % ids.length]); }
function switchToPrevTab()     { const ids = getTabIds(); if (ids.length < 2) return; const i = ids.indexOf(activeTabId); window.api.switchTab(ids[(i - 1 + ids.length) % ids.length]); }
function switchToTabByIndex(n) { const ids = getTabIds(); if (!ids.length) return; window.api.switchTab(ids[Math.min(n, ids.length - 1)]); }

// ── IPC events FROM main ─────────────────────────────────────────
window.api.onTabCreated(({ tabId, title, url }) => {
    tabsState.set(tabId, { title: title || 'Нова вкладка', url: url || '', favicon: null, loading: false, canGoBack: false, canGoForward: false });
    renderTabs();
    // New tab with no URL = new-tab page; won't emit did-stop-loading → hide immediately
    if (!url || url === '' || url.startsWith('about:')) setTimeout(hideLoadingScreen, 150);
});

window.api.onTabClosed(({ tabId }) => {
    const tab = tabsState.get(tabId);
    if (tab?.url && !tab.url.startsWith('about:')) {
        closedTabsHistory.push({ url: tab.url, title: tab.title });
        if (closedTabsHistory.length > 20) closedTabsHistory.shift();
    }
    tabsState.delete(tabId);
    renderTabs();
});

window.api.onTabUpdate(({ tabId, title, url, favicon, loading, canGoBack, canGoForward }) => {
    const tab = tabsState.get(tabId);
    if (!tab) return;
    if (title     !== undefined) tab.title     = title;
    if (url       !== undefined) tab.url       = url;
    if (favicon   !== undefined) tab.favicon   = favicon;
    if (loading   !== undefined) tab.loading   = loading;
    if (canGoBack    !== undefined) tab.canGoBack    = canGoBack;
    if (canGoForward !== undefined) tab.canGoForward = canGoForward;
    renderTabs();

    // Hide loading screen once the first tab finishes loading
    if (loading === false && tabId === activeTabId) hideLoadingScreen();

    if (tabId === activeTabId) {
        if (url !== undefined) {
            setAddressBar(url);
            // Hide newtab area as soon as a real URL is loaded in the active tab
            showNewtab(!url || url === '' || url.startsWith('about:'));
        }
        if (loading   !== undefined) setReloadBtn(loading);
        if (canGoBack !== undefined || canGoForward !== undefined)
            setNavBtns(tab.canGoBack, tab.canGoForward);
    }
});

window.api.onActiveTabChanged(({ tabId, url, canGoBack, canGoForward }) => {
    activeTabId = tabId;
    const tab = tabsState.get(tabId);
    if (tab) { tab.canGoBack = canGoBack; tab.canGoForward = canGoForward; tab.url = url; }
    renderTabs();
    setAddressBar(url);
    setNavBtns(canGoBack, canGoForward);
    showNewtab(!url || url === '' || url.startsWith('about:'));
});

// ── Profile label + proxy status on startup ───────────────────────
const profileLabel = document.getElementById('profile-label');
let currentProfile = null;
let allProfilesCache = [];

// Load profiles cache on startup and keep updated
window.api.getProfiles().then(p => { allProfilesCache = p; }).catch(() => {});
window.api.onProfilesChanged(profs => { allProfilesCache = profs; });

function switchToAdjacentProfile(dir) {
    if (allProfilesCache.length <= 1) { showToast('Немає інших акаунтів', 'info', 1500); return; }
    const idx = allProfilesCache.findIndex(p => currentProfile && p.id === currentProfile.id);
    const nextIdx = ((idx === -1 ? 0 : idx) + dir + allProfilesCache.length) % allProfilesCache.length;
    const next = allProfilesCache[nextIdx];
    if (next && next.id !== currentProfile?.id) {
        showToast(`→ ${next.name}`, 'info', 1200);
        window.api.openProfile(next.id);
    }
}

// Prev/next profile arrows in title bar
const profCyclePrev = document.getElementById('prof-cycle-prev');
const profCycleNext = document.getElementById('prof-cycle-next');
if (profCyclePrev) profCyclePrev.addEventListener('click', () => switchToAdjacentProfile(-1));
if (profCycleNext) profCycleNext.addEventListener('click', () => switchToAdjacentProfile(+1));

window.api.onSetProfile(async profile => {
    currentProfile = profile;
    if (profileLabel) profileLabel.textContent = profile.name || '';
    setLoadingStatus(`Профіль: ${profile.name || profile.id}…`);

    if (profile.proxy?.enabled) {
        showToast(`Проксі: ${profile.proxy.host}:${profile.proxy.port} — перевірка…`, 'info', 2500);
        const res = await window.api.checkProxy(profile.id);
        if (res.ok) {
            showToast(`✓ Проксі OK — IP: ${res.ip}`, 'success');
        } else {
            showToast(`✗ Проксі помилка: ${res.error}`, 'error', 6000);
        }
    } else {
        showToast(`Профіль: ${profile.name} — пряме підключення`, 'info', 2000);
    }

    // Load extension list for the toolbar button
    loadProfileExtensions();
});

// ── Extensions toolbar button ─────────────────────────────────────
const extBtnWrap = document.getElementById('ext-btn-wrap');
const extBtn     = document.getElementById('ext-btn');
const extMenu    = document.createElement('div');
extMenu.className   = 'dropdown-menu';
extMenu.style.minWidth = '280px';
extMenu.style.right = '0';
extBtnWrap.appendChild(extMenu);

let profileExtensions = [];

async function loadProfileExtensions() {
    if (!currentProfile) { extBtnWrap.style.display = 'none'; return; }
    try {
        profileExtensions = await window.api.extGetForProfile(currentProfile.id);
    } catch {
        profileExtensions = [];
    }
    extBtnWrap.style.display = profileExtensions.length > 0 ? '' : 'none';
    extBtn.classList.toggle('active', profileExtensions.length > 0);
}

function buildExtMenu() {
    extMenu.innerHTML = '<div class="menu-section-title">Розширення</div>';

    if (!profileExtensions.length) {
        extMenu.innerHTML += '<div style="padding:12px 10px;font-size:12px;color:#555;text-align:center">Немає активних розширень</div>';
        return;
    }

    const PUZZLE_SVG = `<svg class="ext-row-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:#666">
        <path stroke-linecap="round" stroke-linejoin="round" d="M9 3v1.5a1.5 1.5 0 003 0V3h6v4h1.5a1.5 1.5 0 010 3H18v5h-1.5a1.5 1.5 0 000 3H18v3h-6v-1.5a1.5 1.5 0 00-3 0V21H3v-6h1.5a1.5 1.5 0 000-3H3V6h6V3z"/>
    </svg>`;

    profileExtensions.forEach(ext => {
        const row = document.createElement('div');
        row.className = 'menu-item';
        row.style.gap = '10px';

        const iconHtml = ext.icon
            ? `<img class="ext-row-icon" src="${ext.icon}" alt="" onerror="this.replaceWith(document.createRange().createContextualFragment('${PUZZLE_SVG.replace(/'/g, "\\'")}'))">`
            : PUZZLE_SVG;

        const loadDot = ext.loaded
            ? `<span title="Активне" style="width:7px;height:7px;border-radius:50%;background:#28c840;flex-shrink:0"></span>`
            : `<span title="Не завантажено — перезапустіть профіль" style="width:7px;height:7px;border-radius:50%;background:#555;flex-shrink:0"></span>`;

        row.innerHTML = `
            ${iconHtml}
            <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px">${ext.name}</span>
            ${loadDot}`;

        row.addEventListener('click', async () => {
            closeAllMenus();
            const res = await window.api.extOpenPopup({ profileId: currentProfile.id, extensionId: ext.id });
            if (!res?.ok) {
                if (res?.error === 'Extension not loaded in session')
                    showToast('Перезапустіть профіль — розширення ще не завантажено', 'info', 4000);
                else if (res?.error === 'no_background')
                    showToast('Розширення не підтримується (немає фонової сторінки)', 'info', 4000);
                else if (res?.error === 'no_listener')
                    showToast('Розширення не реагує на клік (немає обробника)', 'info', 4000);
                else
                    showToast(`Помилка: ${res?.error || 'невідома'}`, 'error');
            }
        });

        extMenu.appendChild(row);
    });
}

extBtn.addEventListener('click', e => {
    e.stopPropagation();
    buildExtMenu();
    toggleMenu(extMenu);
});

window.api.onProfilesChanged(async () => {
    if (!profileModal.classList.contains('hidden')) {
        try { allProfiles = await window.api.getProfiles(); } catch {}
        renderProfilesList();
    }
});

// ── Downloads ────────────────────────────────────────────────────
const downloadBar = document.getElementById('download-bar');
const dlFilename  = document.getElementById('dl-filename');
const dlProgress  = document.getElementById('dl-progress');
const dlClose     = document.getElementById('dl-close');
let   dlHideTimer = null;

dlClose.addEventListener('click', () => downloadBar.classList.remove('visible'));

window.api.onDownloadStarted(({ filename }) => {
    dlFilename.textContent = filename;
    dlProgress.textContent = 'Завантаження…';
    downloadBar.classList.add('visible');
    clearTimeout(dlHideTimer);
});
window.api.onDownloadProgress(({ filename, progress }) => {
    dlFilename.textContent = filename;
    dlProgress.textContent = progress >= 0 ? `${progress}%` : '…';
});
window.api.onDownloadDone(({ filename, state }) => {
    dlFilename.textContent = filename;
    if (state === 'completed') {
        dlProgress.textContent = 'Готово ✓';
        showToast(`Завантажено: ${filename}`, 'success');
    } else {
        dlProgress.textContent = 'Помилка';
        showToast(`Помилка завантаження: ${filename}`, 'error');
    }
    dlHideTimer = setTimeout(() => downloadBar.classList.remove('visible'), 4000);
});

// ── Address bar ──────────────────────────────────────────────────
addressBar.addEventListener('keydown', e => {
    if (e.key === 'Enter') { const v = addressBar.value.trim(); if (v) window.api.navigate(v); addressBar.blur(); }
    if (e.key === 'Escape') addressBar.blur();
});
addressBar.addEventListener('focus', () => addressBar.select());

// ── Navigation buttons ───────────────────────────────────────────
btnBack.addEventListener('click',    () => window.api.goBack());
btnForward.addEventListener('click', () => window.api.goForward());
btnReload.addEventListener('click',  () => window.api.reload());
document.getElementById('new-tab-btn').addEventListener('click', () => window.api.newTab());

// ── Window controls ──────────────────────────────────────────────
document.getElementById('btn-minimize').addEventListener('click', () => window.api.winMinimize());
document.getElementById('btn-maximize').addEventListener('click', () => window.api.winMaximize());
document.getElementById('btn-close').addEventListener('click',    () => window.api.winClose());

// ── Newtab search ────────────────────────────────────────────────
const newtabSearch = document.getElementById('newtab-search');
newtabSearch.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
        const v = newtabSearch.value.trim();
        if (v) { window.api.navigate(v); newtabSearch.value = ''; }
    }
});

// ── Dropdown menus ───────────────────────────────────────────────
let openMenu = null;
const _pageSsBg = document.getElementById('page-sc-bg');

function _showPageScreenshot(dataUrl) {
    if (!dataUrl) return;
    _pageSsBg.style.backgroundImage = `url(${dataUrl})`;
    _pageSsBg.style.display = 'block';
}
function _hidePageScreenshot() {
    _pageSsBg.style.display = 'none';
    _pageSsBg.style.backgroundImage = '';
}

function closeAllMenus(skipOverlayClose = false) {
    const wasOpen = openMenu !== null;
    document.querySelectorAll('.dropdown-menu.open').forEach(m => m.classList.remove('open'));
    openMenu = null;
    if (wasOpen && !skipOverlayClose) {
        _hidePageScreenshot();
        overlayClosed('menu');
    }
}

async function toggleMenu(menuEl) {
    if (openMenu === menuEl) { closeAllMenus(); return; }
    const alreadyOpen = openMenu !== null;
    // Close notepad/agent panels so they don't overlap with menu
    window._panels?.notepad?.close();
    window._panels?.agent?.close();
    closeAllMenus(true); // close visually but don't call overlayClose yet
    menuEl.classList.add('open');
    openMenu = menuEl;
    if (!alreadyOpen) {
        // Capture page screenshot for transparent background effect
        const dataUrl = await window.api.captureActivePage().catch(() => null);
        _showPageScreenshot(dataUrl);
        overlayOpened('menu');
    }
}

document.addEventListener('click', e => {
    if (!e.target.closest('.btn-wrap') && !e.target.closest('.dropdown-menu')) closeAllMenus();
});

// ── Settings menu ────────────────────────────────────────────────
const settingsBtn  = document.getElementById('settingsBtn');
const settingsMenu = document.createElement('div');
settingsMenu.className = 'dropdown-menu';
settingsMenu.innerHTML = `
    <div class="menu-section-title">Пошукова система</div>
    <div class="menu-item active-engine" data-engine="google">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>Google
    </div>
    <div class="menu-item" data-engine="duckduckgo">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>DuckDuckGo
    </div>
    <div class="menu-item" data-engine="bing">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>Bing
    </div>
    <div class="menu-divider"></div>
    <div class="menu-section-title">Браузер</div>
    <div class="menu-item" id="settings-restart-profile">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
        Перезапустити профіль
    </div>
    <div class="menu-item" id="settings-new-window">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/></svg>
        Нове вікно (цей профіль)
    </div>
    <div class="menu-item" id="settings-clear-cache">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
        Очистити кеш та cookies
    </div>
    <div class="menu-item" id="settings-full">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
        Повні налаштування
    </div>
    <div class="menu-divider"></div>
    <div class="menu-section-title">Розробка</div>
    <div class="menu-item" id="settings-devmode" style="justify-content:space-between">
        <span style="display:flex;align-items:center;gap:8px">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"/></svg>
            Dev Mode
        </span>
        <span id="devmode-badge" style="font-size:10px;padding:2px 6px;border-radius:3px;background:#2a2a2a;color:#555;font-weight:600;letter-spacing:.05em">ВИКЛ</span>
    </div>`;
settingsBtn.parentElement.appendChild(settingsMenu);
settingsBtn.addEventListener('click', e => { e.stopPropagation(); toggleMenu(settingsMenu); });

let currentEngine = 'google';
settingsMenu.querySelectorAll('[data-engine]').forEach(item => {
    item.addEventListener('click', () => {
        currentEngine = item.dataset.engine;
        settingsMenu.querySelectorAll('[data-engine]').forEach(i => i.classList.remove('active-engine'));
        item.classList.add('active-engine');
        window.api.setSearchEngine(currentEngine);
        closeAllMenus();
    });
});

document.getElementById('settings-clear-cache').addEventListener('click', async () => {
    closeAllMenus();
    try { await window.api.clearCache(); showToast('Кеш та cookies очищено', 'success'); }
    catch { showToast('Помилка очищення', 'error'); }
});

document.getElementById('settings-full').addEventListener('click', () => {
    closeAllMenus();
    window.api.openSettings(currentProfile?.id);
});

document.getElementById('settings-devmode').addEventListener('click', async () => {
    closeAllMenus();
    const res = await window.api.toggleDevMode().catch(() => null);
    const badge = document.getElementById('devmode-badge');
    if (res?.devMode) {
        if (badge) { badge.textContent = 'ВКЛ'; badge.style.background = 'rgba(40,200,64,.15)'; badge.style.color = '#28c840'; }
        showToast('Dev Mode увімкнено — DevTools відкриті', 'info');
    } else {
        if (badge) { badge.textContent = 'ВИКЛ'; badge.style.background = '#2a2a2a'; badge.style.color = '#555'; }
        showToast('Dev Mode вимкнено', 'info');
    }
});

// Init dev mode badge from config
window.api.getConfig().then(cfg => {
    const badge = document.getElementById('devmode-badge');
    if (badge && cfg?.devMode) {
        badge.textContent = 'ВКЛ';
        badge.style.background = 'rgba(40,200,64,.15)';
        badge.style.color = '#28c840';
    }
}).catch(() => {});

document.getElementById('settings-restart-profile').addEventListener('click', async () => {
    closeAllMenus();
    showToast('Перезапуск профілю…', 'info', 2500);
    const res = await window.api.restartProfile().catch(() => null);
    if (res?.ok) showToast('Профіль перезапущено ✓', 'success');
    else         showToast('Помилка перезапуску', 'error');
});

document.getElementById('settings-new-window').addEventListener('click', () => {
    closeAllMenus();
    window.api.openExtraWindow({});
});

window.api.onProfileRestarted(() => {
    loadProfileExtensions();
});

// Extension requests to open a new tab (chrome.tabs.create / chrome.windows.create)
window.api.onExtOpenNewTab(({ url, active }) => {
    window.api.newTab(url || 'about:blank');
});

// ── Chrome Web Store install banner ──────────────────────────────
(function initCwsBanner() {
    const banner     = document.getElementById('cws-banner');
    const nameEl     = document.getElementById('cws-ext-name');
    const installBtn = document.getElementById('cws-install-btn');
    const closeBtn   = document.getElementById('cws-banner-close');

    let currentExtId = null;

    function showBanner(extId, name) {
        currentExtId = extId;
        nameEl.textContent = name || extId;
        // Check if already installed
        const alreadyInstalled = currentProfile?.plugins?.extensions?.some(e => e.id === extId);
        installBtn.disabled    = alreadyInstalled;
        installBtn.textContent = alreadyInstalled ? '✓ Встановлено' : 'Встановити';
        installBtn.style.background = alreadyInstalled ? '#2a8a3e' : '';
        banner.classList.add('visible');
    }

    function hideBanner() {
        banner.classList.remove('visible');
        currentExtId = null;
    }

    installBtn.addEventListener('click', async () => {
        if (!currentExtId || !currentProfile) return;
        installBtn.disabled    = true;
        installBtn.textContent = '⏳ Завантаження…';

        const res = await window.api.extInstall({ profileId: currentProfile.id, extensionId: currentExtId });
        if (res?.ok) {
            installBtn.textContent     = '✓ Встановлено';
            installBtn.style.background = '#2a8a3e';
            showToast(`✓ Встановлено: ${res.name}`, 'success', 5000);
            // Update local profile cache
            if (currentProfile) {
                if (!currentProfile.plugins) currentProfile.plugins = {};
                if (!currentProfile.plugins.extensions) currentProfile.plugins.extensions = [];
                if (!currentProfile.plugins.extensions.find(e => e.id === currentExtId))
                    currentProfile.plugins.extensions.push({ id: currentExtId, name: res.name, enabled: true });
            }
            loadProfileExtensions();
        } else {
            installBtn.disabled    = false;
            installBtn.textContent = 'Встановити';
            showToast(`✗ Помилка: ${res?.error || 'невідома'}`, 'error', 6000);
        }
    });

    closeBtn.addEventListener('click', hideBanner);

    // Hide when clicking active-tab's address changes away from CWS
    window.api.onCwsExtDetected(data => {
        if (data?.extId) {
            showBanner(data.extId, data.name);
        } else {
            hideBanner();
        }
    });

    // Refresh "already installed" state after install
    window.api.onExtInstalled(({ id, name }) => {
        if (currentExtId === id) {
            installBtn.disabled    = true;
            installBtn.textContent = '✓ Встановлено';
            installBtn.style.background = '#2a8a3e';
        }
        loadProfileExtensions();
    });
})();

// ── Bookmarks menu ───────────────────────────────────────────────
const bookmarksBtn  = document.getElementById('bookmarksBtn');
const bookmarksMenu = document.createElement('div');
bookmarksMenu.className = 'dropdown-menu';
bookmarksMenu.style.minWidth = '280px';
bookmarksBtn.parentElement.appendChild(bookmarksMenu);

let _bookmarks = [];

async function loadBookmarks() {
    try { _bookmarks = await window.api.bookmarksGet() || []; } catch { _bookmarks = []; }
}
loadBookmarks();

function buildBookmarksMenu() {
    bookmarksMenu.innerHTML = `
        <div class="menu-section-title" style="display:flex;justify-content:space-between;align-items:center;padding-right:10px">
            <span>Закладки</span>
            <span id="bm-add-btn" style="font-size:11px;color:#666;cursor:pointer;text-transform:none;letter-spacing:0;padding:2px 6px;border-radius:4px" title="Ctrl+D">+ Додати</span>
        </div>`;
    if (!_bookmarks.length) {
        bookmarksMenu.innerHTML += '<div style="padding:14px 10px;font-size:12px;color:#555;text-align:center">Порожньо<br><span style="font-size:11px;color:#444">Натисніть Ctrl+D</span></div>';
    } else {
        [..._bookmarks].reverse().forEach(bm => {
            const item = document.createElement('div');
            item.className = 'bookmark-item';
            const letter = (bm.title || bm.url).charAt(0).toUpperCase();
            let hash = 0;
            for (const c of bm.url) hash = (hash * 31 + c.charCodeAt(0)) | 0;
            const color = '#' + Math.abs(hash).toString(16).padStart(6, '0').slice(0, 6);
            item.innerHTML = `
                <div class="bookmark-favicon" style="background:${color};font-size:11px">${letter}</div>
                <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${bm.title || bm.url}</span>
                <button data-bm-id="${bm.id}" style="background:transparent;border:none;color:#555;cursor:pointer;padding:2px 7px;border-radius:4px;font-size:16px;flex-shrink:0;line-height:1" title="Видалити">×</button>`;
            item.addEventListener('click', e => {
                if (e.target.dataset.bmId) return;
                window.api.navigate(bm.url); closeAllMenus();
            });
            bookmarksMenu.appendChild(item);
        });
    }
    bookmarksMenu.querySelector('#bm-add-btn')?.addEventListener('click', e => {
        e.stopPropagation(); addBookmark();
    });
    bookmarksMenu.querySelectorAll('[data-bm-id]').forEach(btn => {
        btn.addEventListener('click', async e => {
            e.stopPropagation();
            await window.api.bookmarksRemove({ id: btn.dataset.bmId }).catch(() => {});
            await loadBookmarks(); buildBookmarksMenu();
        });
    });
}

async function addBookmark() {
    const tab = tabsState.get(activeTabId);
    if (!tab?.url || tab.url.startsWith('about:')) { showToast('Немає сторінки для збереження', 'info'); return; }
    await window.api.bookmarksAdd({ url: tab.url, title: tab.title || tab.url }).catch(() => {});
    await loadBookmarks();
    showToast('Закладку збережено ✓', 'success');
    if (openMenu === bookmarksMenu) buildBookmarksMenu();
}

bookmarksBtn.addEventListener('click', e => { e.stopPropagation(); buildBookmarksMenu(); toggleMenu(bookmarksMenu); });

// ── History menu ─────────────────────────────────────────────────
const historyBtn  = document.getElementById('historyBtn');
const historyMenu = document.createElement('div');
historyMenu.className = 'dropdown-menu';
historyMenu.style.minWidth = '320px';
historyMenu.innerHTML = `
    <div class="menu-section-title" style="display:flex;justify-content:space-between;align-items:center;padding-right:10px">
        <span>Історія</span>
        <span id="history-clear-btn" style="font-size:11px;color:#666;cursor:pointer;text-transform:none;letter-spacing:0">Очистити</span>
    </div>
    <div id="history-list"></div>`;
historyBtn.parentElement.appendChild(historyMenu);

async function loadHistory() {
    const list = document.getElementById('history-list');
    list.innerHTML = '';
    try {
        const items = await window.api.getHistory();
        if (!items?.length) { list.innerHTML = '<div style="padding:12px 10px;font-size:12px;color:#555;text-align:center">Порожньо</div>'; return; }
        items.slice(0, 30).forEach(item => {
            const el   = document.createElement('div');
            el.className = 'menu-item';
            const time = new Date(item.timestamp).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
            const ttl  = (item.title || item.url).slice(0, 50);
            el.innerHTML = `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${ttl}</span>
                <span style="font-size:10px;color:#555;flex-shrink:0">${time}</span>`;
            el.addEventListener('click', () => { window.api.navigate(item.url); closeAllMenus(); });
            list.appendChild(el);
        });
    } catch { list.innerHTML = '<div style="padding:12px 10px;font-size:12px;color:#555;text-align:center">Помилка</div>'; }
}
historyBtn.addEventListener('click', e => { e.stopPropagation(); loadHistory(); toggleMenu(historyMenu); });
historyMenu.querySelector('#history-clear-btn').addEventListener('click', e => {
    e.stopPropagation();
    window.api.clearHistory();
    document.getElementById('history-list').innerHTML = '<div style="padding:12px 10px;font-size:12px;color:#555;text-align:center">Очищено</div>';
    showToast('Історію очищено', 'info');
});

// ── Claude.ai quick access button ─────────────────────────────────
const claudeBtn = document.getElementById('claudeBtn');
if (claudeBtn) claudeBtn.addEventListener('click', () => window.api.navigate('https://claude.ai'));

// ── Profile manager modal ─────────────────────────────────────────
const profileBtn        = document.getElementById('profileBtn');
const profileModal      = document.getElementById('profile-modal');
const profilesList      = document.getElementById('profiles-list');
const profileModalClose = document.getElementById('profile-modal-close');
const profileModalBg    = document.getElementById('profile-modal-backdrop');
const addProfileBtn     = document.getElementById('add-profile-btn');
const profileSearch     = document.getElementById('profile-search');
const profPrevBtn       = document.getElementById('prof-prev');
const profNextBtn       = document.getElementById('prof-next');
const profPageInfo      = document.getElementById('prof-page-info');

const PROFILE_PAGE_SIZE = 20;
let profilePage   = 0;
let profileFilter = '';
let allProfiles   = [];

let profileSelectedIdx = -1; // keyboard-selected index in current page

async function openProfileModal() {
    profileModal.classList.remove('hidden');
    overlayOpened('profileModal');
    try { allProfiles = await window.api.getProfiles(); } catch { allProfiles = []; }
    profilePage   = 0;
    profileFilter = '';
    profileSelectedIdx = -1;
    profileSearch.value = '';
    renderProfilesList();

    // Show admin tab + quick import button only for admin role
    if (window.api.getCurrentUser) {
        try {
            const me = await window.api.getCurrentUser();
            const isAdmin = me?.role === 'admin';
            const adminTab = document.getElementById('pm-tab-admin');
            if (adminTab) adminTab.style.display = isAdmin ? '' : 'none';
            const quickBtn = document.getElementById('adsp-quick-import-btn');
            if (quickBtn) quickBtn.style.display = isAdmin ? '' : 'none';
        } catch {}
    }
    // Auto-focus search so user can type immediately
    setTimeout(() => profileSearch.focus(), 60);
}
function closeProfileModal() {
    profileModal.classList.add('hidden');
    overlayClosed('profileModal');
    profileSelectedIdx = -1;
}

// ── PM tab switching ─────────────────────────────────────────────
let _pmProxyFilter = false;
window._pmToggleProxyFilter = function(btn) {
    _pmProxyFilter = !_pmProxyFilter;
    btn.style.background   = _pmProxyFilter ? 'rgba(157,124,206,0.15)' : '#1a1a1a';
    btn.style.borderColor  = _pmProxyFilter ? 'rgba(157,124,206,0.4)' : '#333';
    btn.style.color        = _pmProxyFilter ? '#9d7cce' : '#666';
    profilePage = 0;
    renderProfilesList();
};

document.querySelectorAll('.pm-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.pm-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const which = tab.dataset.pmTab;
        document.getElementById('pm-pane-profiles').style.display = which === 'profiles' ? '' : 'none';
        const adminPane = document.getElementById('pm-pane-admin');
        if (adminPane) {
            adminPane.style.display = which === 'admin' ? '' : 'none';
            if (which === 'admin') initAdminPanel();
        }
    });
});

// ── Admin sub-tabs ───────────────────────────────────────────────
document.querySelectorAll('.adm-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.adm-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const which = tab.dataset.admTab;
        document.getElementById('adm-pane-users').style.display    = which === 'users'    ? '' : 'none';
        document.getElementById('adm-pane-adspower').style.display = which === 'adspower' ? '' : 'none';
        document.getElementById('adm-pane-logs').style.display     = which === 'logs'     ? '' : 'none';
        if (which === 'users')    loadAdminUsers();
        if (which === 'adspower') initAdspPanel();
        if (which === 'logs')     loadAdminLogs();
    });
});

let _adminPanelInited = false;
async function initAdminPanel() {
    if (_adminPanelInited) return;
    _adminPanelInited = true;
    loadAdminUsers();
}

// ── Admin: Users ─────────────────────────────────────────────────
async function loadAdminUsers() {
    const wrap = document.getElementById('adm-users-list');
    if (!wrap) return;
    wrap.innerHTML = '<div style="color:#555;font-size:12px;padding:16px 0;text-align:center">Завантаження…</div>';
    try {
        const users = await window.api.adminGetUsers();
        if (!users || !users.length) {
            wrap.innerHTML = '<div style="color:#555;font-size:12px;padding:16px 0;text-align:center">Немає користувачів</div>';
            return;
        }
        let html = '<table class="user-table"><thead><tr><th>Email</th><th>Ім\'я</th><th>Роль</th><th>Профілів</th><th></th></tr></thead><tbody>';
        users.forEach(u => {
            const roleCls = u.role === 'admin' ? 'role-admin' : u.role === 'manager' ? 'role-manager' : 'role-user';
            html += `<tr>
                <td title="${u.email}">${u.email}</td>
                <td>${u.name || '—'}</td>
                <td><span class="role-badge ${roleCls}">${u.role}</span></td>
                <td>${(u.profileIds || []).length}</td>
                <td style="white-space:nowrap;display:flex;gap:4px">
                    <button class="card-btn" data-assign-user="${u.id}" title="Призначити профілі">📋</button>
                    <button class="card-btn" style="color:#e07070;border-color:rgba(232,17,35,0.3)" data-del-user="${u.id}" title="Видалити">✕</button>
                </td>
            </tr>`;
        });
        html += '</tbody></table>';
        wrap.innerHTML = html;

        // Bind assign buttons
        wrap.querySelectorAll('[data-assign-user]').forEach(btn => {
            const uid = parseInt(btn.dataset.assignUser);
            const user = users.find(u => u.id === uid);
            btn.addEventListener('click', () => openAssignModal(user));
        });
        // Bind delete buttons
        wrap.querySelectorAll('[data-del-user]').forEach(btn => {
            const uid = parseInt(btn.dataset.delUser);
            btn.addEventListener('click', async () => {
                if (!confirm('Видалити користувача?')) return;
                const ok = await window.api.adminDeleteUser(uid).catch(() => false);
                if (ok) { showToast('Користувача видалено', 'success'); loadAdminUsers(); }
                else      showToast('Помилка видалення', 'error');
            });
        });
    } catch {
        wrap.innerHTML = '<div style="color:#e07070;font-size:12px;padding:16px 0;text-align:center">Помилка завантаження</div>';
    }
}

const admCreateBtn = document.getElementById('adm-create-user-btn');
if (admCreateBtn) {
    admCreateBtn.addEventListener('click', async () => {
        const email = document.getElementById('adm-new-email')?.value.trim();
        const pass  = document.getElementById('adm-new-pass')?.value;
        const name  = document.getElementById('adm-new-name')?.value.trim();
        const role  = document.getElementById('adm-new-role')?.value;
        if (!email || !pass) { showToast('Введіть email та пароль', 'error'); return; }
        admCreateBtn.disabled = true;
        const res = await window.api.adminCreateUser({ email, password: pass, name, role }).catch(() => ({ ok: false }));
        admCreateBtn.disabled = false;
        if (res?.ok || res?.id) {
            showToast('Користувача створено', 'success');
            document.getElementById('adm-new-email').value = '';
            document.getElementById('adm-new-pass').value  = '';
            document.getElementById('adm-new-name').value  = '';
            loadAdminUsers();
        } else {
            showToast(res?.error || 'Помилка створення', 'error');
        }
    });
}

// ── Admin: Assign profiles modal ─────────────────────────────────
const assignModal     = document.getElementById('assign-modal');
const assignModalBg   = document.getElementById('assign-modal-backdrop');
const assignCancelBtn = document.getElementById('assign-cancel-btn');
const assignSaveBtn   = document.getElementById('assign-save-btn');
let _assignUserId = null;

function openAssignModal(user) {
    _assignUserId = user.id;
    document.getElementById('assign-user-email').textContent = user.email;
    const listEl = document.getElementById('assign-profiles-list');
    listEl.innerHTML = '';
    const assigned = new Set(user.profileIds || []);
    allProfiles.forEach(p => {
        const item = document.createElement('label');
        item.className = 'assign-profile-item';
        item.innerHTML = `
            <input type="checkbox" value="${p.id}" ${assigned.has(p.id) ? 'checked' : ''}>
            <div class="profile-avatar" style="background:${p.color||'#9d7cce'};width:28px;height:28px;font-size:11px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;flex-shrink:0">
                ${(p.name||'?').slice(0,2).toUpperCase()}
            </div>
            <span style="font-size:13px;color:#C0C0C0">${p.name}</span>`;
        listEl.appendChild(item);
    });
    assignModal.classList.remove('hidden');
    overlayOpened('assignModal');
}

if (assignModalBg)   assignModalBg.addEventListener('click',   () => { assignModal.classList.add('hidden'); overlayClosed('assignModal'); });
if (assignCancelBtn) assignCancelBtn.addEventListener('click', () => { assignModal.classList.add('hidden'); overlayClosed('assignModal'); });
if (assignSaveBtn) {
    assignSaveBtn.addEventListener('click', async () => {
        const checked = [...document.querySelectorAll('#assign-profiles-list input:checked')].map(i => i.value);
        const ok = await window.api.adminAssignProfiles({ userId: _assignUserId, profileIds: checked }).catch(() => false);
        if (ok) {
            showToast('Профілі призначено', 'success');
            assignModal.classList.add('hidden');
            overlayClosed('assignModal');
            loadAdminUsers();
        } else {
            showToast('Помилка збереження', 'error');
        }
    });
}

// ── Admin: Logs ──────────────────────────────────────────────────
async function loadAdminLogs() {
    const wrap = document.getElementById('adm-logs-list');
    if (!wrap) return;
    wrap.innerHTML = '<div style="color:#555;font-size:12px;padding:16px 0;text-align:center">Завантаження…</div>';
    try {
        const logs = await window.api.adminGetLogs();
        if (!logs || !logs.length) { wrap.innerHTML = '<div style="color:#555;font-size:12px;padding:16px 0;text-align:center">Немає логів</div>'; return; }
        const html = logs.map(l => {
            const d = new Date(l.timestamp * 1000);
            const ts = d.toLocaleDateString('uk') + ' ' + d.toLocaleTimeString('uk', { hour:'2-digit', minute:'2-digit' });
            return `<div style="display:flex;gap:10px;padding:5px 8px;border-bottom:1px solid rgba(255,255,255,0.04);align-items:baseline">
                <span style="color:#444;flex-shrink:0">${ts}</span>
                <span style="color:#9d7cce;flex-shrink:0">${l.action}</span>
                <span style="color:#666;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${l.detail || ''}</span>
            </div>`;
        }).join('');
        wrap.innerHTML = html;
        wrap.scrollTop = wrap.scrollHeight;
    } catch {
        wrap.innerHTML = '<div style="color:#e07070;font-size:12px;padding:16px 0;text-align:center">Помилка завантаження</div>';
    }
}

// ── Admin: AdsPower ──────────────────────────────────────────────
let _adspProfiles = [];

function initAdspPanel() {
    // auto-test on first open
    const dot = document.getElementById('adsp-dot');
    if (dot && !dot.classList.contains('ok') && !dot.classList.contains('err')) {
        testAdspConnection();
    }
}

async function testAdspConnection() {
    const dot     = document.getElementById('adsp-dot');
    const text    = document.getElementById('adsp-status-text');
    const sub     = document.getElementById('adsp-status-sub');
    const loadBtn = document.getElementById('adsp-load-btn');
    if (!dot) return;

    dot.className = 'adsp-dot';
    text.textContent = 'AdsPower API: перевірка…';

    const res = await window.api.adspTest().catch(() => ({ ok: false, error: 'IPC error' }));
    if (res?.ok) {
        dot.className = 'adsp-dot ok';
        text.textContent = 'AdsPower API: Підключено';
        sub.textContent  = `Профілів: ${res.total ?? '?'}`;
        if (loadBtn) loadBtn.disabled = false;
    } else {
        dot.className = 'adsp-dot err';
        text.textContent = 'AdsPower API: Недоступно';
        sub.textContent  = res?.error || 'Переконайтесь що AdsPower запущено';
        if (loadBtn) loadBtn.disabled = true;
    }
}

const adspTestBtn = document.getElementById('adsp-test-btn');
if (adspTestBtn) adspTestBtn.addEventListener('click', testAdspConnection);

const adspLoadBtn = document.getElementById('adsp-load-btn');
if (adspLoadBtn) {
    adspLoadBtn.addEventListener('click', async () => {
        adspLoadBtn.disabled = true;
        adspLoadBtn.textContent = 'Завантаження…';
        try {
            const res = await window.api.adspProfiles();
            _adspProfiles = res?.profiles || [];
            renderAdspProfileTable();
            document.getElementById('adsp-profile-wrap').style.display = _adspProfiles.length ? '' : 'none';
            if (!_adspProfiles.length) showToast('Профілів не знайдено', 'info');
        } catch {
            showToast('Помилка отримання профілів', 'error');
        }
        adspLoadBtn.disabled = false;
        adspLoadBtn.textContent = 'Завантажити профілі';
    });
}

function renderAdspProfileTable() {
    const wrap = document.getElementById('adsp-profiles-table');
    if (!wrap) return;
    const sel = new Set([...wrap.querySelectorAll('input[type=checkbox]:checked')].map(i => i.value));

    let html = `<table class="adsp-profile-table">
        <thead><tr><th style="width:28px"></th><th style="width:36px;color:#555">#</th><th>Назва</th><th>Група</th><th>Proxy</th><th>Cookies</th></tr></thead><tbody>`;
    _adspProfiles.forEach(p => {
        const displayName = p.name || p.serial || p.id || '—';
        const sub = p.remark ? `<div style="font-size:10px;color:#555;margin-top:1px">${p.remark}</div>` : '';
        html += `<tr>
            <td><input type="checkbox" value="${p.id}" ${sel.has(p.id)?'checked':''} style="accent-color:#9d7cce;cursor:pointer"></td>
            <td style="color:#555;font-size:11px">${p.serial||'—'}</td>
            <td title="${p.id}">${displayName}${sub}</td>
            <td style="color:#666">${p.group||'—'}</td>
            <td>${p.proxy_type !== 'none' ? `<span style="color:#28c840">${p.proxy_type}</span>` : '<span style="color:#444">—</span>'}</td>
            <td>${p.has_cookies ? '<span style="color:#28c840">✓</span>' : '<span style="color:#444">—</span>'}</td>
        </tr>`;
    });
    html += '</tbody></table>';
    wrap.innerHTML = html;

    updateAdspSelectedCount();
    wrap.querySelectorAll('input[type=checkbox]').forEach(cb => {
        cb.addEventListener('change', updateAdspSelectedCount);
    });
}

function updateAdspSelectedCount() {
    const checked = document.querySelectorAll('#adsp-profiles-table input[type=checkbox]:checked');
    const countEl = document.getElementById('adsp-selected-count');
    const importBtn = document.getElementById('adsp-import-btn');
    if (countEl)   countEl.textContent = `Обрано: ${checked.length} / ${_adspProfiles.length}`;
    if (importBtn) importBtn.disabled  = checked.length === 0;
}

const adspSelectAll = document.getElementById('adsp-select-all');
if (adspSelectAll) {
    adspSelectAll.addEventListener('change', () => {
        document.querySelectorAll('#adsp-profiles-table input[type=checkbox]').forEach(cb => {
            cb.checked = adspSelectAll.checked;
        });
        updateAdspSelectedCount();
    });
}

const adspImportBtn = document.getElementById('adsp-import-btn');
if (adspImportBtn) {
    adspImportBtn.addEventListener('click', async () => {
        const ids = [...document.querySelectorAll('#adsp-profiles-table input[type=checkbox]:checked')].map(i => i.value);
        if (!ids.length) { showToast('Оберіть профілі для імпорту', 'info'); return; }

        const importCookies = document.getElementById('adsp-import-cookies')?.checked !== false;

        // Show progress modal
        const progressModal = document.getElementById('import-progress-modal');
        const fillEl  = document.getElementById('import-fill');
        const statusEl = document.getElementById('import-status-text');
        const logEl   = document.getElementById('import-log');
        const footerEl = document.getElementById('import-footer');
        progressModal.classList.remove('hidden');
        fillEl.style.width  = '0%';
        logEl.innerHTML     = '';
        footerEl.style.display = 'none';
        statusEl.textContent = `Імпортування ${ids.length} профілів…`;

        function addLogLine(text, type = '') {
            const line = document.createElement('div');
            line.className = `import-log-line ${type}`;
            line.textContent = text;
            logEl.appendChild(line);
            logEl.scrollTop = logEl.scrollHeight;
        }

        addLogLine(`⏳ Запуск імпорту ${ids.length} профілів…`, 'info');
        if (importCookies) addLogLine('🍪 Cookies будуть імпортовані (якщо доступні)', 'info');

        try {
            const res = await window.api.adspImport({ profileIds: ids, importCookies });
            fillEl.style.width = '100%';

            if (res?.ok) {
                statusEl.textContent = `Готово!`;
                addLogLine(`✅ Імпортовано профілів: ${res.imported}`, 'ok');
                if (res.cookies_imported) addLogLine(`🍪 Cookies: ${res.cookies_imported} шт.`, 'ok');
                if (res.skipped)          addLogLine(`⏩ Пропущено: ${res.skipped}`, '');
                (res.errors || []).forEach(e => addLogLine(`✗ ${e.name}: ${e.error}`, 'err'));

                // Refresh profiles list
                try { allProfiles = await window.api.getProfiles(); } catch {}
                showToast(`Імпортовано ${res.imported} профілів`, 'success');
            } else {
                statusEl.textContent = 'Помилка';
                addLogLine(`✗ Помилка: ${res?.error || 'Unknown'}`, 'err');
            }
        } catch (e) {
            statusEl.textContent = 'Помилка';
            addLogLine(`✗ ${e.message}`, 'err');
        }

        footerEl.style.display = '';
    });
}

const importDoneBtn = document.getElementById('import-done-btn');
if (importDoneBtn) {
    importDoneBtn.addEventListener('click', () => {
        document.getElementById('import-progress-modal').classList.add('hidden');
    });
}

// ── 1-click AdsPower import ───────────────────────────────────────
async function adspOneClickImport() {
    const progressModal = document.getElementById('import-progress-modal');
    const fillEl   = document.getElementById('import-fill');
    const statusEl = document.getElementById('import-status-text');
    const logEl    = document.getElementById('import-log');
    const footerEl = document.getElementById('import-footer');
    if (!progressModal) return;

    progressModal.classList.remove('hidden');
    fillEl.style.width     = '0%';
    logEl.innerHTML        = '';
    footerEl.style.display = 'none';
    statusEl.textContent   = 'Підключення до AdsPower…';

    function log(text, type = '') {
        const line = document.createElement('div');
        line.className = `import-log-line ${type}`;
        line.textContent = text;
        logEl.appendChild(line);
        logEl.scrollTop = logEl.scrollHeight;
    }

    log('⏳ Перевірка AdsPower API…', 'info');

    // Step 1 — test connection
    const testRes = await window.api.adspTest().catch(() => ({ ok: false, error: 'IPC error' }));
    if (!testRes?.ok) {
        fillEl.style.width   = '100%';
        statusEl.textContent = 'Помилка підключення';
        log(`✗ AdsPower недоступний: ${testRes?.error || 'localhost:50325 не відповідає'}`, 'err');
        log('Переконайтесь що AdsPower запущений і спробуйте знову.', '');
        footerEl.style.display = '';
        return;
    }
    log(`✅ AdsPower підключено. Профілів: ${testRes.total ?? '?'}`, 'ok');
    fillEl.style.width   = '20%';
    statusEl.textContent = 'Отримання списку профілів…';

    // Step 2 — import all with cookies
    log('⏳ Імпорт усіх профілів з cookies…', 'info');
    fillEl.style.width   = '40%';
    statusEl.textContent = 'Імпортування…';

    try {
        const res = await window.api.adspImport({ importCookies: true });
        fillEl.style.width = '100%';

        if (res?.ok) {
            statusEl.textContent = 'Готово!';
            log(`✅ Імпортовано профілів: ${res.imported}`, 'ok');
            if (res.cookies_imported) log(`🍪 Cookies: ${res.cookies_imported} шт.`, 'ok');
            if (res.skipped)          log(`⏩ Пропущено: ${res.skipped}`, '');
            (res.errors || []).forEach(e => log(`✗ ${e.name}: ${e.error}`, 'err'));

            try { allProfiles = await window.api.getProfiles(); } catch {}
            renderProfilesList();
            showToast(`Імпортовано ${res.imported} профілів`, 'success');
        } else {
            statusEl.textContent = 'Помилка';
            log(`✗ ${res?.error || 'Невідома помилка'}`, 'err');
        }
    } catch (e) {
        statusEl.textContent = 'Помилка';
        log(`✗ ${e.message}`, 'err');
    }

    footerEl.style.display = '';
}

const adspQuickBtn = document.getElementById('adsp-quick-import-btn');
if (adspQuickBtn) adspQuickBtn.addEventListener('click', adspOneClickImport);

profileSearch.addEventListener('input', () => {
    profileFilter = profileSearch.value;
    profilePage   = 0;
    profileSelectedIdx = -1;
    renderProfilesList();
});

// Keyboard navigation inside profile modal search
profileSearch.addEventListener('keydown', e => {
    const cards = profilesList.querySelectorAll('.profile-card');
    if (!cards.length) return;
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        profileSelectedIdx = Math.min(profileSelectedIdx + 1, cards.length - 1);
        updateProfileCardSelection(cards);
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        profileSelectedIdx = Math.max(profileSelectedIdx - 1, 0);
        updateProfileCardSelection(cards);
    } else if (e.key === 'Enter') {
        e.preventDefault();
        const idx = profileSelectedIdx >= 0 ? profileSelectedIdx : 0;
        const card = cards[idx];
        if (card) {
            const openBtn = card.querySelector('[data-open]');
            if (openBtn) openBtn.click();
            else closeProfileModal(); // already current profile
        }
    }
});

function updateProfileCardSelection(cards) {
    cards.forEach((c, i) => {
        c.style.outline = i === profileSelectedIdx ? '2px solid #9d7cce' : '';
        c.style.background = i === profileSelectedIdx ? '#2a2a2a' : '';
        if (i === profileSelectedIdx) c.scrollIntoView({ block: 'nearest' });
    });
}

profPrevBtn.addEventListener('click', () => { profilePage--; profileSelectedIdx = -1; renderProfilesList(); });
profNextBtn.addEventListener('click', () => { profilePage++; profileSelectedIdx = -1; renderProfilesList(); });

profileBtn.addEventListener('click',        () => openProfileModal());
profileModalClose.addEventListener('click', () => closeProfileModal());
profileModalBg.addEventListener('click',    () => closeProfileModal());

// ── Proxy status dot helper ───────────────────────────────────────
function proxyDotColor(status) {
    if (status === 'ok')      return '#28c840';
    if (status === 'error')   return '#e81123';
    if (status === 'testing') return '#f59e0b';
    return '#444'; // unknown
}

function renderProfilesList() {
    profilesList.innerHTML = '';
    const lc = profileFilter.toLowerCase();
    const filtered = allProfiles.filter(p => {
        if (!p.name.toLowerCase().includes(lc)) return false;
        if (_pmProxyFilter && !p.proxy?.enabled) return false;
        return true;
    });
    const totalPages = Math.max(1, Math.ceil(filtered.length / PROFILE_PAGE_SIZE));
    profilePage = Math.min(Math.max(0, profilePage), totalPages - 1);
    const profs = filtered.slice(profilePage * PROFILE_PAGE_SIZE, (profilePage + 1) * PROFILE_PAGE_SIZE);

    // Update pagination controls
    const showPagination = filtered.length > PROFILE_PAGE_SIZE;
    document.getElementById('profile-pagination').style.display = showPagination ? 'flex' : 'none';
    profPageInfo.textContent = `Стор. ${profilePage + 1} / ${totalPages}  (всього ${filtered.length})`;
    profPrevBtn.disabled = profilePage === 0;
    profNextBtn.disabled = profilePage >= totalPages - 1;

    profs.forEach(p => {
        const isCurrent = currentProfile && p.id === currentProfile.id;
        const card = document.createElement('div');
        card.className = 'profile-card';
        const initials  = (p.name || '?').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase() || '??';
        const proxyText = p.proxy?.enabled ? `${p.proxy.host}:${p.proxy.port}` : 'Без проксі';
        const hasProxyConfig = !!(p.proxy?.host);
        const proxyOn = !!p.proxy?.enabled;

        // OS badge
        const osMap = { win11:'Win11', win10:'Win10', macos:'macOS', linux:'Linux' };
        const osLabel = osMap[p.os] || p.os || '';
        // Browser version badge (API returns camelCase browserVersion)
        const bvRaw = p.browserVersion || p.browser_version || '';
        const bvNum = bvRaw.replace(/chrome/i, '').replace(/[^0-9]/g, '');
        const bvLabel = bvNum ? `Chr ${bvNum}` : '';

        card.innerHTML = `
            <div class="profile-avatar" style="background:${p.color || '#9d7cce'}">${initials}</div>
            <div class="profile-card-info">
                <div class="profile-card-name">${p.name}${isCurrent ? ' <span style="font-size:10px;color:#9d7cce;font-weight:400">(поточний)</span>' : ''}</div>
                <div class="profile-card-meta">
                    ${osLabel  ? `<span class="meta-badge">${osLabel}</span>` : ''}
                    ${bvLabel  ? `<span class="meta-badge">${bvLabel}</span>` : ''}
                    <span class="meta-badge ${proxyOn ? 'meta-proxy-on' : 'meta-proxy-off'}">
                        ${proxyOn
                            ? `<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="vertical-align:-1px"><circle cx="12" cy="12" r="3"/><path stroke-linecap="round" d="M3 12h3m12 0h3M12 3v3m0 12v3"/></svg> ${proxyText}`
                            : proxyText}
                    </span>
                    <span class="proxy-dot" style="display:none;width:8px;height:8px;border-radius:50%;background:#444;flex-shrink:0"></span>
                    <span class="proxy-label" style="display:none">${proxyText}</span>
                </div>
            </div>
            <div class="profile-card-btns">
                ${proxyOn ? `<button class="card-btn" data-test="${p.id}" title="Перевірити проксі">Тест</button>` : ''}
                <button class="card-btn${proxyOn ? ' proxy-toggle-on' : ''}" data-proxy-toggle="${p.id}"
                    title="${hasProxyConfig ? (proxyOn ? 'Вимкнути проксі' : 'Увімкнути проксі') : 'Спочатку налаштуйте проксі'}"
                    style="${hasProxyConfig ? '' : 'opacity:.35;cursor:not-allowed'}">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="flex-shrink:0"><circle cx="12" cy="12" r="3"/><path stroke-linecap="round" d="M3 12h3m12 0h3M12 3v3m0 12v3M6.3 6.3l2.1 2.1m7.2 7.2l2.1 2.1M6.3 17.7l2.1-2.1m7.2-7.2l2.1-2.1"/></svg>
                    ${proxyOn ? 'Проксі ВКЛ' : 'Проксі ВИКЛ'}
                </button>
                ${!isCurrent ? `<button class="card-btn primary" data-open="${p.id}">Відкрити</button>` : ''}
                <button class="card-btn" data-edit="${p.id}">⚙</button>
            </div>`;

        // Test proxy button
        const testBtn = card.querySelector('[data-test]');
        if (testBtn) {
            testBtn.addEventListener('click', async () => {
                const dot   = card.querySelector('.proxy-dot');
                const label = card.querySelector('.proxy-label');
                dot.style.background = proxyDotColor('testing');
                label.textContent    = 'Перевірка…';
                testBtn.disabled     = true;

                const res = await window.api.checkProxy(p.id);
                if (res.ok && !res.direct) {
                    dot.style.background = proxyDotColor('ok');
                    label.textContent    = `OK — IP: ${res.ip}`;
                } else if (res.direct) {
                    dot.style.background = proxyDotColor('unknown');
                    label.textContent    = 'Без проксі';
                } else {
                    dot.style.background = proxyDotColor('error');
                    label.textContent    = `Помилка: ${res.error}`;
                }
                testBtn.disabled = false;
            });
        }

        card.querySelector('[data-proxy-toggle]')?.addEventListener('click', async () => {
            if (!hasProxyConfig) { showToast('Спочатку налаштуйте проксі в "Налаштуваннях"', 'info', 3000); return; }
            const newEnabled = !p.proxy?.enabled;
            const newProxy = { ...(p.proxy || { protocol: 'http', host: '', port: '', user: '', pass: '' }), enabled: newEnabled };
            const updated = await window.api.updateProfile({ id: p.id, proxy: newProxy }).catch(() => null);
            if (updated) {
                const idx = allProfiles.findIndex(ap => ap.id === p.id);
                if (idx >= 0) allProfiles[idx] = updated;
                renderProfilesList();
                showToast(newEnabled ? `Проксі увімкнено: ${p.name}` : `Проксі вимкнено: ${p.name}`, 'info', 2000);
            } else {
                showToast('Помилка оновлення проксі', 'error');
            }
        });

        card.querySelector('[data-edit]')?.addEventListener('click', () => openEditModal(p));
        card.querySelector('[data-open]')?.addEventListener('click', () => {
            window.api.openProfile(p.id);
            closeProfileModal();
        });
        profilesList.appendChild(card);
    });
}

// ── Profile edit modal ───────────────────────────────────────────
let editingProfileId = null;

const editModal      = document.getElementById('profile-edit-modal');
const editModalTitle = document.getElementById('edit-modal-title');
const editModalClose = document.getElementById('edit-modal-close');
const editModalBg    = document.getElementById('edit-modal-backdrop');
const editNameField  = document.getElementById('edit-name');
const editColorField = document.getElementById('edit-color');
const colorPreview   = document.getElementById('edit-color-preview');
const proxyEnabled   = document.getElementById('proxy-enabled');
const proxyFields    = document.getElementById('proxy-fields');
const proxyProto     = document.getElementById('proxy-proto');
const proxyHost      = document.getElementById('proxy-host');
const proxyPort      = document.getElementById('proxy-port');
const proxyUser      = document.getElementById('proxy-user');
const proxyPass      = document.getElementById('proxy-pass');
const editSaveBtn    = document.getElementById('edit-save-btn');
const editDeleteBtn  = document.getElementById('edit-delete-btn');
const editCancelBtn  = document.getElementById('edit-cancel-btn');

editColorField.addEventListener('input', () => { colorPreview.style.background = editColorField.value; });
proxyEnabled.addEventListener('change',  () => { proxyFields.style.display = proxyEnabled.checked ? 'block' : 'none'; });

function openEditModal(profile) {
    editingProfileId              = profile ? profile.id : null;
    editModalTitle.textContent    = profile ? `Редагувати: ${profile.name}` : 'Новий профіль';
    editNameField.value           = profile?.name  || '';
    const color                   = profile?.color || '#9d7cce';
    editColorField.value          = color;
    colorPreview.style.background = color;

    const proxy = profile?.proxy || {};
    proxyEnabled.checked      = !!proxy.enabled;
    proxyFields.style.display = proxy.enabled ? 'block' : 'none';
    proxyProto.value          = proxy.protocol || 'http';
    proxyHost.value           = proxy.host     || '';
    proxyPort.value           = proxy.port     || '';
    proxyUser.value           = proxy.user     || '';
    proxyPass.value           = proxy.pass     || '';

    editDeleteBtn.style.display = profile ? 'inline-flex' : 'none';
    editModal.classList.remove('hidden');
    overlayOpened('editModal');
    setTimeout(() => editNameField.focus(), 50);
}

function closeEditModal() {
    editingProfileId = null;
    editModal.classList.add('hidden');
    overlayClosed('editModal');
}

editModalClose.addEventListener('click',  () => closeEditModal());
editModalBg.addEventListener('click',     () => closeEditModal());
editCancelBtn.addEventListener('click',   () => closeEditModal());
addProfileBtn.addEventListener('click',   () => { closeProfileModal(); openEditModal(null); });

editSaveBtn.addEventListener('click', async () => {
    const name = editNameField.value.trim();
    if (!name) { showToast('Введіть назву профілю', 'error'); return; }

    const proxy = {
        enabled:  proxyEnabled.checked,
        protocol: proxyProto.value,
        host:     proxyHost.value.trim(),
        port:     proxyPort.value.trim(),
        user:     proxyUser.value.trim(),
        pass:     proxyPass.value,
    };

    try {
        if (editingProfileId) {
            await window.api.updateProfile({ id: editingProfileId, name, color: editColorField.value, proxy });
            showToast('Профіль оновлено', 'success');
        } else {
            await window.api.createProfile({ name, color: editColorField.value, proxy });
            showToast('Профіль створено', 'success');
        }
        closeEditModal();
        openProfileModal();
    } catch { showToast('Помилка збереження', 'error'); }
});

editDeleteBtn.addEventListener('click', async () => {
    if (!editingProfileId) return;
    if (!confirm('Видалити цей профіль?')) return;
    const id = editingProfileId;
    try {
        const res = await window.api.deleteProfile(id);
        if (res?.ok === false) {
            if (res.reason === 'own')  showToast('Не можна видалити активний профіль', 'error');
            else if (res.reason === 'last') showToast('Не можна видалити останній профіль', 'error');
            else showToast('Помилка видалення', 'error');
            return;
        }
        showToast('Профіль видалено', 'info');
        closeEditModal();
        openProfileModal();
    } catch { showToast('Помилка видалення', 'error'); }
});

// ── Keyboard shortcuts ───────────────────────────────────────────
document.addEventListener('keydown', e => {
    const ctrl = e.ctrlKey, shift = e.shiftKey, alt = e.altKey, key = e.key;

    // ── Tab management ────────────────────────────────────────────
    if (ctrl && !shift && key === 't') { e.preventDefault(); window.api.newTab(); return; }
    if (ctrl && !shift && key === 'w') { e.preventDefault(); if (activeTabId != null) window.api.closeTab(activeTabId); return; }
    if (ctrl &&  shift && key === 'T') { e.preventDefault(); if (closedTabsHistory.length) window.api.newTab(closedTabsHistory.pop().url); return; }
    if (ctrl && !shift && key === 'Tab')   { e.preventDefault(); switchToNextTab(); return; }
    if (ctrl &&  shift && key === 'Tab')   { e.preventDefault(); switchToPrevTab(); return; }
    if (ctrl && key >= '1' && key <= '8') { e.preventDefault(); switchToTabByIndex(parseInt(key) - 1); return; }
    if (ctrl && key === '9')              { e.preventDefault(); switchToTabByIndex(Infinity);           return; }

    // ── Navigation ────────────────────────────────────────────────
    if (alt && key === 'ArrowLeft')    { e.preventDefault(); window.api.goBack();     return; }
    if (alt && key === 'ArrowRight')   { e.preventDefault(); window.api.goForward();  return; }
    if (!ctrl && !alt && key === 'F5') { e.preventDefault(); window.api.reload();     return; }
    if (ctrl && !shift && key === 'r') { e.preventDefault(); window.api.reload();     return; }
    if (ctrl &&  shift && key === 'R') { e.preventDefault(); window.api.hardReload(); return; }

    // ── Address bar ───────────────────────────────────────────────
    if (ctrl && (key === 'l' || key === 'k')) { e.preventDefault(); addressBar.focus(); addressBar.select(); return; }

    // ── Find in page ──────────────────────────────────────────────
    if (ctrl && !shift && key === 'f') { e.preventDefault(); findBarShow(); return; }

    // ── New window ────────────────────────────────────────────────
    if (ctrl && !shift && key === 'n') { e.preventDefault(); window.api.openExtraWindow({}); return; }
    if (ctrl &&  shift && key === 'N') { e.preventDefault(); window.api.openExtraWindow({}); return; }

    // ── Extras ───────────────────────────────────────────────────
    if (ctrl && !shift && key === 'd') { e.preventDefault(); addBookmark(); return; }
    if (ctrl && !shift && key === 'h') { e.preventDefault(); loadHistory(); toggleMenu(historyMenu); return; }
    if (ctrl && !shift && key === 'u') { e.preventDefault(); window.api.viewSource(); return; }
    if (key === 'F12' || (ctrl && shift && key === 'I')) { e.preventDefault(); window.api.openDevTools(); return; }
    if (key === 'F11') { e.preventDefault(); window.api.winFullscreen(); return; }

    // ── Accounts / profiles ───────────────────────────────────────
    if (ctrl && shift && key === 'A') { e.preventDefault(); openProfileModal(); return; }
    if (ctrl && shift && key === 'ArrowLeft')  { e.preventDefault(); switchToAdjacentProfile(-1); return; }
    if (ctrl && shift && key === 'ArrowRight') { e.preventDefault(); switchToAdjacentProfile(+1); return; }
    // Claude.ai quick access
    if (ctrl && shift && key === 'C') { e.preventDefault(); window.api.navigate('https://claude.ai'); return; }

    // ── Close overlays ────────────────────────────────────────────
    if (key === 'Escape') { closeAllMenus(); closeTabCtx(); }
});

// ── Ctrl+Enter in address bar: auto-wrap with www. and .com ───────
addressBar.addEventListener('keydown', e => {
    if (e.ctrlKey && e.key === 'Enter') {
        const v = addressBar.value.trim();
        if (v && !v.includes('.') && !v.includes('/') && !v.includes(' ')) {
            e.preventDefault();
            window.api.navigate('https://www.' + v + '.com');
            addressBar.blur();
        }
    }
});

// ── Sync status indicator ─────────────────────────────────────────
const syncDot   = document.getElementById('sync-dot');
const syncLabel = document.getElementById('sync-label');
const syncWrap  = document.getElementById('sync-status-wrap');

function updateSyncUI({ connected, lastSync }) {
    if (!syncDot) return;
    syncDot.style.background = connected ? '#28c840' : '#e81123';
    if (connected && lastSync) {
        const t = new Date(lastSync).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
        syncLabel.textContent  = t;
        syncWrap.title = `Підключено до сервера · Синх о ${t}`;
    } else if (connected) {
        syncLabel.textContent  = '';
        syncWrap.title = 'Підключено до сервера';
    } else {
        syncLabel.textContent  = 'Офлайн';
        syncWrap.title = 'Сервер недоступний';
    }
}
window.api.onSyncStatus(updateSyncUI);
window.api.getSyncStatus().then(updateSyncUI).catch(() => {});

// ── Update banner ─────────────────────────────────────────────────
const updateBanner  = document.getElementById('update-banner');
const updTitle      = document.getElementById('upd-title');
const updDesc       = document.getElementById('upd-desc');
const updDownload   = document.getElementById('upd-download-btn');
const updClose      = document.getElementById('upd-close-btn');
let   _updateInfo   = null;

function getPlatformDownloadUrl(info) {
    // Detect platform from IPC (cached in window.api)
    const plat = window._osPlatform || 'linux';
    if (plat === 'win32')  return info.downloadUrlWin   || info.downloadUrl || null;
    if (plat === 'darwin') return info.downloadUrlMac   || info.downloadUrl || null;
    return                        info.downloadUrlLinux || info.downloadUrl || null;
}

function showUpdateBanner(info) {
    if (!info || !info.latestVersion) return;
    _updateInfo = info;
    updTitle.textContent = `Оновлення ${info.latestVersion} доступне!`;
    updDesc.textContent  = info.releaseNotes || `Нова версія DEFIS Browser готова до завантаження`;
    const url = getPlatformDownloadUrl(info);
    updDownload.style.display = url ? '' : 'none';
    updateBanner.classList.add('visible');
}

updClose.addEventListener('click', () => updateBanner.classList.remove('visible'));
updDownload.addEventListener('click', () => {
    const url = _updateInfo ? getPlatformDownloadUrl(_updateInfo) : null;
    if (url) {
        updDownload.disabled = true;
        updDownload.textContent = 'Завантаження…';
        window.api.openDownloadUrl(url);
    }
});

window.api.onUpdateInstallStatus(({ state, pct, message, path: destPath }) => {
    switch (state) {
        case 'downloading':
            updDownload.disabled = true;
            updDownload.textContent = pct > 0 ? `${pct}%…` : 'Завантаження…';
            break;
        case 'waiting-auth':
            updDownload.disabled = true;
            updDownload.textContent = 'Очікування…';
            updDesc.textContent = '⚠ Введіть пароль адміністратора у вікні яке з\'явилося (можливо за браузером)';
            break;
        case 'installing':
            updDownload.disabled = true;
            updDownload.textContent = 'Встановлення…';
            updDesc.textContent = 'Встановлення оновлення, зачекайте…';
            break;
        case 'done':
            updDownload.disabled = true;
            updDownload.textContent = '✓ Встановлено';
            updDesc.textContent = 'Браузер перезапускається…';
            break;
        case 'manual':
            updDownload.disabled = false;
            updDownload.textContent = 'Завантажити';
            updDesc.textContent = `Команда скопійована. Вставте в термінал: sudo pacman -U ${destPath || ''}`;
            break;
        case 'error':
            updDownload.disabled = false;
            updDownload.textContent = 'Завантажити';
            updDesc.textContent = `Помилка: ${message || 'спробуйте ще раз'}`;
            break;
    }
});

window.api.onUpdateAvailable(showUpdateBanner);

// Cache platform once, then check for updates
window.api.getPlatform().then(p => { window._osPlatform = p; }).catch(() => {});
window.api.checkUpdate().then(info => { if (info) showUpdateBanner(info); }).catch(() => {});

// ── Tab right-click context menu ──────────────────────────────────
const tabCtxMenu = document.createElement('div');
tabCtxMenu.id    = 'tab-ctx-menu';
tabCtxMenu.className = 'dropdown-menu';
tabCtxMenu.style.cssText = 'position:fixed;z-index:99999;min-width:190px;display:none;';
document.body.appendChild(tabCtxMenu);
let tabCtxId = null;

function showTabCtx(tabId, x, y) {
    tabCtxId = tabId;
    tabCtxMenu.innerHTML = `
        <div class="menu-item" id="ctx-reload-tab">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
            </svg>Перезавантажити
        </div>
        <div class="menu-item" id="ctx-duplicate-tab">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
            </svg>Дублювати вкладку
        </div>
        <div class="menu-item" id="ctx-copy-url">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"/>
            </svg>Скопіювати URL
        </div>
        <div class="menu-item" id="ctx-new-win">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/>
            </svg>Відкрити в новому вікні
        </div>
        <div class="menu-divider"></div>
        <div class="menu-item" id="ctx-close-tab" style="color:#e06c75">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" d="M6 18L18 6M6 6l12 12"/>
            </svg>Закрити вкладку
        </div>`;
    tabCtxMenu.style.display = 'block';
    tabCtxMenu.style.left = x + 'px';
    tabCtxMenu.style.top  = y + 'px';
    requestAnimationFrame(() => {
        const r = tabCtxMenu.getBoundingClientRect();
        if (r.right  > window.innerWidth)  tabCtxMenu.style.left = (x - r.width)  + 'px';
        if (r.bottom > window.innerHeight) tabCtxMenu.style.top  = (y - r.height) + 'px';
    });
    tabCtxMenu.querySelector('#ctx-reload-tab').onclick = () => {
        window.api.reloadTab(tabCtxId);
        closeTabCtx();
    };
    tabCtxMenu.querySelector('#ctx-duplicate-tab').onclick = () => {
        window.api.duplicateTab(tabCtxId);
        closeTabCtx();
    };
    tabCtxMenu.querySelector('#ctx-copy-url').onclick = () => {
        window.api.copyTabUrl(tabCtxId);
        showToast('URL скопійовано', 'success', 2000);
        closeTabCtx();
    };
    tabCtxMenu.querySelector('#ctx-new-win').onclick = () => {
        const tab = tabsState.get(tabCtxId);
        window.api.openExtraWindow({ url: tab?.url || null });
        closeTabCtx();
    };
    tabCtxMenu.querySelector('#ctx-close-tab').onclick = () => {
        window.api.closeTab(tabCtxId);
        closeTabCtx();
    };
}
function closeTabCtx() {
    tabCtxMenu.style.display = 'none';
    tabCtxId = null;
}
document.addEventListener('click',  () => closeTabCtx());
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeTabCtx(); });

// ── Find bar ─────────────────────────────────────────────────────
const findBar      = document.getElementById('find-bar');
const findInput    = document.getElementById('find-bar-input');
const findCount    = document.getElementById('find-bar-count');
const findPrevBtn  = document.getElementById('find-bar-prev');
const findNextBtn  = document.getElementById('find-bar-next');
const findCloseBtn = document.getElementById('find-bar-close');

function findBarShow() {
    findBar.classList.add('visible');
    window.api.findBarOpen();
    findInput.focus();
    findInput.select();
    const q = findInput.value.trim();
    if (q) window.api.findInPage({ query: q, options: { findNext: false } });
}

function findBarHide() {
    if (!findBar.classList.contains('visible')) return;
    findBar.classList.remove('visible');
    findCount.textContent = '';
    window.api.findBarClose();
}

findInput.addEventListener('input', () => {
    const q = findInput.value.trim();
    if (q) window.api.findInPage({ query: q, options: { findNext: false } });
    else findCount.textContent = '';
});

findInput.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); const q = findInput.value.trim(); if (q) window.api.findInPage({ query: q, options: { findNext: true, forward: !e.shiftKey } }); }
    if (e.key === 'Escape') { e.preventDefault(); findBarHide(); }
});

findPrevBtn.addEventListener('click',  () => { const q = findInput.value.trim(); if (q) window.api.findInPage({ query: q, options: { findNext: true, forward: false } }); });
findNextBtn.addEventListener('click',  () => { const q = findInput.value.trim(); if (q) window.api.findInPage({ query: q, options: { findNext: true, forward: true  } }); });
findCloseBtn.addEventListener('click', () => findBarHide());

window.api.onFindResult(({ activeMatchOrdinal, matches }) => {
    if (matches > 0) {
        findCount.textContent = `${activeMatchOrdinal} / ${matches}`;
        findCount.style.color = '#666';
    } else {
        findCount.textContent = findInput.value.trim() ? 'Не знайдено' : '';
        findCount.style.color = '#e06c75';
    }
});

// Hide find bar when switching tabs
window.api.onActiveTabChanged(() => findBarHide());

// ── Shortcuts forwarded from BrowserView (before-input-event) ─────
window.api.onShortcutFind(()         => findBarShow());
window.api.onShortcutFocusAddress(() => { addressBar.focus(); addressBar.select(); });
window.api.onShortcutBookmark(()     => addBookmark());
window.api.onShortcutHistory(()     => { loadHistory(); toggleMenu(historyMenu); });
window.api.onShortcutRestoreTab(()  => {
    if (closedTabsHistory.length) window.api.newTab(closedTabsHistory.pop().url);
});

// ── Init ─────────────────────────────────────────────────────────
showNewtab(true);
window.api.requestInit();

// ══════════════════════════════════════════════════════════════════
// ── Notepad panel ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
(function initNotepad() {
    const panel        = document.getElementById('notepad-panel');
    const notepadBtn   = document.getElementById('notepadBtn');
    const listView     = document.getElementById('np-list-view');
    const editorView   = document.getElementById('np-editor-view');
    const listEl       = document.getElementById('np-list');
    const emptyEl      = document.getElementById('np-empty');
    const closePanelBtn= document.getElementById('np-close-btn');
    const newNoteBtn   = document.getElementById('np-new-btn');
    const backBtn      = document.getElementById('np-back-btn');
    const titleInput   = document.getElementById('np-title-input');
    const visSelect    = document.getElementById('np-vis-select');
    const shareBtn     = document.getElementById('np-share-btn');
    const deleteBtn    = document.getElementById('np-delete-btn');
    const editor       = document.getElementById('np-editor');
    const scopeTabs    = document.querySelectorAll('.np-tab');
    const fmtBtns      = document.querySelectorAll('.np-fmt-btn');

    let panelOpen   = false;
    let currentScope = 'profile';
    let currentNote  = null;  // note being edited
    let allNotes     = [];
    let saveTimer    = null;

    // ── Unique ID helper ───────────────────────────────────────────
    function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

    // ── Panel open / close ─────────────────────────────────────────
    function openPanel() {
        closeAllMenus(); // close any open dropdown before opening panel
        panelOpen = true;
        panel.classList.add('np-visible');
        notepadBtn.classList.add('np-open');
        window.api.notepadOpen();
        loadNotes();
    }

    function closePanel() {
        panelOpen = false;
        panel.classList.remove('np-visible');
        notepadBtn.classList.remove('np-open');
        window.api.notepadClose();
        if (currentNote) flushSave();
    }

    // Expose for mutual-exclusion with dropdown menus
    if (!window._panels) window._panels = {};
    window._panels.notepad = { get isOpen() { return panelOpen; }, close: closePanel };

    notepadBtn.addEventListener('click', () => panelOpen ? closePanel() : openPanel());
    closePanelBtn.addEventListener('click', closePanel);

    // ── Scope tab switching ────────────────────────────────────────
    scopeTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            currentScope = tab.dataset.scope;
            scopeTabs.forEach(t => t.classList.toggle('active', t.dataset.scope === currentScope));
            renderNoteList();
        });
    });

    // ── Load notes from main process ──────────────────────────────
    async function loadNotes() {
        try {
            allNotes = await window.api.notesGet({ profileId: currentProfile?.id || null });
        } catch { allNotes = []; }
        renderNoteList();
    }

    // ── Strip HTML tags for preview ───────────────────────────────
    function stripHtml(html) {
        const tmp = document.createElement('div');
        tmp.innerHTML = html || '';
        return tmp.textContent || '';
    }

    // ── Render note list ──────────────────────────────────────────
    function renderNoteList() {
        const filtered = allNotes.filter(n => n.scope === currentScope);
        listEl.innerHTML = '';
        emptyEl.style.display = filtered.length ? 'none' : 'block';

        // Visibility SVG icons (14×14, inline)
        const VIS_ICON = {
            private: `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="flex-shrink:0"><rect x="3" y="11" width="18" height="11" rx="2"/><path stroke-linecap="round" d="M7 11V7a5 5 0 0110 0v4"/></svg>`,
            team:    `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="flex-shrink:0"><path stroke-linecap="round" d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>`,
            public:  `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="flex-shrink:0"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 010 20M12 2a15 15 0 000 20" stroke-linecap="round"/></svg>`,
        };
        const VIS_LABEL = { private: 'Приватна', team: 'Команда', public: 'Публічна' };

        filtered.forEach(note => {
            const card = document.createElement('div');
            card.className = 'np-card';
            const preview  = stripHtml(note.content).slice(0, 70) || '—';
            const vis      = note.visibility || 'private';
            const visIcon  = VIS_ICON[vis] || VIS_ICON.private;
            const visLabel = VIS_LABEL[vis] || vis;
            const dateStr  = note.updatedAt
                ? new Date(note.updatedAt).toLocaleDateString('uk-UA', { day:'numeric', month:'short' })
                : '';
            card.innerHTML = `
                <div class="np-card-title">${note.title || 'Без назви'}</div>
                <div class="np-card-preview">${preview}</div>
                <div class="np-card-meta">
                    <span class="np-vis-badge" style="display:flex;align-items:center;gap:4px">${visIcon}${visLabel}</span>
                    <span>${dateStr}</span>
                </div>`;
            card.addEventListener('click', () => openNote(note));
            listEl.appendChild(card);
        });
    }

    // ── Show list view / editor view ──────────────────────────────
    function showList() {
        listView.style.display = 'flex';
        editorView.style.display = 'none';
    }

    function showEditor() {
        listView.style.display   = 'none';
        editorView.style.display = 'flex';
        editorView.style.flexDirection = 'column';
    }

    // ── Open a note in editor ─────────────────────────────────────
    function openNote(note) {
        currentNote      = note;
        titleInput.value = note.title || '';
        visSelect.value  = note.visibility || 'private';
        editor.innerHTML = note.content  || '';
        showEditor();
        editor.focus();
    }

    // ── Create new note ───────────────────────────────────────────
    newNoteBtn.addEventListener('click', () => {
        const note = {
            id:         uid(),
            title:      '',
            content:    '',
            scope:      currentScope,
            profileId:  currentScope === 'profile' ? (currentProfile?.id || null) : null,
            visibility: 'private',
            shareToken: null,
        };
        allNotes.unshift(note);
        openNote(note);
    });

    // ── Back to list ──────────────────────────────────────────────
    backBtn.addEventListener('click', () => {
        flushSave();
        currentNote = null;
        showList();
        renderNoteList();
    });

    // ── Visibility change ─────────────────────────────────────────
    visSelect.addEventListener('change', () => {
        if (currentNote) { currentNote.visibility = visSelect.value; scheduleSave(); }
    });

    // ── Delete note ───────────────────────────────────────────────
    deleteBtn.addEventListener('click', async () => {
        if (!currentNote) return;
        if (!confirm('Видалити цю нотатку?')) return;
        await window.api.notesDelete({ id: currentNote.id }).catch(() => {});
        allNotes = allNotes.filter(n => n.id !== currentNote.id);
        currentNote = null;
        clearTimeout(saveTimer);
        showList();
        renderNoteList();
    });

    // ── Share note ────────────────────────────────────────────────
    shareBtn.addEventListener('click', async () => {
        if (!currentNote) return;
        if (currentNote.visibility === 'private') {
            showToast('Змініть видимість на "Команда" або "Публічна" для ділення', 'info', 4000);
            return;
        }
        if (!currentNote.shareToken) currentNote.shareToken = uid() + uid();
        flushSave();
        // Build share URL using configured server URL
        const base = (await window.api.getServerUrl()) || 'http://188.137.178.124:3717';
        const url  = `${base}/notes/share/${currentNote.shareToken}`;
        try { await navigator.clipboard.writeText(url); showToast('Посилання скопійовано!', 'success'); }
        catch { showToast(`Посилання: ${url}`, 'info', 8000); }
    });

    // ── Auto-save ─────────────────────────────────────────────────
    function scheduleSave() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(flushSave, 600);
    }

    async function flushSave() {
        clearTimeout(saveTimer);
        if (!currentNote) return;
        currentNote.title    = titleInput.value.trim() || 'Без назви';
        currentNote.content  = editor.innerHTML;
        const idx = allNotes.findIndex(n => n.id === currentNote.id);
        if (idx < 0) allNotes.unshift(currentNote);
        else allNotes[idx] = currentNote;
        try { await window.api.notesSave(currentNote); } catch {}
    }

    titleInput.addEventListener('input', scheduleSave);
    editor.addEventListener('input', scheduleSave);

    // ── Rich text formatting ──────────────────────────────────────
    fmtBtns.forEach(btn => {
        btn.addEventListener('mousedown', e => {
            e.preventDefault();  // don't lose editor focus
            const cmd = btn.dataset.cmd;

            if (cmd === 'h1' || cmd === 'h2' || cmd === 'h3') {
                document.execCommand('formatBlock', false, cmd);
            } else if (cmd === 'p') {
                document.execCommand('formatBlock', false, 'p');
            } else if (cmd === 'blockquote') {
                document.execCommand('formatBlock', false, 'blockquote');
            } else if (cmd === 'code') {
                const sel = window.getSelection();
                const text = sel?.toString();
                if (text) {
                    document.execCommand('insertHTML', false, `<code>${text.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</code>`);
                }
            } else if (cmd === 'spoiler') {
                const sel = window.getSelection();
                const text = sel?.toString();
                if (text) {
                    document.execCommand('insertHTML', false, `<span class="spoiler">${text}</span>`);
                }
            } else {
                document.execCommand(cmd, false, null);
            }
            updateFmtBtnStates();
        });
    });

    // ── Update format button active states ─────────────────────────
    function updateFmtBtnStates() {
        fmtBtns.forEach(btn => {
            const cmd = btn.dataset.cmd;
            let active = false;
            if (['bold','italic','underline','strikeThrough','insertUnorderedList','insertOrderedList'].includes(cmd)) {
                try { active = document.queryCommandState(cmd); } catch {}
            }
            btn.classList.toggle('fmt-active', active);
        });
    }

    editor.addEventListener('keyup',    updateFmtBtnStates);
    editor.addEventListener('mouseup',  updateFmtBtnStates);
    editor.addEventListener('selectionchange', updateFmtBtnStates);

    // ── Spoiler click to reveal ───────────────────────────────────
    editor.addEventListener('click', e => {
        const sp = e.target.closest('.spoiler');
        if (sp) sp.classList.toggle('revealed');
    });

    // ── Keyboard shortcuts inside editor ──────────────────────────
    editor.addEventListener('keydown', e => {
        if (e.ctrlKey && e.key === 's') { e.preventDefault(); flushSave(); }
    });

    // ── Reload notes when profile changes ─────────────────────────
    window.api.onSetProfile(() => {
        if (panelOpen) loadNotes();
    });

    // ── Close panel on Escape ─────────────────────────────────────
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && panelOpen && editorView.style.display !== 'none') {
            backBtn.click();
        }
    });

})();

// ══════════════════════════════════════════════════════════════════
// ── Screenshot lightbox ───────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
(function initLightbox() {
    const box      = document.getElementById('sc-lightbox');
    const img      = document.getElementById('sc-lightbox-img');
    const closeBtn = document.getElementById('sc-lightbox-close');
    let scale = 1;

    function open(src) {
        img.src = src;
        scale = 1;
        img.style.transform = 'scale(1)';
        box.classList.add('open');
        overlayOpened('lightbox');
    }

    function close() {
        box.classList.remove('open');
        overlayClosed('lightbox');
        setTimeout(() => { img.src = ''; }, 200);
    }

    // Expose globally for agent panel
    window.openLightbox = open;

    closeBtn.addEventListener('click', close);
    box.addEventListener('click', e => { if (e.target === box) close(); });

    // Escape to close
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && box.classList.contains('open')) close();
    });

    // Mouse wheel zoom
    img.addEventListener('wheel', e => {
        e.preventDefault();
        scale = Math.min(Math.max(scale - e.deltaY * 0.001, 0.5), 4);
        img.style.transform = `scale(${scale})`;
        img.style.transition = 'none';
    }, { passive: false });
})();

// ══════════════════════════════════════════════════════════════════
// ── AI Agent panel ────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
(function initAgentPanel() {
    const panel       = document.getElementById('agent-panel');
    const agentBtn    = document.getElementById('agentBtn');
    const closeBtn    = document.getElementById('ag-close-btn');
    const taskInput   = document.getElementById('ag-task');
    const runBtn      = document.getElementById('ag-run-btn');
    const logEl       = document.getElementById('ag-log');
    const emptyEl     = document.getElementById('ag-empty');
    const statusBar   = document.getElementById('ag-status-bar');
    const statusText  = document.getElementById('ag-status-text');
    const modelLabel  = document.getElementById('ag-model-label');
    const btnSend     = document.getElementById('ag-btn-send');
    const btnStop     = document.getElementById('ag-btn-stop');

    let panelOpen    = false;
    let running      = false;
    let currentTurn  = null; // current agent-turn div

    // ── Panel open / close ─────────────────────────────────────────
    function openPanel() {
        closeAllMenus();
        panelOpen = true;
        panel.classList.add('ag-visible');
        agentBtn.classList.add('ag-open');
        window.api.agentOpen();
        // Update model label from config
        window.api.getConfig().then(cfg => {
            const agent = cfg?.agent || {};
            const provider = agent.provider || 'anthropic';
            const model = provider === 'gemini'
                ? (agent.geminiModel || 'gemini-2.0-flash')
                : (agent.model || 'claude-sonnet-4-6');
            modelLabel.textContent = model.replace('claude-', '').replace('gemini-', 'gemini-');
        }).catch(() => {});
        taskInput.focus();
    }

    function closePanel() {
        panelOpen = false;
        panel.classList.remove('ag-visible');
        agentBtn.classList.remove('ag-open');
        window.api.agentClose();
    }

    if (!window._panels) window._panels = {};
    window._panels.agent = { get isOpen() { return panelOpen; }, close: closePanel };

    agentBtn.addEventListener('click', () => panelOpen ? closePanel() : openPanel());
    closeBtn.addEventListener('click', closePanel);

    // ── Auto-grow textarea ─────────────────────────────────────────
    taskInput.addEventListener('input', () => {
        taskInput.style.height = 'auto';
        taskInput.style.height = Math.min(taskInput.scrollHeight, 120) + 'px';
    });

    // Enter to send, Shift+Enter for newline
    taskInput.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doRun(); }
    });

    // ── Running state ──────────────────────────────────────────────
    function setRunning(isRunning, statusMsg = '') {
        running = isRunning;
        runBtn.classList.toggle('ag-running', isRunning);
        btnSend.style.display = isRunning ? 'none' : '';
        btnStop.style.display = isRunning ? ''     : 'none';
        taskInput.disabled    = isRunning;
        statusBar.classList.toggle('visible', isRunning);
        if (statusMsg) statusText.textContent = statusMsg;
        currentTurn = null;
    }

    function setStatusMsg(msg) {
        statusText.textContent = msg;
    }

    // ── Chat rendering ─────────────────────────────────────────────
    const TOOL_ICONS = {
        screenshot: '📷', click: '🖱️', type: '⌨️', key: '⌨️',
        scroll: '↕️', navigate: '🌐', wait: '⏳', done: '✅', fail: '❌',
        get_dom: '🔍', click_selector: '🎯', type_in: '⌨️', js: '⚙️',
    };
    const TOOL_LABELS = {
        screenshot: 'скріншот', click: 'клік', type: 'введення', key: 'клавіша',
        scroll: 'прокрутка', navigate: 'перехід', wait: 'пауза',
        get_dom: 'DOM', click_selector: 'клік', type_in: 'введення', js: 'JS',
    };

    function scrollBottom() { logEl.scrollTop = logEl.scrollHeight; }

    function ensureTurn() {
        if (!currentTurn) {
            currentTurn = document.createElement('div');
            currentTurn.className = 'ag-agent-turn';
            logEl.appendChild(currentTurn);
        }
        return currentTurn;
    }

    function addUserBubble(text) {
        emptyEl?.remove();
        const d = document.createElement('div');
        d.className = 'ag-user-msg';
        d.textContent = text;
        logEl.appendChild(d);
        scrollBottom();
    }

    function addThought(text) {
        const turn = ensureTurn();
        // Merge into existing thought or create new
        let last = turn.lastElementChild;
        if (last?.classList.contains('ag-thought')) {
            last.textContent += '\n' + text;
        } else {
            const d = document.createElement('div');
            d.className = 'ag-thought';
            d.textContent = text;
            turn.appendChild(d);
        }
        scrollBottom();
    }

    function addAction(tool, input) {
        const turn = ensureTurn();
        const icon   = TOOL_ICONS[tool] || '⚡';
        const label  = TOOL_LABELS[tool] || tool;
        const detail = tool === 'navigate'       ? (input?.url || '').replace(/^https?:\/\//, '')
                     : tool === 'type'            ? `"${(input?.text || '').slice(0, 35)}"`
                     : tool === 'type_in'         ? `${input?.selector} → "${(input?.text||'').slice(0,25)}"`
                     : tool === 'click'           ? `x:${input?.x} y:${input?.y}`
                     : tool === 'click_selector'  ? input?.selector
                     : tool === 'get_dom'         ? (input?.selector || 'body')
                     : tool === 'js'              ? (input?.code || '').slice(0, 40)
                     : tool === 'key'             ? input?.key
                     : tool === 'scroll'          ? `${input?.deltaY > 0 ? '↓' : '↑'}${Math.abs(input?.deltaY || 0)}px`
                     : tool === 'wait'            ? `${input?.ms}мс`
                     : '';
        const d = document.createElement('div');
        d.className = 'ag-action';
        d.innerHTML = `<span class="ag-action-icon">${icon}</span><span class="ag-action-tool">${label}</span>${detail ? `<span class="ag-action-detail">${detail}</span>` : ''}`;
        turn.appendChild(d);
        setStatusMsg(label + (detail ? `: ${detail}` : '') + '…');
        scrollBottom();
    }

    function addScreenshot(data) {
        const turn = ensureTurn();
        const img = document.createElement('img');
        img.className = 'ag-screenshot';
        img.src = `data:image/png;base64,${data}`;
        img.title = 'Натисніть для перегляду';
        img.addEventListener('click', () => openLightbox(img.src));
        turn.appendChild(img);
        scrollBottom();
    }

    function addDone(text) {
        const d = document.createElement('div');
        d.className = 'ag-done-msg';
        d.textContent = '✅ ' + (text || 'Завдання виконано');
        logEl.appendChild(d);
        currentTurn = null;
        scrollBottom();
    }

    function addError(text) {
        const d = document.createElement('div');
        d.className = 'ag-error-msg';
        d.textContent = '❌ ' + (text || 'Помилка');
        logEl.appendChild(d);
        currentTurn = null;
        scrollBottom();
    }

    // ── Run ────────────────────────────────────────────────────────
    function doRun() {
        if (running) {
            window.api.agentStop();
            setRunning(false);
            addError('Зупинено користувачем');
            return;
        }
        const task = taskInput.value.trim();
        if (!task) { taskInput.focus(); return; }

        addUserBubble(task);
        taskInput.value = '';
        taskInput.style.height = 'auto';
        setRunning(true, 'Запуск агента…');
        window.api.agentStart(task);
    }

    runBtn.addEventListener('click', doRun);

    // ── Agent events ───────────────────────────────────────────────
    window.api.onAgentEvent(event => {
        switch (event.type) {
            case 'thought':    addThought(event.text);          break;
            case 'action':     addAction(event.tool, event.input); break;
            case 'screenshot': addScreenshot(event.data);       break;
            case 'done':
                addDone(event.text);
                setRunning(false);
                break;
            case 'error':
                addError(event.text);
                setRunning(false);
                break;
            case 'stopped':
                setRunning(false);
                break;
        }
    });

})();
