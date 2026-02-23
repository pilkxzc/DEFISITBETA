'use strict';
const { BrowserView, BrowserWindow, session, net, clipboard, Menu } = require('electron');
const path = require('path');

const state = require('./state');

// ── Constants ─────────────────────────────────────────────────────
const CHROME_HEIGHT   = 90;
const NOTEPAD_WIDTH   = 380;
const FIND_BAR_HEIGHT = 44;
const ENGINES = {
    google:     q => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
    duckduckgo: q => `https://duckduckgo.com/?q=${encodeURIComponent(q)}`,
    bing:       q => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
};

// ── URL builder ───────────────────────────────────────────────────
function buildUrl(win, raw) {
    if (/^(https?|file|about):\/\//i.test(raw)) return raw;
    if (/^[\w.-]+\.\w{2,}(\/|$)/.test(raw) && !raw.includes(' ')) return 'https://' + raw;
    return ENGINES[state.searchEngines.get(win.id) || 'google'](raw);
}

// ── View bounds ───────────────────────────────────────────────────
function getViewBounds(win) {
    const [w, h] = win.getContentSize();
    const panelW = (state.windowNotepadOpen.get(win.id) || state.windowAgentOpen.get(win.id)) ? NOTEPAD_WIDTH : 0;
    const sideW  = require('./extensions').getSidePanelWidth(win.id);
    const findH  = state.windowFindBarOpen.get(win.id) ? FIND_BAR_HEIGHT : 0;
    return { x: 0, y: CHROME_HEIGHT, width: w - panelW - sideW, height: h - CHROME_HEIGHT - findH };
}

function getActiveBrowserView(win) {
    const tabId = state.getActiveId(win);
    const tab   = state.getTabs(win).get(tabId);
    return tab?.view || null;
}

function overlayShow(win) {
    const view = getActiveBrowserView(win);
    if (view) view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
}

function overlayHide(win) {
    const view = getActiveBrowserView(win);
    if (!view) return;
    view.setBounds(getViewBounds(win));
}

function setActiveView(win, tabId) {
    const overlayOpen = (state.windowOverlayCount.get(win.id) || 0) > 0;

    state.getTabs(win).forEach((tab, id) => {
        if (!tab.view) return;
        if (id === tabId) {
            tab.view.setBounds(overlayOpen
                ? { x: 0, y: 0, width: 0, height: 0 }
                : getViewBounds(win)
            );
        } else {
            tab.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
        }
    });

    const activeTab = state.getTabs(win).get(tabId);
    if (activeTab?.view) win.setTopBrowserView(activeTab.view);
    // Keep side panel on top of the active tab
    const _sp = require('./extensions').getSidePanelView(win.id);
    if (_sp) try { win.setTopBrowserView(_sp); } catch {}
}

// ── setupViewEvents ───────────────────────────────────────────────
function setupViewEvents(win, tabId, view) {
    const profile = state.getProfile(win);
    const { dispatchTabEvent, makeExtTabInfo } = require('./extensions');
    const api = require('../api-client');

    view.webContents.on('page-title-updated', (_e, title) => {
        win.webContents.send('tab-update', { tabId, title });
    });

    view.webContents.on('will-navigate', (event, url) => {
        try {
            // twitter.com/intent/* allowed: extensions use these for profile lookups
        } catch {}
        if (url && !url.startsWith('about:') && profile) {
            const _sess = session.fromPartition(`persist:${profile.id}`);
            dispatchTabEvent(_sess, 'webNavigation.onBeforeNavigate',
                { tabId: view.webContents.id, url, timeStamp: Date.now(), frameId: 0 });
        }
    });

    function _checkCwsUrl(url) {
        if (!url) { win.webContents.send('cws-ext-detected', null); return; }
        const m = url.match(/chromewebstore\.google\.com\/detail\/[^/?#]*\/([a-z]{32})(?:[/?#]|$)/i);
        if (m) {
            const extId    = m[1].toLowerCase();
            const rawTitle = view.webContents.getTitle() || '';
            const name = rawTitle.replace(/\s*[-–]\s*Chrome Web Store\s*$/i, '').trim() || extId;
            win.webContents.send('cws-ext-detected', { extId, name });
        } else {
            win.webContents.send('cws-ext-detected', null);
        }
    }

    view.webContents.on('did-navigate', (_e, url) => {
        if (url && !url.startsWith('about:')) {
            const title = view.webContents.getTitle();
            state.browserHistory.unshift({ url, title, timestamp: Date.now() });
            if (state.browserHistory.length > 500) state.browserHistory.pop();
            if (profile) api.addHistory(profile.id, url, title).catch(() => {});
        }
        win.webContents.send('tab-update', {
            tabId, url,
            canGoBack:    view.webContents.canGoBack(),
            canGoForward: view.webContents.canGoForward(),
        });
        _checkCwsUrl(url);
        if (url && !url.startsWith('about:') && profile) {
            const _sess = session.fromPartition(`persist:${profile.id}`);
            const _nd = { tabId: view.webContents.id, url, timeStamp: Date.now(), frameId: 0 };
            dispatchTabEvent(_sess, 'webNavigation.onCommitted',        { ..._nd, transitionType: 'link' });
            dispatchTabEvent(_sess, 'webNavigation.onDOMContentLoaded', _nd);
            dispatchTabEvent(_sess, 'webNavigation.onCompleted',        _nd);
        }
    });

    view.webContents.on('did-navigate-in-page', (_e, url) => {
        win.webContents.send('tab-update', { tabId, url });
        if (url && !url.startsWith('about:') && profile) {
            const _sess = session.fromPartition(`persist:${profile.id}`);
            dispatchTabEvent(_sess, 'onUpdated', view.webContents.id,
                { status: 'complete', url }, { ...makeExtTabInfo(view, win), url });
            const _nd = { tabId: view.webContents.id, url, timeStamp: Date.now(), frameId: 0 };
            dispatchTabEvent(_sess, 'webNavigation.onHistoryStateUpdated', { ..._nd, transitionType: 'link' });
            dispatchTabEvent(_sess, 'webNavigation.onCompleted',           _nd);
        }
        _checkCwsUrl(url);
    });

    view.webContents.on('page-favicon-updated', (_e, favicons) => {
        if (favicons.length > 0) win.webContents.send('tab-update', { tabId, favicon: favicons[0] });
    });

    view.webContents.on('did-start-loading', () => {
        win.webContents.send('tab-update', { tabId, loading: true });
        const _sess = session.fromPartition(`persist:${profile.id}`);
        dispatchTabEvent(_sess, 'onUpdated', view.webContents.id,
            { status: 'loading' }, { ...makeExtTabInfo(view, win), status: 'loading' });
    });

    view.webContents.on('did-stop-loading', () => {
        win.webContents.send('tab-update', { tabId, loading: false });
        const url   = view.webContents.getURL();
        const title = view.webContents.getTitle();
        if (state.browserHistory.length > 0 && state.browserHistory[0].url === url) state.browserHistory[0].title = title;
        _checkCwsUrl(url);
        if (url && !url.startsWith('about:')) {
            const _sess = session.fromPartition(`persist:${profile.id}`);
            dispatchTabEvent(_sess, 'onUpdated', view.webContents.id,
                { status: 'complete', url }, { ...makeExtTabInfo(view, win), url });
        }
    });

    view.webContents.setWindowOpenHandler(({ url }) => {
        createNewTab(win, url);
        return { action: 'deny' };
    });

    // ── Right-click context menu ──────────────────────────────────
    view.webContents.on('context-menu', (_e, p) => {
        const items = [];

        items.push(
            { label: 'Назад',    enabled: view.webContents.canGoBack(),    click: () => view.webContents.goBack()    },
            { label: 'Вперед',   enabled: view.webContents.canGoForward(), click: () => view.webContents.goForward() },
            { label: 'Оновити',  click: () => view.webContents.reload()  },
            { type: 'separator' },
        );

        if (p.linkURL) {
            items.push(
                { label: 'Відкрити посилання в новій вкладці', click: () => createNewTab(win, p.linkURL) },
                { label: 'Копіювати адресу посилання',         click: () => clipboard.writeText(p.linkURL) },
                { type: 'separator' },
            );
        }

        if (p.mediaType === 'image' && p.srcURL) {
            items.push(
                { label: 'Відкрити зображення в новій вкладці', click: () => createNewTab(win, p.srcURL) },
                { label: 'Зберегти зображення як...',            click: () => view.webContents.downloadURL(p.srcURL) },
                { label: 'Копіювати адресу зображення',          click: () => clipboard.writeText(p.srcURL) },
                { type: 'separator' },
            );
        }

        if ((p.mediaType === 'video' || p.mediaType === 'audio') && p.srcURL) {
            items.push(
                { label: 'Копіювати адресу медіа', click: () => clipboard.writeText(p.srcURL) },
                { label: 'Зберегти медіа як...',   click: () => view.webContents.downloadURL(p.srcURL) },
                { type: 'separator' },
            );
        }

        if (p.selectionText) {
            const trCfg = require('./config').globalConfig.translator || {};
            const tl    = trCfg.targetLang || 'uk';
            const TNAMES = { uk:'українську',en:'англійську',de:'німецьку',fr:'французьку',
                             es:'іспанську', pl:'польську',  ru:'російську',zh:'китайську',
                             ja:'японську',  ko:'корейську', ar:'арабську', tr:'турецьку' };
            items.push(
                { label: 'Копіювати',                                        click: () => view.webContents.copy()            },
                { label: `Перекласти на ${TNAMES[tl] || tl}`,               click: async () => {
                    try {
                        const res = await net.fetch(
                            `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${tl}&dt=t&q=${encodeURIComponent(p.selectionText)}`,
                            { headers: { 'User-Agent': 'Mozilla/5.0' } }
                        );
                        const data = await res.json();
                        const out  = data[0]?.map(x => x[0]).filter(Boolean).join('') || '';
                        if (out) view.webContents.executeJavaScript(
                            `(function(){const d=document.createElement('div');` +
                            `d.style='position:fixed;bottom:24px;right:24px;z-index:2147483647;` +
                            `background:#1e1e2e;border:1px solid #45475a;border-radius:10px;` +
                            `padding:12px 16px;color:#cdd6f4;font-size:14px;max-width:360px;` +
                            `box-shadow:0 8px 24px rgba(0,0,0,.6);font-family:sans-serif;' ;` +
                            `d.textContent=${JSON.stringify(out)};document.body.appendChild(d);` +
                            `setTimeout(()=>d.remove(),5000);})()`
                        ).catch(() => {});
                    } catch {}
                }},
                { label: `Знайти "${p.selectionText.slice(0, 30)}"`,         click: () => createNewTab(win, p.selectionText) },
                { type: 'separator' },
            );
        }

        if (p.isEditable) {
            items.push(
                { label: 'Вирізати',       enabled: p.editFlags.canCut,   click: () => view.webContents.cut()   },
                { label: 'Копіювати',      enabled: p.editFlags.canCopy,  click: () => view.webContents.copy()  },
                { label: 'Вставити',       enabled: p.editFlags.canPaste, click: () => view.webContents.paste() },
                { label: 'Видалити',       enabled: p.editFlags.canDelete,click: () => view.webContents.delete()},
                { type: 'separator' },
                { label: 'Виділити все',   enabled: p.editFlags.canSelectAll, click: () => view.webContents.selectAll() },
                { type: 'separator' },
            );
        }

        items.push(
            { label: 'Зберегти сторінку як...', click: () => view.webContents.savePage(
                require('path').join(require('electron').app.getPath('downloads'), (view.webContents.getTitle() || 'page') + '.html'),
                'HTMLComplete'
            ).catch(() => {}) },
            { label: 'Копіювати URL сторінки', click: () => clipboard.writeText(view.webContents.getURL()) },
            { label: 'Переглянути код сторінки', click: () => createNewTab(win, 'view-source:' + view.webContents.getURL()) },
            { type: 'separator' },
            { label: 'Інструменти розробника', click: () => view.webContents.openDevTools() },
        );

        // Extension context menu items
        if (profile) {
            const _sess2 = session.fromPartition(`persist:${profile.id}`);
            const { getExtContextMenuItems, dispatchContextMenuClicked, makeExtTabInfo: _mti } = require('./extensions');
            const extItems = getExtContextMenuItems(_sess2, p);
            if (extItems.length > 0) {
                while (items.length && items[items.length - 1].type === 'separator') items.pop();
                items.push({ type: 'separator' });
                for (const { extId, extName, item, children } of extItems) {
                    const buildItem = (it) => ({
                        label:   it.title || String(it.id),
                        enabled: it.enabled !== false,
                        click: () => {
                            const info = {
                                menuItemId:      it.id,
                                parentMenuItemId: it.parentId || undefined,
                                pageUrl:         view.webContents.getURL(),
                                linkUrl:         p.linkURL      || undefined,
                                srcUrl:          p.srcURL       || undefined,
                                selectionText:   p.selectionText || undefined,
                                frameUrl:        p.frameURL     || undefined,
                            };
                            dispatchContextMenuClicked(_sess2, extId, info, _mti(view, win));
                        },
                        ...(children.length ? { submenu: children.map(buildItem) } : {}),
                    });
                    items.push(buildItem(item));
                }
            }
        }

        while (items.length && items[items.length - 1].type === 'separator') items.pop();

        Menu.buildFromTemplate(items).popup({ window: win });
    });

    // ── Find-in-page ─────────────────────────────────────────────
    view.webContents.on('found-in-page', (_e2, result) => {
        try { if (!win.isDestroyed()) win.webContents.send('find-result', result); } catch {}
    });

    // ── Keyboard shortcuts ────────────────────────────────────────
    view.webContents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown') return;
        const ctrl  = input.modifiers.includes('control');
        const shift = input.modifiers.includes('shift');
        const alt   = input.modifiers.includes('alt');
        const key   = input.key;

        if (key === 'F5' && !ctrl && !alt) {
            event.preventDefault();
            view.webContents.isLoading() ? view.webContents.stop() : view.webContents.reload();
            return;
        }
        if (ctrl && !shift && key === 'r') {
            event.preventDefault();
            view.webContents.isLoading() ? view.webContents.stop() : view.webContents.reload();
            return;
        }
        if (ctrl && shift && (key === 'R' || key === 'r')) {
            event.preventDefault();
            view.webContents.reloadIgnoringCache();
            return;
        }
        if (alt && key === 'ArrowLeft') {
            event.preventDefault();
            if (view.webContents.canGoBack()) view.webContents.goBack();
            return;
        }
        if (alt && key === 'ArrowRight') {
            event.preventDefault();
            if (view.webContents.canGoForward()) view.webContents.goForward();
            return;
        }
        if (ctrl && !shift && key === 't') {
            event.preventDefault();
            createNewTab(win);
            return;
        }
        if (ctrl && !shift && key === 'w') {
            event.preventDefault();
            closeTab(win, tabId);
            return;
        }
        if (ctrl && shift && (key === 'T' || key === 't')) {
            event.preventDefault();
            try { if (!win.isDestroyed()) win.webContents.send('shortcut-restore-tab'); } catch {}
            return;
        }
        if (ctrl && !shift && key === 'Tab') {
            event.preventDefault();
            const ids = [...state.getTabs(win).keys()];
            if (ids.length > 1) switchTab(win, ids[(ids.indexOf(tabId) + 1) % ids.length]);
            return;
        }
        if (ctrl && shift && key === 'Tab') {
            event.preventDefault();
            const ids = [...state.getTabs(win).keys()];
            if (ids.length > 1) switchTab(win, ids[(ids.indexOf(tabId) - 1 + ids.length) % ids.length]);
            return;
        }
        if (ctrl && key >= '1' && key <= '8') {
            event.preventDefault();
            const ids = [...state.getTabs(win).keys()];
            switchTab(win, ids[Math.min(parseInt(key) - 1, ids.length - 1)]);
            return;
        }
        if (ctrl && key === '9') {
            event.preventDefault();
            const ids = [...state.getTabs(win).keys()];
            switchTab(win, ids[ids.length - 1]);
            return;
        }
        if (key === 'F12') {
            event.preventDefault();
            view.webContents.openDevTools();
            return;
        }
        if (ctrl && shift && (key === 'I' || key === 'i')) {
            event.preventDefault();
            view.webContents.openDevTools();
            return;
        }
        if (ctrl && !shift && key === 'f') {
            event.preventDefault();
            try { if (!win.isDestroyed()) win.webContents.send('shortcut-find'); } catch {}
            return;
        }
        if (ctrl && !shift && (key === 'l' || key === 'k')) {
            event.preventDefault();
            try { if (!win.isDestroyed()) win.webContents.send('shortcut-focus-address'); } catch {}
            return;
        }
        if (ctrl && !shift && key === 'd') {
            event.preventDefault();
            try { if (!win.isDestroyed()) win.webContents.send('shortcut-bookmark'); } catch {}
            return;
        }
        if (ctrl && !shift && key === 'h') {
            event.preventDefault();
            try { if (!win.isDestroyed()) win.webContents.send('shortcut-history'); } catch {}
            return;
        }
        if (ctrl && !shift && key === 'u') {
            event.preventDefault();
            createNewTab(win, 'view-source:' + view.webContents.getURL());
            return;
        }
        if (ctrl && !shift && key === 'n') {
            event.preventDefault();
            const profile = state.getProfile(win);
            if (profile) {
                const { createWindow } = require('./windows');
                createWindow(profile, { fresh: true });
            }
            return;
        }
    });
}

// ── Tab lifecycle ─────────────────────────────────────────────────
function navigateTab(win, tabId, rawUrl) {
    const tabs = state.getTabs(win);
    const tab  = tabs.get(tabId);
    if (!tab) return;

    const url     = buildUrl(win, rawUrl);
    const profile = state.getProfile(win);

    if (!tab.view) {
        const profileConfig = {
            os:             profile.os || 'win11',
            browserVersion: profile.browserVersion || 'chrome120',
            fingerprint:    profile.fingerprint || { canvas: true, webgl: true, audioContext: true, geolocation: true },
            dnt:            !!profile.dnt,
            fonts:          profile.fonts !== false,
            timezone:       profile.timezone || 'auto',
            timezoneValue:  profile.timezoneValue || 'Europe/Kyiv',
        };

        const view = new BrowserView({
            backgroundColor: '#121212',
            webPreferences: {
                preload:                path.join(__dirname, '..', 'antidetect.js'),
                contextIsolation:       false,
                nodeIntegration:        false,
                partition:              `persist:${profile.id}`,
                webrtcIPHandlingPolicy: 'disable_non_proxied_udp',
                additionalArguments:    [`--defis-profile=${encodeURIComponent(JSON.stringify(profileConfig))}`],
            },
        });
        tab.view = view;
        win.addBrowserView(view);
        const { buildUA } = require('./proxy');
        view.webContents.setUserAgent(buildUA(profile));
        setupViewEvents(win, tabId, view);

        if (require('./config').globalConfig.devMode) {
            view.webContents.once('dom-ready', () => {
                if (!view.webContents.isDestroyed()) {
                    view.webContents.openDevTools({ mode: 'detach' });
                }
            });
        }

        const { configureSessionForExtensions } = require('./extensions');
        configureSessionForExtensions(session.fromPartition(`persist:${profile.id}`));

        if (tabId === state.getActiveId(win)) {
            const overlayOpen = (state.windowOverlayCount.get(win.id) || 0) > 0;
            if (!overlayOpen) view.setBounds(getViewBounds(win));
            win.setTopBrowserView(view);
        }
    }

    tab.view.webContents.loadURL(url);
}

function createNewTab(win, url) {
    state.tabCounter++;
    const tabId = state.tabCounter;
    state.getTabs(win).set(tabId, { view: null });
    state.windowActive.set(win.id, tabId);

    if (url) {
        navigateTab(win, tabId, url);
    } else {
        setActiveView(win, tabId);
    }

    win.webContents.send('tab-created',        { tabId, title: 'Нова вкладка', url: url || '' });
    win.webContents.send('active-tab-changed', { tabId, url: url || '', canGoBack: false, canGoForward: false });
    return tabId;
}

function switchTab(win, tabId) {
    if (!state.getTabs(win).has(tabId)) return;
    state.windowActive.set(win.id, tabId);
    setActiveView(win, tabId);

    const tab = state.getTabs(win).get(tabId);
    const url = tab.view ? tab.view.webContents.getURL() : '';
    win.webContents.send('active-tab-changed', {
        tabId, url,
        canGoBack:    tab.view ? tab.view.webContents.canGoBack()    : false,
        canGoForward: tab.view ? tab.view.webContents.canGoForward() : false,
    });

    {
        const cwsM = url.match(/chromewebstore\.google\.com\/detail\/[^/?#]*\/([a-z]{32})(?:[/?#]|$)/i);
        if (cwsM) {
            const extId    = cwsM[1].toLowerCase();
            const rawTitle = tab.view?.webContents.getTitle() || '';
            const name     = rawTitle.replace(/\s*[-–]\s*Chrome Web Store\s*$/i, '').trim() || extId;
            win.webContents.send('cws-ext-detected', { extId, name });
        } else {
            win.webContents.send('cws-ext-detected', null);
        }
    }

    const _swTab = state.getTabs(win).get(tabId);
    if (_swTab?.view && !_swTab.view.webContents.isDestroyed()) {
        const _prof = state.getProfile(win);
        if (_prof) {
            const _sess = session.fromPartition(`persist:${_prof.id}`);
            const { dispatchTabEvent } = require('./extensions');
            dispatchTabEvent(_sess, 'onActivated',
                { tabId: _swTab.view.webContents.id, windowId: win.id });
        }
    }
}

function closeTab(win, tabId) {
    const tab = state.getTabs(win).get(tabId);
    if (!tab) return;
    if (tab.view) { win.removeBrowserView(tab.view); tab.view.webContents.destroy(); }
    state.getTabs(win).delete(tabId);
    win.webContents.send('tab-closed', { tabId });

    if (state.getTabs(win).size === 0) {
        createNewTab(win);
    } else if (state.getActiveId(win) === tabId) {
        const ids = Array.from(state.getTabs(win).keys());
        switchTab(win, ids[ids.length - 1]);
    }
}

// ── IPC ───────────────────────────────────────────────────────────
function registerTabIPC(ipcMain) {
    // Init
    ipcMain.on('request-init', (e) => {
        const win     = state.getWin(e);
        const profile = state.getProfile(win);
        e.sender.send('set-profile', profile);
        e.sender.send('sync-status', { connected: state.serverConnected, lastSync: state.lastSyncTime });
        if (state.getTabs(win).size === 0) {
            const url = state.pendingUrls.get(win.id);
            state.pendingUrls.delete(win.id);
            createNewTab(win, url || null);
        }
    });

    // Tabs
    ipcMain.on('new-tab',    (e, url)   => { const w = state.getWin(e); createNewTab(w, url); });
    ipcMain.on('switch-tab', (e, tabId) => { const w = state.getWin(e); switchTab(w, tabId); });
    ipcMain.on('close-tab',  (e, tabId) => { const w = state.getWin(e); closeTab(w, tabId); });

    // Duplicate tab
    ipcMain.on('duplicate-tab', (e, tabId) => {
        const win = state.getWin(e);
        const tab = state.getTabs(win).get(tabId);
        const url = tab?.view?.webContents.getURL() || tab?.url || null;
        createNewTab(win, url);
    });

    // Reload specific tab
    ipcMain.on('reload-tab', (e, tabId) => {
        const win = state.getWin(e);
        const tab = state.getTabs(win).get(tabId);
        if (!tab?.view) return;
        tab.view.webContents.isLoading()
            ? tab.view.webContents.stop()
            : tab.view.webContents.reload();
    });

    // Copy tab URL to clipboard
    ipcMain.on('copy-tab-url', (e, tabId) => {
        const win = state.getWin(e);
        const tab = state.getTabs(win).get(tabId);
        const url = tab?.view?.webContents.getURL() || tab?.url || '';
        if (url) clipboard.writeText(url);
    });
    ipcMain.on('navigate',   (e, { url }) => {
        const w = state.getWin(e);
        const t = state.getActiveId(w);
        if (t != null) navigateTab(w, t, url);
    });

    // Navigation
    ipcMain.on('go-back', (e) => {
        const tab = state.getTabs(state.getWin(e)).get(state.getActiveId(state.getWin(e)));
        if (tab?.view?.webContents.canGoBack()) tab.view.webContents.goBack();
    });
    ipcMain.on('go-forward', (e) => {
        const tab = state.getTabs(state.getWin(e)).get(state.getActiveId(state.getWin(e)));
        if (tab?.view?.webContents.canGoForward()) tab.view.webContents.goForward();
    });
    ipcMain.on('reload', (e) => {
        const tab = state.getTabs(state.getWin(e)).get(state.getActiveId(state.getWin(e)));
        if (!tab?.view) return;
        tab.view.webContents.isLoading() ? tab.view.webContents.stop() : tab.view.webContents.reload();
    });

    // Search engine
    ipcMain.on('set-search-engine', (e, engine) => state.searchEngines.set(state.getWin(e).id, engine));

    // Page screenshot
    ipcMain.handle('capture-active-page', async (e) => {
        const win  = state.getWin(e);
        const view = getActiveBrowserView(win);
        if (!view || view.webContents.isDestroyed()) return null;
        try {
            const img = await view.webContents.capturePage();
            return img.toDataURL();
        } catch { return null; }
    });

    // Overlay
    ipcMain.on('overlay-open', (e) => {
        const win   = state.getWin(e);
        const count = (state.windowOverlayCount.get(win.id) || 0) + 1;
        state.windowOverlayCount.set(win.id, count);
        if (count === 1) overlayShow(win);
    });
    ipcMain.on('overlay-close', (e) => {
        const win   = state.getWin(e);
        const count = Math.max(0, (state.windowOverlayCount.get(win.id) || 0) - 1);
        state.windowOverlayCount.set(win.id, count);
        if (count === 0) overlayHide(win);
    });

    // Navigation extras
    ipcMain.on('hard-reload', (e) => {
        const tab = state.getTabs(state.getWin(e)).get(state.getActiveId(state.getWin(e)));
        if (tab?.view?.webContents) tab.view.webContents.reloadIgnoringCache();
    });
    ipcMain.on('view-source', (e) => {
        const win = state.getWin(e);
        const tab = state.getTabs(win).get(state.getActiveId(win));
        if (tab?.view) createNewTab(win, 'view-source:' + tab.view.webContents.getURL());
    });

    // Find-in-page
    ipcMain.on('find-bar-open', (e) => {
        const win = state.getWin(e);
        state.windowFindBarOpen.set(win.id, true);
        const view = getActiveBrowserView(win);
        if (view && (state.windowOverlayCount.get(win.id) || 0) === 0) view.setBounds(getViewBounds(win));
    });
    ipcMain.on('find-bar-close', (e) => {
        const win = state.getWin(e);
        state.windowFindBarOpen.set(win.id, false);
        const tab = state.getTabs(win).get(state.getActiveId(win));
        if (tab?.view?.webContents) tab.view.webContents.stopFindInPage('clearSelection');
        const view = getActiveBrowserView(win);
        if (view && (state.windowOverlayCount.get(win.id) || 0) === 0) view.setBounds(getViewBounds(win));
    });
    ipcMain.on('find-in-page', (e, { query, options }) => {
        const tab = state.getTabs(state.getWin(e)).get(state.getActiveId(state.getWin(e)));
        if (tab?.view?.webContents && query) tab.view.webContents.findInPage(query, options || {});
    });

    // Panels
    ipcMain.on('notepad-open', (e) => {
        const win = state.getWin(e);
        state.windowNotepadOpen.set(win.id, true);
        const view = getActiveBrowserView(win);
        if (view && (state.windowOverlayCount.get(win.id) || 0) === 0) view.setBounds(getViewBounds(win));
    });
    ipcMain.on('notepad-close', (e) => {
        const win = state.getWin(e);
        state.windowNotepadOpen.set(win.id, false);
        const view = getActiveBrowserView(win);
        if (view && (state.windowOverlayCount.get(win.id) || 0) === 0) view.setBounds(getViewBounds(win));
    });
    ipcMain.on('agent-open', (e) => {
        const win = state.getWin(e);
        state.windowAgentOpen.set(win.id, true);
        const view = getActiveBrowserView(win);
        if (view && (state.windowOverlayCount.get(win.id) || 0) === 0) view.setBounds(getViewBounds(win));
    });
    ipcMain.on('agent-close', (e) => {
        const win = state.getWin(e);
        state.windowAgentOpen.set(win.id, false);
        const view = getActiveBrowserView(win);
        if (view && (state.windowOverlayCount.get(win.id) || 0) === 0) view.setBounds(getViewBounds(win));
    });

    // Agent
    ipcMain.on('agent-start', (e, { task }) => {
        const win      = state.getWin(e);
        const agentCfg = require('./config').globalConfig?.agent || {};
        const provider = agentCfg.provider || 'anthropic';
        const apiKey   = provider === 'gemini' ? agentCfg.geminiApiKey : agentCfg.apiKey;

        if (!apiKey) {
            const label = provider === 'gemini' ? 'Gemini API ключ' : 'Anthropic API ключ';
            win.webContents.send('agent-event', { type: 'error', text: `${label} не налаштовано. Відкрийте Налаштування → AI Агент.` });
            return;
        }

        const defaultModel = provider === 'gemini' ? 'gemini-2.0-flash' : 'claude-sonnet-4-6';
        const model   = (provider === 'gemini' ? agentCfg.geminiModel : agentCfg.model) || defaultModel;
        const getView = () => state.getTabs(win).get(state.getActiveId(win))?.view;
        require('../defis-agent').startAgent(win, getView, task, apiKey, model, provider);
    });

    ipcMain.handle('fetch-gemini-models', async (_e, { apiKey }) => {
        try {
            return { ok: true, models: await require('../defis-agent').fetchGeminiModels(apiKey) };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.on('agent-stop', (e) => {
        require('../defis-agent').stopAgent(state.getWin(e));
    });

    // Proxy check
    ipcMain.handle('check-proxy', async (_e, profileId) => {
        const { profiles } = require('./profiles');
        const { applyProxy, checkProxyForProfile } = require('./proxy');
        const profile = profileId ? profiles.find(p => p.id === profileId) : null;
        if (!profile) return { ok: false, error: 'Profile not found' };
        await applyProxy(profile);
        return checkProxyForProfile(profile);
    });

    // Restart profile
    ipcMain.handle('restart-profile', async (e) => {
        const win     = state.getWin(e);
        const profile = state.getProfile(win);
        if (!win || !profile) return { ok: false };
        const profilesMod = require('./profiles');
        try {
            await profilesMod.loadProfiles();
            const updated = profilesMod.profiles.find(p => p.id === profile.id);
            if (updated) Object.assign(profile, updated);
        } catch {}
        const { loadCookiesForProfile } = require('./cookies');
        const { loadExtensionsForProfile, reloadAllTabs } = require('./extensions');
        await loadCookiesForProfile(profile).catch(() => {});
        await loadExtensionsForProfile(profile).catch(() => {});
        reloadAllTabs(win);
        win.webContents.send('set-profile', profile);
        win.webContents.send('profile-restarted');
        return { ok: true };
    });

    // Open extra window
    ipcMain.handle('open-extra-window', async (e, { url } = {}) => {
        const win     = state.getWin(e);
        const profile = state.getProfile(win);
        if (!profile) return { ok: false };
        const { createWindow } = require('./windows');
        const newWin = createWindow(profile, { fresh: true });
        if (url) state.pendingUrls.set(newWin.id, url);
        return { ok: true };
    });
}

module.exports = {
    buildUrl, getViewBounds, getActiveBrowserView,
    overlayShow, overlayHide, setActiveView,
    setupViewEvents, navigateTab, createNewTab, switchTab, closeTab,
    registerTabIPC,
};
