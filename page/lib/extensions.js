'use strict';
const { app, BrowserWindow, session, webContents, net, Notification } = require('electron');
const path   = require('path');
const fs     = require('fs');
const AdmZip = require('adm-zip');

const state = require('./state');

// ── Constants ─────────────────────────────────────────────────────
// Chrome-specific permissions that Electron/Chromium doesn't recognise as valid manifest entries.
const ELECTRON_UNSUPPORTED_PERMS = new Set([
    'identity', 'enterprise.platformKeys', 'fileBrowserHandler', 'gcm',
    'platformKeys', 'vpnProvider', 'certificateProvider', 'webAuthenticationProxy',
]);

// Extension directory — set by setExtensionsDir() during startApp()
let EXTENSIONS_DIR = '';
function setExtensionsDir(dir) { EXTENSIONS_DIR = dir; }

// ── CRX3 extraction ───────────────────────────────────────────────
function crx3ToZip(buf) {
    if (buf.toString('ascii', 0, 4) !== 'Cr24') throw new Error('Not a CRX3 file');
    const headerSize = buf.readUInt32LE(8);
    return buf.slice(12 + headerSize);
}

// ── i18n ─────────────────────────────────────────────────────────
function resolveI18nString(str, extDir, defaultLocale) {
    if (!str || !str.startsWith('__MSG_')) return str;
    const key = str.slice(6, -2);
    for (const locale of [defaultLocale, 'en', 'uk', 'ru'].filter(Boolean)) {
        try {
            const msgs = JSON.parse(
                fs.readFileSync(path.join(extDir, '_locales', locale, 'messages.json'), 'utf8')
            );
            const found = Object.keys(msgs).find(k => k.toLowerCase() === key.toLowerCase());
            if (found && msgs[found]?.message) return msgs[found].message;
        } catch {}
    }
    return key;
}

// ── Manifest patching ─────────────────────────────────────────────
function patchExtensionManifest(extDir) {
    const manifestPath = path.join(extDir, 'manifest.json');
    try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        let changed = false;
        const mv = manifest.manifest_version || 2;

        if (!Array.isArray(manifest.permissions)) manifest.permissions = [];

        // Strip Chrome-only / unsupported named permissions (all MV versions).
        {
            const before = manifest.permissions.length;
            manifest.permissions = manifest.permissions.filter(p => !ELECTRON_UNSUPPORTED_PERMS.has(p));
            if (manifest.permissions.length !== before) changed = true;
        }

        // Strip URL patterns from permissions[] for MV3
        if (mv === 3) {
            const before = manifest.permissions.length;
            manifest.permissions = manifest.permissions.filter(p => !/[/*]/.test(p) && p !== '<all_urls>');
            if (manifest.permissions.length !== before) changed = true;
        }

        // For MV2 add URL patterns to permissions[]
        if (mv === 2) {
            const permsSet = new Set(manifest.permissions);
            for (const p of ['http://*/*', 'https://*/*', '*://*/*']) {
                if (!permsSet.has(p)) { manifest.permissions.push(p); changed = true; }
            }
            const before = manifest.permissions.length;
            manifest.permissions = manifest.permissions.filter(p => p !== '<all_urls>');
            if (manifest.permissions.length !== before) changed = true;
        }

        // MV3 — host_permissions
        if (mv === 3) {
            if (!Array.isArray(manifest.host_permissions)) manifest.host_permissions = [];
            const hpSet = new Set(manifest.host_permissions);
            if (!hpSet.has('<all_urls>')) {
                manifest.host_permissions.unshift('<all_urls>');
                changed = true;
            }
        }

        // optional_permissions[]
        if (Array.isArray(manifest.optional_permissions)) {
            const before = manifest.optional_permissions.length;
            manifest.optional_permissions = manifest.optional_permissions.filter(
                p => !ELECTRON_UNSUPPORTED_PERMS.has(p) && !/[/*]/.test(p) && p !== '<all_urls>'
            );
            if (manifest.optional_permissions.length !== before) changed = true;
        }

        // optional_host_permissions[]
        if (mv === 3 && Array.isArray(manifest.optional_host_permissions)) {
            const hpSet = new Set(manifest.host_permissions || []);
            if (hpSet.has('<all_urls>')) {
                const before = manifest.optional_host_permissions.length;
                manifest.optional_host_permissions = manifest.optional_host_permissions.filter(
                    p => !/[/*]/.test(p) && p !== '<all_urls>'
                );
                if (manifest.optional_host_permissions.length !== before) changed = true;
            }
        }

        // content_scripts
        if (Array.isArray(manifest.content_scripts)) {
            for (const cs of manifest.content_scripts) {
                if (!Array.isArray(cs.matches)) cs.matches = [];
                const before = cs.matches.length;
                cs.matches = cs.matches.filter(m => m !== '<all_urls>' && m !== '*://*/*');
                if (cs.matches.length !== before) changed = true;
                for (const pat of ['https://*/*', 'http://*/*']) {
                    if (!cs.matches.includes(pat)) { cs.matches.push(pat); changed = true; }
                }
            }
        }

        // Revert old SW shim if present
        if (mv === 3 && manifest.background?.page === '_defis_bg.html') {
            const bgHtmlPath = path.join(extDir, '_defis_bg.html');
            try {
                const bgHtml = fs.readFileSync(bgHtmlPath, 'utf8');
                const m = bgHtml.match(/<script(?:\s+type="module")?\s+src="([^"]+)"/);
                if (m) {
                    manifest.background.service_worker = m[1];
                    if (bgHtml.includes('type="module"')) manifest.background.type = 'module';
                    delete manifest.background.page;
                    changed = true;
                    console.log(`[ext] reverted SW shim: ${path.basename(extDir)}`);
                }
            } catch {}
            try { fs.unlinkSync(path.join(extDir, '_defis_bg.html')); } catch {}
        }

        // SW wrapper for non-module MV3 SWs
        const WRAPPER_NAME = 'defis-sw-init.js';
        const WRAPPER_META = 'defis-sw-meta.json';
        let swFile = manifest.background?.service_worker;
        const isModule = manifest.background?.type === 'module';

        let origSwFile = swFile;
        if (mv === 3 && swFile === WRAPPER_NAME && !isModule) {
            try {
                const meta = JSON.parse(fs.readFileSync(path.join(extDir, WRAPPER_META), 'utf8'));
                if (meta.origSw) origSwFile = meta.origSw;
            } catch { origSwFile = null; }
        }

        if (mv === 3 && origSwFile && !isModule && origSwFile !== WRAPPER_NAME) {
            const wrapperPath = path.join(extDir, WRAPPER_NAME);
            const wrapperMissing = !fs.existsSync(wrapperPath);
            const wrapperContent =
`// Auto-generated by DEFIS — stubs missing Chrome APIs in SW context (Electron 28)
(function() {
    if (typeof chrome === 'undefined') return;
    // Minimal event stub factory
    function _ev() { return { addListener: () => {}, removeListener: () => {}, hasListener: () => false, dispatch: () => {} }; }

    // storage.sync → local fallback (chrome.storage.sync not implemented in Electron 28 SWs)
    try {
        if (chrome.storage && chrome.storage.local) {
            const _loc = chrome.storage.local;
            try { Object.defineProperty(chrome.storage, 'sync', { get: () => _loc, configurable: true }); }
            catch { chrome.storage.sync = _loc; }
        }
    } catch {}

    // storage.onChanged relay: local → sync (so @plasmohq/storage area="sync" listeners fire)
    try {
        if (chrome.storage?.onChanged) {
            const _origOC = chrome.storage.onChanged;
            try {
                const _px = new Proxy(_origOC, {
                    get(t, p) {
                        if (p !== 'addListener') return Reflect.get(t, p);
                        return (fn) => t.addListener((changes, area) => {
                            fn(changes, area);
                            if (area === 'local') fn(changes, 'sync');
                        });
                    },
                });
                Object.defineProperty(chrome.storage, 'onChanged', { get: () => _px, configurable: true });
            } catch {
                const _origAdd = _origOC.addListener.bind(_origOC);
                _origOC.addListener = (fn) => _origAdd((c, a) => { fn(c, a); if (a === 'local') fn(c, 'sync'); });
            }
        }
    } catch {}

    // action / browserAction API stubs
    try {
        if (!chrome.action) chrome.action = {};
        const _a = chrome.action;
        if (!_a.onClicked)        _a.onClicked        = _ev();
        if (!_a.setBadgeText)     _a.setBadgeText     = () => Promise.resolve();
        if (!_a.setBadgeBackgroundColor) _a.setBadgeBackgroundColor = () => Promise.resolve();
        if (!_a.setIcon)          _a.setIcon          = () => Promise.resolve();
        if (!_a.setTitle)         _a.setTitle         = () => Promise.resolve();
        if (!_a.setPopup)         _a.setPopup         = () => Promise.resolve();
        if (!chrome.browserAction) chrome.browserAction = _a;
    } catch {}

    // tabs API — stubs + sendMessage relay via BroadcastChannel → ext-preload IPC
    try {
        if (!chrome.tabs) chrome.tabs = {};
        const _t = chrome.tabs;
        if (!_t.onUpdated)   _t.onUpdated   = _ev();
        if (!_t.onCreated)   _t.onCreated   = _ev();
        if (!_t.onRemoved)   _t.onRemoved   = _ev();
        if (!_t.onActivated) _t.onActivated = _ev();
        if (!_t.onReplaced)  _t.onReplaced  = _ev();
        if (!_t.query)  _t.query  = (q, cb) => { if (cb) cb([]); return Promise.resolve([]); };
        if (!_t.get)    _t.get    = (id, cb) => { if (cb) cb({}); return Promise.resolve({}); };
        if (!_t.update) _t.update = (id, p, cb) => { if (cb) cb({}); return Promise.resolve({}); };
        if (!_t.remove) _t.remove = (id, cb) => { if (cb) cb(); return Promise.resolve(); };
        if (!_t.create) _t.create = (p, cb) => {
            const url = typeof p === 'string' ? p : (p?.url || 'about:blank');
            try { fetch('defis-ipc://win-create', {method:'POST', body:JSON.stringify({props:{url,active:p?.active!==false}})}).catch(()=>{}); } catch {}
            const tab = { id: -1, url, active: true, index: 0, pinned: false, incognito: false };
            if (cb) cb(tab); return Promise.resolve(tab);
        };
        // sendMessage: direct to main process via defis-ipc:// (works even if no popup open)
        {
            _t.sendMessage = (tabId, message, optsOrCb, maybeCb) => {
                let callback;
                if (typeof optsOrCb === 'function') callback = optsOrCb;
                else if (typeof maybeCb === 'function') callback = maybeCb;
                const reqId = Math.random().toString(36).slice(2);
                const p = fetch('defis-ipc://tabs-send-msg', {
                    method: 'POST',
                    body: JSON.stringify({ tabId, message, reqId, extensionId: (chrome.runtime && chrome.runtime.id) || '' })
                }).then(r => r.json()).then(d => d && d.response).catch(() => undefined);
                p.then(r => { if (callback) callback(r); });
                return p;
            };
        }
    } catch {}

    // windows API — stubs + popup relay via BroadcastChannel
    try {
        if (!chrome.windows) chrome.windows = {};
        const _w = chrome.windows;
        if (!_w.getCurrent)     _w.getCurrent     = (p, cb) => { if (typeof p==='function') cb=p; if (cb) cb({ id:-1, focused:true, state:'normal', type:'normal' }); return Promise.resolve({ id:-1 }); };
        if (!_w.getLastFocused) _w.getLastFocused = (p, cb) => { if (typeof p==='function') cb=p; if (cb) cb({ id:-1, focused:true, state:'normal', type:'normal' }); return Promise.resolve({ id:-1 }); };
        if (!_w.remove)         _w.remove         = (id, cb) => { if (cb) cb(); return Promise.resolve(); };
        if (!_w.onCreated)      _w.onCreated      = _ev();
        if (!_w.onRemoved)      _w.onRemoved      = _ev();
        if (!_w.onFocusChanged) _w.onFocusChanged = _ev();
        // windows.create: direct to main process via defis-ipc://
        {
            _w.create = (props, cb) => {
                const urls = Array.isArray(props && props.url) ? props.url : (props && props.url ? [props.url] : []);
                fetch('defis-ipc://win-create', {method:'POST', body:JSON.stringify({props:props||{}})}).catch(()=>{});
                const win = { id: -1, tabs: urls.map(u => ({ id: -1, url: u, active: true })) };
                if (cb) setTimeout(() => cb(win), 0);
                return Promise.resolve(win);
            };
        }
    } catch {}

    // notifications API — create shows OS notification via defis-ipc://
    try {
        if (!chrome.notifications) chrome.notifications = {};
        const _nf = chrome.notifications;
        _nf.create = _nf.create || ((id, opts, cb) => {
            if (typeof id === 'object') { cb = opts; opts = id; id = ''; }
            const nid = id || Math.random().toString(36).slice(2);
            fetch('defis-ipc://notify', {method:'POST', body:JSON.stringify({title:(opts&&opts.title)||'',message:(opts&&opts.message)||'',iconUrl:(opts&&opts.iconUrl)||''})}).catch(()=>{});
            if (cb) cb(nid);
            return Promise.resolve(nid);
        });
        _nf.clear     = _nf.clear     || ((id, cb) => { if (cb) cb(true); return Promise.resolve(true); });
        _nf.update    = _nf.update    || ((id, opts, cb) => { if (cb) cb(true); return Promise.resolve(true); });
        _nf.getAll    = _nf.getAll    || ((cb) => { if (cb) cb({}); return Promise.resolve({}); });
        _nf.onClicked = _nf.onClicked || _ev();
        _nf.onClosed  = _nf.onClosed  || _ev();
    } catch {}

    // contextMenus — relay create/remove to main process via defis-ipc://
    try {
        if (!chrome.contextMenus) chrome.contextMenus = {};
        const _cm = chrome.contextMenus;
        const _cmExtId = (chrome.runtime && chrome.runtime.id) || '';
        function _cmRelay(msg) { try { fetch('defis-ipc://contextmenu', {method:'POST', body:JSON.stringify(msg)}).catch(()=>{}); } catch {} }
        _cm.create    = _cm.create    || ((props, cb) => { _cmRelay({ type: 'create', extId: _cmExtId, props: (typeof props === 'object' ? props : { title: props }) }); if (cb) cb(); });
        _cm.update    = _cm.update    || ((id, props, cb) => { _cmRelay({ type: 'update', extId: _cmExtId, id, props }); if (cb) cb(); });
        _cm.remove    = _cm.remove    || ((id, cb) => { _cmRelay({ type: 'remove', extId: _cmExtId, id }); if (cb) cb(); });
        _cm.removeAll = _cm.removeAll || ((cb) => { _cmRelay({ type: 'removeAll', extId: _cmExtId }); if (cb) cb(); });
        _cm.onClicked = _cm.onClicked || _ev();
    } catch {}

    // alarms API — real timers (setTimeout/setInterval)
    try {
        chrome.alarms = (() => {
            const _alarms = {}, _timers = {};
            const _onAlarm = _ev();
            function _fire(name) {
                const a = _alarms[name]; if (!a) return;
                _onAlarm.dispatch({ name, scheduledTime: a.scheduledTime });
                if (a.period) {
                    a.scheduledTime = Date.now() + a.period;
                    _timers[name] = setTimeout(() => _fire(name), a.period);
                } else { delete _alarms[name]; delete _timers[name]; }
            }
            return {
                create(name, info) {
                    if (typeof name !== 'string') { info = name; name = ''; }
                    clearTimeout(_timers[name]);
                    const delay = Math.max(1, ((info && info.delayInMinutes) || 0) * 60000 || Math.max(0, ((info && info.when) || 0) - Date.now()));
                    const period = ((info && info.periodInMinutes) || 0) * 60000;
                    _alarms[name] = { name, scheduledTime: Date.now() + delay, period };
                    _timers[name] = setTimeout(() => _fire(name), delay);
                },
                clear(name, cb) { clearTimeout(_timers[name]); delete _alarms[name]; delete _timers[name]; if (cb) cb(true); return Promise.resolve(true); },
                clearAll(cb) { Object.keys(_timers).forEach(n => { clearTimeout(_timers[n]); delete _alarms[n]; delete _timers[n]; }); if (cb) cb(true); return Promise.resolve(true); },
                get(name, cb) { if (typeof name === 'function') { cb = name; name = undefined; } const a = name != null ? _alarms[name] : undefined; if (cb) cb(a); return Promise.resolve(a); },
                getAll(cb) { const a = Object.values(_alarms); if (cb) cb(a); return Promise.resolve(a); },
                onAlarm: _onAlarm,
            };
        })();
    } catch {}

    // webNavigation stubs
    try {
        if (!chrome.webNavigation) chrome.webNavigation = {};
        const _n = chrome.webNavigation;
        ['onBeforeNavigate','onCommitted','onDOMContentLoaded','onCompleted','onErrorOccurred',
         'onCreatedNavigationTarget','onReferenceFragmentUpdated','onHistoryStateUpdated'].forEach(ev => {
            if (!_n[ev]) _n[ev] = _ev();
        });
    } catch {}

    // runtime stubs
    try {
        if (!chrome.runtime) chrome.runtime = {};
        const _r = chrome.runtime;
        if (!_r.onConnect)        _r.onConnect        = _ev();
        if (!_r.onConnectExternal) _r.onConnectExternal = _ev();
    } catch {}

    // permissions stubs — always grant (SW has no UI to prompt)
    try {
        if (!chrome.permissions) chrome.permissions = {};
        chrome.permissions.request  = chrome.permissions.request  || ((p, cb) => { if (cb) cb(true);  return Promise.resolve(true); });
        chrome.permissions.contains = chrome.permissions.contains || ((p, cb) => { if (cb) cb(false); return Promise.resolve(false); });
        chrome.permissions.remove   = chrome.permissions.remove   || ((p, cb) => { if (cb) cb(true);  return Promise.resolve(true); });
    } catch {}

    // identity — launchWebAuthFlow: try chrome.runtime.sendMessage (primary) then BroadcastChannel (fallback)
    try {
        if (!chrome.identity) chrome.identity = {};
        chrome.identity.getRedirectURL = chrome.identity.getRedirectURL ||
            ((path) => \`https://\${chrome.runtime?.id || ''}.chromiumapp.org/\${path || ''}\`);
        if (!chrome.identity.launchWebAuthFlow) {
            chrome.identity.launchWebAuthFlow = (details, callback) => {
                const _url = details?.url, _interactive = !!details?.interactive;
                const p = new Promise((resolve, reject) => {
                    function _done(resultUrl, err) {
                        if (err) {
                            try { chrome.runtime.lastError = { message: err }; } catch {}
                            if (callback) callback(undefined);
                            reject(new Error(err));
                        } else {
                            try { delete chrome.runtime.lastError; } catch {}
                            if (callback) callback(resultUrl);
                            resolve(resultUrl);
                        }
                    }
                    function _tryBroadcastChannel() {
                        try {
                            const channel = new BroadcastChannel('defis-identity-auth');
                            const reqId = Math.random().toString(36).slice(2);
                            const timer = setTimeout(() => {
                                channel.close();
                                _done(undefined, 'Auth relay timeout — no popup open');
                            }, 300000);
                            channel.onmessage = (ev) => {
                                if (ev.data?.reqId !== reqId) return;
                                clearTimeout(timer); channel.close();
                                _done(ev.data.error ? undefined : ev.data.url, ev.data.error);
                            };
                            channel.postMessage({ reqId, url: _url, interactive: _interactive });
                        } catch (e) { _done(undefined, e.message); }
                    }
                    try {
                        chrome.runtime.sendMessage(
                            { _defisType: 'launchWebAuthFlow', url: _url, interactive: _interactive },
                            (response) => {
                                if (chrome.runtime.lastError || !response) {
                                    _tryBroadcastChannel();
                                    return;
                                }
                                _done(response.error ? undefined : response.url, response.error);
                            }
                        );
                    } catch { _tryBroadcastChannel(); }
                });
                return p;
            };
        }
    } catch {}
})();
importScripts(${JSON.stringify(origSwFile)});
`;
            const existingWrapper = !wrapperMissing ? (() => { try { return fs.readFileSync(wrapperPath, 'utf8'); } catch { return null; } })() : null;
            if (wrapperMissing || swFile !== WRAPPER_NAME || existingWrapper !== wrapperContent) {
                try {
                    fs.writeFileSync(wrapperPath, wrapperContent, 'utf8');
                    fs.writeFileSync(path.join(extDir, WRAPPER_META), JSON.stringify({ origSw: origSwFile }), 'utf8');
                    manifest.background.service_worker = WRAPPER_NAME;
                    changed = true;
                    console.log(`[ext] SW wrapper ${wrapperMissing ? 'recreated' : (swFile !== WRAPPER_NAME ? 'created' : 'updated')}: ${path.basename(extDir)}`);
                } catch (e) {
                    console.error('[ext] SW wrapper write failed:', e.message);
                }
            }
        }

        // Inject isolated-world API polyfill as first content script
        {
            const POLYFILL_CS_NAME = 'defis-content-polyfill.js';
            const polyfillSrc      = path.join(__dirname, '..', 'content-api-polyfill.js');
            const polyfillDest     = path.join(extDir, POLYFILL_CS_NAME);
            try {
                const srcContent  = fs.readFileSync(polyfillSrc, 'utf8');
                const destContent = fs.existsSync(polyfillDest) ? fs.readFileSync(polyfillDest, 'utf8') : null;
                if (srcContent !== destContent) fs.writeFileSync(polyfillDest, srcContent, 'utf8');
            } catch {}
            if (!manifest.content_scripts) manifest.content_scripts = [];
            const hasPolyfill = manifest.content_scripts.some(
                cs => Array.isArray(cs.js) && cs.js.includes(POLYFILL_CS_NAME) && cs.run_at === 'document_start'
            );
            if (!hasPolyfill) {
                manifest.content_scripts.unshift({
                    matches: ['https://*/*', 'http://*/*'],
                    js: [POLYFILL_CS_NAME],
                    run_at: 'document_start',
                });
                if (changed) {
                    console.log(`[ext] polyfill added (with reload): ${path.basename(extDir)}`);
                } else {
                    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
                    console.log(`[ext] polyfill queued (next start): ${path.basename(extDir)}`);
                    return false;
                }
            }
        }

        if (changed) {
            fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
            console.log(`[ext] patched manifest: ${path.basename(extDir)}`);
        }
        return changed;
    } catch (e) {
        console.error('patchExtensionManifest:', e.message);
        return false;
    }
}

// ── Context menu items store ──────────────────────────────────────
const _contextMenuItems = new Map(); // extId → Map<id, item>

function registerContextMenuItem(extId, props) {
    if (!_contextMenuItems.has(extId)) _contextMenuItems.set(extId, new Map());
    const id = String(props.id != null ? props.id : Math.random().toString(36).slice(2));
    _contextMenuItems.get(extId).set(id, { ...props, id });
    return id;
}
function removeContextMenuItem(extId, id) {
    _contextMenuItems.get(extId)?.delete(String(id));
}
function removeAllContextMenuItems(extId) {
    _contextMenuItems.delete(extId);
}
function getExtContextMenuItems(sess, params) {
    const results = [];
    const extById = new Map(sess.getAllExtensions().map(e => [e.id, e]));
    for (const [extId, menus] of _contextMenuItems) {
        const ext = extById.get(extId);
        if (!ext) continue;
        for (const item of menus.values()) {
            if (item.parentId != null) continue; // top-level only
            if (!_ctxItemMatches(item, params)) continue;
            const children = [...menus.values()].filter(c => String(c.parentId) === String(item.id));
            results.push({ extId, extName: ext.name, item, children });
        }
    }
    return results;
}
function _ctxItemMatches(item, params) {
    const contexts = item.contexts || ['page'];
    for (const ctx of contexts) {
        if (ctx === 'all' || ctx === 'page') return true;
        if (ctx === 'selection' && params.selectionText) return true;
        if (ctx === 'link' && params.linkURL) return true;
        if (ctx === 'image' && params.mediaType === 'image') return true;
        if (ctx === 'video' && params.mediaType === 'video') return true;
        if (ctx === 'audio' && params.mediaType === 'audio') return true;
        if (ctx === 'editable' && params.isEditable) return true;
    }
    return false;
}
function dispatchContextMenuClicked(sess, extId, info, tabInfo) {
    const bgWc = findExtensionBackground(extId);
    if (!bgWc || bgWc.isDestroyed()) return;
    bgWc.executeJavaScript(
        `try{var i=${JSON.stringify(info)},t=${JSON.stringify(tabInfo)};` +
        `if(chrome?.contextMenus?.onClicked?.dispatch)chrome.contextMenus.onClicked.dispatch(i,t);}catch(e){}`
    ).catch(() => {});
}

// ── Side panel (BrowserView) ──────────────────────────────────────
const SIDE_PANEL_WIDTH = 380;
const _CHROME_H = 90;  // mirrors CHROME_HEIGHT in tabs.js

const _sidePanels = new Map();       // winId → { view, extId }
const _spResizeHandlers = new Map(); // winId → handler

function getSidePanelWidth(winId) {
    return _sidePanels.has(winId) ? SIDE_PANEL_WIDTH : 0;
}
function getSidePanelView(winId) {
    return _sidePanels.get(winId)?.view || null;
}
function _reposSidePanelBounds(win) {
    const entry = _sidePanels.get(win.id);
    if (!entry) return;
    const [w, h] = win.getContentSize();
    entry.view.setBounds({ x: w - SIDE_PANEL_WIDTH, y: _CHROME_H, width: SIDE_PANEL_WIDTH, height: h - _CHROME_H });
    try { win.setTopBrowserView(entry.view); } catch {}
}
function _resizeActiveTab(win) {
    const { getViewBounds, getActiveBrowserView } = require('./tabs');
    if ((state.windowOverlayCount.get(win.id) || 0) > 0) return;
    const view = getActiveBrowserView(win);
    if (view) view.setBounds(getViewBounds(win));
}
function openSidePanel(win, extId, url) {
    closeSidePanel(win);
    const profileId = state.windowProfiles.get(win.id)?.id;
    if (!profileId) return;
    const view = new BrowserView({
        webPreferences: {
            partition:        `persist:${profileId}`,
            contextIsolation: false,
            nodeIntegration:  false,
            preload:          path.join(__dirname, '..', 'ext-preload.js'),
        },
    });
    win.addBrowserView(view);
    _sidePanels.set(win.id, { view, extId });
    _reposSidePanelBounds(win);
    _resizeActiveTab(win);
    const handler = () => _reposSidePanelBounds(win);
    _spResizeHandlers.set(win.id, handler);
    win.on('resize', handler);
    win.on('maximize', handler);
    win.on('unmaximize', handler);
    view.webContents.loadURL(url);
}
function closeSidePanel(win) {
    const entry = _sidePanels.get(win.id);
    if (!entry) return;
    try { win.removeBrowserView(entry.view); entry.view.webContents.destroy(); } catch {}
    _sidePanels.delete(win.id);
    const handler = _spResizeHandlers.get(win.id);
    if (handler) {
        try { win.off('resize', handler); win.off('maximize', handler); win.off('unmaximize', handler); } catch {}
        _spResizeHandlers.delete(win.id);
    }
    _resizeActiveTab(win);
}

// ── Session configuration ─────────────────────────────────────────
const _configuredSessions = new Set();
function configureSessionForExtensions(sess) {
    if (_configuredSessions.has(sess.partition)) return;
    _configuredSessions.add(sess.partition);

    const extPreloadPath = path.join(__dirname, '..', 'ext-preload.js');
    const trPreloadPath  = path.join(__dirname, '..', 'translator-preload.js');
    try {
        const existing = sess.getPreloads?.() || [];
        const toAdd = [extPreloadPath, trPreloadPath].filter(p => !existing.includes(p));
        if (toAdd.length) sess.setPreloads([...existing, ...toAdd]);
    } catch {}

    sess.setPermissionRequestHandler((_wc, _perm, callback) => callback(true));
    try { sess.setPermissionCheckHandler(() => true); } catch {}

    sess.webRequest.onHeadersReceived({ urls: ['*://*/*'] }, (details, callback) => {
        const isExtRequest = typeof details.initiator === 'string' &&
                             details.initiator.startsWith('chrome-extension://');
        if (!isExtRequest) {
            return callback({});
        }

        const rh = Object.assign({}, details.responseHeaders || {});
        rh['Access-Control-Allow-Origin']      = ['*'];
        rh['Access-Control-Allow-Headers']     = ['*'];
        rh['Access-Control-Allow-Methods']     = ['GET, POST, PUT, PATCH, DELETE, OPTIONS'];
        rh['Access-Control-Allow-Credentials'] = ['true'];

        if (details.method === 'OPTIONS') {
            callback({ responseHeaders: rh, statusLine: 'HTTP/1.1 200 OK' });
        } else {
            callback({ responseHeaders: rh });
        }
    });

    // ── defis-ipc:// custom protocol ──────────────────────────────────────────
    // Extension Service Workers use fetch('defis-ipc://action', {method:'POST',body:JSON})
    // to reach main process WITHOUT needing an open popup window.
    // This solves the BroadcastChannel relay problem (Fix #1).
    try {
        const { ipcMain } = require('electron');
        sess.protocol.handle('defis-ipc', async (request) => {
            const hdrs = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
            const ok   = (data) => new Response(JSON.stringify(data), { headers: hdrs });
            let body = {};
            try { body = JSON.parse(await request.text()); } catch {}
            const action = new URL(request.url).hostname;

            // tabs.sendMessage → dispatch CustomEvent to tab, await sendResponse
            if (action === 'tabs-send-msg') {
                const { tabId, message, extensionId, reqId } = body;
                const wc = webContents.fromId(tabId);
                if (!wc || wc.isDestroyed()) return ok({ response: undefined });
                const sender = { tab: { id: tabId }, frameId: 0, url: wc.getURL(), id: extensionId || '' };
                const responsePromise = reqId ? new Promise((resolve) => {
                    const handler = (_e, d) => {
                        if (d?.reqId !== reqId) return;
                        ipcMain.off('ext-msg-resp', handler);
                        clearTimeout(timer);
                        resolve(d.data);
                    };
                    const timer = setTimeout(() => { ipcMain.off('ext-msg-resp', handler); resolve(undefined); }, 8000);
                    ipcMain.on('ext-msg-resp', handler);
                }) : Promise.resolve(undefined);
                try {
                    await wc.executeJavaScript(
                        `(function(){try{window.dispatchEvent(new CustomEvent('__defis_ext_msg__',` +
                        `{detail:${JSON.stringify({ message, sender, reqId })},bubbles:false}));}catch(e){}})();true`
                    );
                } catch {}
                return ok({ response: await responsePromise });
            }

            // notifications.create → OS notification
            if (action === 'notify') {
                const { title, message, iconUrl } = body;
                try {
                    if (Notification.isSupported()) {
                        const n = new Notification({ title: title || 'Extension', body: message || '', icon: iconUrl || undefined });
                        n.show();
                    }
                } catch {}
                return ok({});
            }

            // windows/tabs create → open popup or new tab
            if (action === 'win-create') {
                const props = body.props || {};
                const type  = props.type;
                const urls  = Array.isArray(props.url) ? props.url : (props.url ? [props.url] : []);
                // find profile window for this session
                let profWin = null, profileId = null;
                for (const [pid, pw] of state.profileWindows) {
                    if (pw && !pw.isDestroyed()) {
                        try {
                            const ps = require('electron').session.fromPartition(`persist:${pid}`);
                            if (ps === sess) { profWin = pw; profileId = pid; break; }
                        } catch {}
                    }
                }
                if (!profWin) profWin = require('electron').BrowserWindow.getAllWindows().find(w => state.windowProfiles.has(w.id)) || null;
                if (type === 'popup' || type === 'detached_panel') {
                    const url = urls[0];
                    if (url) openExtPopupWindow(url, profileId || 'default', profWin);
                } else {
                    if (profWin) urls.forEach(u => profWin.webContents.send('ext-open-new-tab', { url: u, active: true }));
                }
                return ok({ id: -1, tabs: urls.map(u => ({ id: -1, url: u })) });
            }

            // contextMenus → items store
            if (action === 'contextmenu') {
                const { type, extId, props, id } = body;
                if (type === 'create' && extId && props) registerContextMenuItem(extId, props);
                else if (type === 'update' && extId) registerContextMenuItem(extId, { ...props, id });
                else if (type === 'remove' && extId) removeContextMenuItem(extId, id);
                else if (type === 'removeAll' && extId) removeAllContextMenuItems(extId);
                return ok({});
            }

            // declarativeNetRequest dynamic rules update
            if (action === 'dnr-update') {
                const { extId, addRules = [], removeRuleIds = [] } = body;
                _dnrApplyRules(sess, extId, addRules, removeRuleIds);
                return ok({});
            }

            return ok({});
        });
    } catch (e) {
        console.warn('[ext] defis-ipc protocol register failed:', e.message);
    }
}

// ── Extension helpers ─────────────────────────────────────────────
function findExtensionBackground(extensionId) {
    const prefix = `chrome-extension://${extensionId}/`;
    return webContents.getAllWebContents().find(wc => {
        try { return !wc.isDestroyed() && wc.getURL().startsWith(prefix); }
        catch { return false; }
    }) || null;
}

function makeExtTabInfo(view, win) {
    return {
        id:        view.webContents.id,
        windowId:  win.id,
        index:     0,
        active:    true,
        pinned:    false,
        incognito: false,
        url:       view.webContents.getURL(),
        title:     view.webContents.getTitle(),
        status:    'complete',
    };
}

function dispatchTabEvent(sess, eventName, ...args) {
    const jsonArgs = args.map(a => JSON.stringify(a)).join(', ');
    // Support dotted names: "webNavigation.onCompleted" → chrome["webNavigation"]["onCompleted"]
    // Bare names: "onUpdated" → chrome?.tabs?.onUpdated (legacy behaviour)
    const accessor = eventName.includes('.')
        ? `chrome${eventName.split('.').map(p => `[${JSON.stringify(p)}]`).join('')}`
        : `chrome?.tabs?.${eventName}`;
    sess.getAllExtensions().forEach(ext => {
        const bgWc = findExtensionBackground(ext.id);
        if (!bgWc || bgWc.isDestroyed()) return;
        bgWc.executeJavaScript(
            `try{var ev=${accessor};if(ev?.dispatch)ev.dispatch(${jsonArgs});}catch(e){}`
        ).catch(() => {});
    });
}

function reloadAllTabs(win) {
    state.getTabs(win).forEach(tab => {
        if (tab?.view && !tab.view.webContents.isDestroyed()) {
            const url = tab.view.webContents.getURL();
            if (url && !url.startsWith('about:')) tab.view.webContents.reload();
        }
    });
}

// ── Download extension ────────────────────────────────────────────
async function downloadExtension(extensionId) {
    const extDir = path.join(EXTENSIONS_DIR, extensionId);

    if (fs.existsSync(path.join(extDir, 'manifest.json'))) {
        patchExtensionManifest(extDir);
        try {
            const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
            const name = resolveI18nString(manifest.name, extDir, manifest.default_locale) || extensionId;
            return { ok: true, path: extDir, name, cached: true };
        } catch {
            return { ok: true, path: extDir, name: extensionId, cached: true };
        }
    }

    const crxUrl = `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=120.0.6099.71&acceptformat=crx3&x=id%3D${extensionId}%26installsource%3Dondemand%26uc`;
    try {
        const res = await net.fetch(crxUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' },
        });
        if (!res.ok) return { ok: false, error: `CWS HTTP ${res.status}` };

        const buf     = Buffer.from(await res.arrayBuffer());
        const zipData = crx3ToZip(buf);

        fs.mkdirSync(extDir, { recursive: true });
        new AdmZip(zipData).extractAllTo(extDir, true);

        patchExtensionManifest(extDir);

        const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
        const name = resolveI18nString(manifest.name, extDir, manifest.default_locale) || extensionId;
        return { ok: true, path: extDir, name };
    } catch (e) {
        try { fs.rmSync(extDir, { recursive: true, force: true }); } catch {}
        return { ok: false, error: e.message };
    }
}

// ── Load extensions for profile ───────────────────────────────────
async function loadExtensionsForProfile(profile) {
    const extensions = profile.plugins?.extensions || [];
    const sess        = session.fromPartition(`persist:${profile.id}`);

    configureSessionForExtensions(sess);

    const expectedIds = new Set(
        extensions.filter(e => e.enabled && e.id).map(e => e.id)
    );
    const expectedPaths = new Set(
        extensions.filter(e => e.enabled && e.localPath).map(e => e.localPath)
    );

    // Ghost SW cleanup via Preferences file
    try {
        const partitionPrefsPath = path.join(
            app.getPath('userData'), 'Partitions', profile.id, 'Preferences'
        );
        if (fs.existsSync(partitionPrefsPath)) {
            const prefs   = JSON.parse(fs.readFileSync(partitionPrefsPath, 'utf8'));
            const prefExts = prefs?.extensions?.settings || {};
            for (const extId of Object.keys(prefExts)) {
                if (!expectedIds.has(extId)) {
                    await sess.clearStorageData({
                        storages: ['serviceworkers'],
                        origin:   `chrome-extension://${extId}`,
                    }).catch(() => {});
                    console.log(`[ext] cleared ghost SW: ${extId}`);
                }
            }
        }
    } catch (e) {
        console.error('[ext] ghost SW cleanup:', e.message);
    }

    // Remove unlisted extensions
    for (const loaded of sess.getAllExtensions()) {
        if (!expectedPaths.has(loaded.path)) {
            try { sess.removeExtension(loaded.id); } catch {}
            sess.clearStorageData({
                storages: ['serviceworkers'],
                origin:   `chrome-extension://${loaded.id}`,
            }).catch(() => {});
            console.log(`[ext] evicted unlisted extension: ${loaded.id} (${loaded.path})`);
        }
    }

    if (!extensions.length) return;

    const loadedByPath = new Map(sess.getAllExtensions().map(e => [e.path, e]));

    for (const ext of extensions) {
        if (!ext.enabled || !ext.localPath) continue;
        if (!fs.existsSync(path.join(ext.localPath, 'manifest.json'))) continue;

        const manifestChanged = patchExtensionManifest(ext.localPath);

        const already = loadedByPath.get(ext.localPath);
        if (already && !manifestChanged) continue;

        if (already) {
            try { sess.removeExtension(already.id); } catch {}
            loadedByPath.delete(ext.localPath);
        }

        try {
            await sess.loadExtension(ext.localPath, { allowFileAccess: true });
            const loaded = sess.getAllExtensions().find(e => e.path === ext.localPath);
            if (loaded) _dnrLoadStaticRules(sess, loaded);
        } catch (e) {
            console.error(`loadExtension [${ext.id}]:`, e.message);
        }
    }
}

// ── Ghost SW pre-cleaner ──────────────────────────────────────────
function preCleanGhostSWsFromDisk() {
    const { profiles } = require('./profiles');
    const validIds = new Set();
    for (const p of profiles) {
        for (const e of (p.plugins?.extensions || [])) {
            if (e.enabled && e.id) validIds.add(e.id);
        }
    }

    const partitionsDir = path.join(app.getPath('userData'), 'Partitions');
    if (!fs.existsSync(partitionsDir)) return;

    for (const partId of fs.readdirSync(partitionsDir)) {
        const prefsPath = path.join(partitionsDir, partId, 'Preferences');
        if (!fs.existsSync(prefsPath)) continue;
        try {
            const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
            const extSettings = prefs?.extensions?.settings;
            if (!extSettings) continue;
            let changed = false;
            for (const extId of Object.keys(extSettings)) {
                const e = extSettings[extId];
                if (!validIds.has(extId)) {
                    if (e.service_worker_registration_info || Array.isArray(e.serviceworkerevents)) {
                        delete e.service_worker_registration_info;
                        delete e.serviceworkerevents;
                        changed = true;
                        console.log(`[ext] pre-cleaned ghost SW: ${partId}/${extId}`);
                    }
                } else {
                    if (Array.isArray(e.serviceworkerevents) && e.serviceworkerevents.length > 0) {
                        delete e.serviceworkerevents;
                        changed = true;
                    }
                }
            }
            if (changed) fs.writeFileSync(prefsPath, JSON.stringify(prefs), 'utf8');
        } catch (e) { console.error('[ext] preClean:', e.message); }
    }
}

// ── Popup window ──────────────────────────────────────────────────
function openExtPopupWindow(popupUrl, profileId, parentWin) {
    let x, y;
    if (parentWin) {
        const b = parentWin.getBounds();
        x = b.x + b.width - 410;
        y = b.y + 94;
    }

    const popup = new BrowserWindow({
        width: 400, height: 600,
        x, y,
        frame: false, resizable: true,
        alwaysOnTop: true, skipTaskbar: true,
        ...(parentWin ? { parent: parentWin } : {}),
        webPreferences: {
            partition:        `persist:${profileId}`,
            contextIsolation: false,
            nodeIntegration:  false,
            preload:          path.join(__dirname, '..', 'ext-preload.js'),
        },
    });

    popup.loadURL(popupUrl);

    // F12 / Ctrl+Shift+I → DevTools; Escape → close popup
    popup.webContents.on('before-input-event', (_e, input) => {
        const ctrl = input.control || input.meta;
        if (input.type !== 'keyDown') return;
        if (input.key === 'F12' || (ctrl && input.shift && (input.key === 'I' || input.key === 'i'))) {
            if (popup.webContents.isDevToolsOpened()) popup.webContents.closeDevTools();
            else popup.webContents.openDevTools({ mode: 'detach' });
        }
        if (input.key === 'Escape' && !popup.isDestroyed()) popup.close();
    });

    // Auto-resize: use ResizeObserver for dynamic content, fallback to snapshot
    popup.webContents.once('did-finish-load', () => {
        popup.webContents.executeJavaScript(`
            new Promise(resolve => {
                function measure() {
                    return [
                        Math.max(document.documentElement.scrollWidth, document.body ? document.body.offsetWidth : 0, 300),
                        Math.max(document.documentElement.scrollHeight, document.body ? document.body.offsetHeight : 0, 200)
                    ];
                }
                let resolved = false;
                const done = (dims) => { if (!resolved) { resolved = true; resolve(dims); } };
                // Watch for DOM size changes (React/Vue render)
                const ro = new ResizeObserver(() => done(measure()));
                if (document.body) ro.observe(document.body);
                // Fallback: snapshot after short delay to catch initial render
                setTimeout(() => { done(measure()); try { ro.disconnect(); } catch {} }, 500);
            })
        `).then(([w, h]) => {
            if (popup.isDestroyed()) return;
            popup.setContentSize(
                Math.min(Math.max(w, 200), 900),
                Math.min(Math.max(h, 100), 700)
            );
        }).catch(() => {});
    });

    popup._defiAuthInProgress = false;

    // Blur-to-close: don't close if a child window (e.g. DevTools, auth) is focused
    setTimeout(() => {
        if (popup.isDestroyed()) return;
        popup.on('blur', () => {
            if (popup.isDestroyed() || popup._defiAuthInProgress) return;
            // Keep open if the focused window is a descendant of this popup
            const focused = BrowserWindow.getFocusedWindow();
            if (focused && focused !== popup) {
                try {
                    if (focused.getParentWindow() === popup) return;
                } catch {}
            }
            popup.close();
        });
    }, 600);

    return popup;
}

// ── IPC ───────────────────────────────────────────────────────────
function registerExtensionIPC(ipcMain) {
    const api = require('../api-client');
    const { profiles } = require('./profiles');
    const config = require('./config');

    // Install extension by Chrome Web Store ID
    ipcMain.handle('ext-install', async (_e, { profileId, extensionId }) => {
        const result = await downloadExtension(extensionId);
        if (!result.ok) return result;

        const profList = require('./profiles').profiles;
        const profile = profList.find(p => p.id === profileId);
        if (!profile) return { ok: false, error: 'Profile not found' };

        const plugins    = JSON.parse(JSON.stringify(profile.plugins || {}));
        const extensions = plugins.extensions || [];

        if (!extensions.find(e => e.id === extensionId)) {
            extensions.push({ id: extensionId, name: result.name, enabled: true, localPath: result.path });
            plugins.extensions = extensions;
            const updated = await api.updateProfile({ id: profileId, plugins });
            if (updated) {
                const idx = profList.findIndex(p => p.id === profileId);
                if (idx >= 0) profList[idx] = updated;
            }
        }

        const sess   = session.fromPartition(`persist:${profileId}`);
        const loaded = new Set(sess.getAllExtensions().map(e => e.id));
        if (!loaded.has(extensionId)) {
            try { await sess.loadExtension(result.path, { allowFileAccess: true }); } catch {}
        }

        const _profWin = state.profileWindows.get(profileId);
        if (_profWin && !_profWin.isDestroyed()) {
            _profWin.webContents.send('ext-installed', { id: extensionId, name: result.name });
        }

        return { ok: true, id: extensionId, name: result.name, cached: !!result.cached };
    });

    // Remove extension from profile
    ipcMain.handle('ext-remove', async (_e, { profileId, extensionId }) => {
        const profList = require('./profiles').profiles;
        const profile = profList.find(p => p.id === profileId);
        if (!profile) return { ok: false };

        const plugins    = JSON.parse(JSON.stringify(profile.plugins || {}));
        plugins.extensions = (plugins.extensions || []).filter(e => e.id !== extensionId);

        const updated = await api.updateProfile({ id: profileId, plugins });
        if (updated) {
            const idx = profList.findIndex(p => p.id === profileId);
            if (idx >= 0) profList[idx] = updated;
        }

        try {
            const sess = session.fromPartition(`persist:${profileId}`);
            sess.removeExtension(extensionId);
        } catch {}

        return { ok: true };
    });

    // Toggle extension
    ipcMain.handle('ext-toggle', async (_e, { profileId, extensionId, enabled }) => {
        const profList = require('./profiles').profiles;
        const profile = profList.find(p => p.id === profileId);
        if (!profile) return { ok: false };

        const plugins    = JSON.parse(JSON.stringify(profile.plugins || {}));
        const extensions = plugins.extensions || [];
        const idx        = extensions.findIndex(e => e.id === extensionId);
        if (idx >= 0) extensions[idx] = { ...extensions[idx], enabled };
        plugins.extensions = extensions;

        const updated = await api.updateProfile({ id: profileId, plugins });
        if (updated) {
            const pidx = profList.findIndex(p => p.id === profileId);
            if (pidx >= 0) profList[pidx] = updated;
        }
        return { ok: true };
    });

    // List loaded
    ipcMain.handle('ext-list-loaded', (_e, profileId) => {
        try {
            const sess = session.fromPartition(`persist:${profileId}`);
            return sess.getAllExtensions().map(e => ({ id: e.id, name: e.name }));
        } catch { return []; }
    });

    // Get extension info for toolbar
    ipcMain.handle('ext-get-for-profile', async (_e, profileId) => {
        const profList = require('./profiles').profiles;
        const profile = profList.find(p => p.id === profileId);
        if (!profile) return [];

        const profileExts = (profile.plugins?.extensions || []).filter(e => e.enabled);
        if (!profileExts.length) return [];

        const sess          = session.fromPartition(`persist:${profileId}`);
        const allLoaded     = sess.getAllExtensions();
        const loadedById    = new Map(allLoaded.map(e => [e.id,   e]));
        const loadedByPath  = new Map(allLoaded.map(e => [e.path, e]));

        return profileExts.map(ext => {
            const inSession = (ext.localPath && loadedByPath.get(ext.localPath)) || loadedById.get(ext.id) || null;
            let icon = null, hasPopup = false;
            let name = ext.name;

            const mfDir = inSession?.path || ext.localPath || null;
            const onDisk = mfDir && fs.existsSync(path.join(mfDir, 'manifest.json'));

            if (onDisk) {
                try {
                    const mf = JSON.parse(fs.readFileSync(path.join(mfDir, 'manifest.json'), 'utf8'));
                    hasPopup = !!(mf.browser_action?.default_popup || mf.action?.default_popup);
                    name = resolveI18nString(mf.name, mfDir, mf.default_locale) || name;

                    const icons = mf.browser_action?.default_icon ?? mf.action?.default_icon ?? mf.icons ?? {};
                    const rel   = typeof icons === 'string'
                        ? icons
                        : (icons['16'] || icons['19'] || icons['32'] || icons['48'] || icons['128'] || Object.values(icons)[0]);
                    if (rel) icon = inSession
                        ? `chrome-extension://${inSession.id}/${rel}`
                        : `file://${path.join(mfDir, rel)}`;
                } catch {}
            }

            return { id: ext.id, electronId: inSession?.id || null, name, loaded: !!(inSession || onDisk), icon, hasPopup };
        });
    });

    // Open popup / trigger onClicked
    ipcMain.handle('ext-open-popup', async (event, { profileId, extensionId }) => {
        const parentWin = BrowserWindow.fromWebContents(event.sender);
        const sess      = session.fromPartition(`persist:${profileId}`);

        const profList = require('./profiles').profiles;
        const profile = profList.find(p => p.id === profileId);
        const profExt = profile?.plugins?.extensions?.find(e => e.id === extensionId);
        const lp      = profExt?.localPath || null;

        let ext = (lp && sess.getAllExtensions().find(e => e.path === lp))
               || sess.getAllExtensions().find(e => e.id === extensionId)
               || null;

        if (!ext) {
            if (lp && fs.existsSync(path.join(lp, 'manifest.json'))) {
                try {
                    ext = await sess.loadExtension(lp, { allowFileAccess: true });
                } catch {
                    ext = sess.getAllExtensions().find(e => e.path === lp) || null;
                }
            }
            if (!ext) return { ok: false, error: 'Extension not loaded in session' };
        }

        let mf;
        try { mf = JSON.parse(fs.readFileSync(path.join(ext.path, 'manifest.json'), 'utf8')); }
        catch { return { ok: false, error: 'Cannot read manifest' }; }

        const popupRelPath = mf.browser_action?.default_popup || mf.action?.default_popup;
        if (popupRelPath) {
            openExtPopupWindow(`chrome-extension://${ext.id}/${popupRelPath}`, profileId, parentWin);
            return { ok: true };
        }

        const bgWc = findExtensionBackground(ext.id);
        if (!bgWc || bgWc.isDestroyed()) return { ok: false, error: 'no_background' };

        let tabInfo = { id: -1, index: 0, windowId: -1, active: true, pinned: false, incognito: false, url: '', title: '' };
        if (parentWin) {
            const activeTabId = state.windowActive.get(parentWin.id);
            const tab = state.windowTabs.get(parentWin.id)?.get(activeTabId);
            if (tab?.view && !tab.view.webContents.isDestroyed()) {
                tabInfo.url   = tab.view.webContents.getURL();
                tabInfo.title = tab.view.webContents.getTitle();
            }
        }

        bgWc.setWindowOpenHandler(({ url }) => {
            setImmediate(() => openExtPopupWindow(url, profileId, parentWin));
            return { action: 'deny' };
        });

        try {
            const result = await bgWc.executeJavaScript(`
                (function() {
                    var _t = ${JSON.stringify(tabInfo)};
                    try {
                        if (chrome.browserAction && chrome.browserAction.onClicked && chrome.browserAction.onClicked.dispatch) {
                            chrome.browserAction.onClicked.dispatch(_t);
                            return 'browserAction';
                        }
                        if (chrome.action && chrome.action.onClicked && chrome.action.onClicked.dispatch) {
                            chrome.action.onClicked.dispatch(_t);
                            return 'action';
                        }
                        return 'no_listener';
                    } catch(e) { return 'error:' + e.message; }
                })()
            `);
            if (result === 'no_listener')    return { ok: false, error: 'no_listener' };
            if (result.startsWith('error:')) return { ok: false, error: result.slice(6) };
            return { ok: true };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    });

    // Scan local Chrome profile
    ipcMain.handle('ext-scan-chrome-profile', async () => {
        const os = require('os');
        const HOME = os.homedir();
        const SEARCH_DIRS = [
            path.join(HOME, '.config', 'google-chrome',     'Default', 'Extensions'),
            path.join(HOME, '.config', 'chromium',           'Default', 'Extensions'),
            path.join(HOME, '.config', 'BraveSoftware', 'Brave-Browser', 'Default', 'Extensions'),
            path.join(HOME, '.config', 'google-chrome-beta', 'Default', 'Extensions'),
            path.join(HOME, 'snap',   'chromium', 'common', 'chromium', 'Default', 'Extensions'),
        ];

        const found = [];
        const seen  = new Set();

        for (const extRoot of SEARCH_DIRS) {
            if (!fs.existsSync(extRoot)) continue;
            let entries;
            try { entries = fs.readdirSync(extRoot); } catch { continue; }

            for (const extId of entries) {
                if (!/^[a-z]{32}$/.test(extId) || seen.has(extId)) continue;
                const extBaseDir = path.join(extRoot, extId);
                let versionDirs;
                try { versionDirs = fs.readdirSync(extBaseDir).sort().reverse(); } catch { continue; }

                for (const ver of versionDirs) {
                    const mfPath = path.join(extBaseDir, ver, 'manifest.json');
                    if (!fs.existsSync(mfPath)) continue;
                    try {
                        const mf    = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
                        const srcDir = path.join(extBaseDir, ver);
                        const name  = resolveI18nString(mf.name, srcDir, mf.default_locale) || extId;

                        if (name.startsWith('__MSG_') || !name) break;
                        if (['nmmhkkegccagdldgiimedpiccmgmieda', 'pkedcjkdefgpdelpbcmbmeomcjbeemfm',
                             'aapocclcgogkmnckokdopfmhonfmgoek'].includes(extId)) break;

                        const icons  = mf.browser_action?.default_icon ?? mf.action?.default_icon ?? mf.icons ?? {};
                        const relIcon = typeof icons === 'string' ? icons
                            : (icons['48'] || icons['128'] || icons['32'] || icons['16'] || Object.values(icons)[0]);
                        let icon = null;
                        if (relIcon) {
                            const iconPath = path.join(srcDir, relIcon.replace(/^\//, ''));
                            if (fs.existsSync(iconPath)) {
                                const buf = fs.readFileSync(iconPath);
                                const mime = iconPath.endsWith('.png') ? 'image/png' : 'image/webp';
                                icon = `data:${mime};base64,${buf.toString('base64')}`;
                            }
                        }

                        seen.add(extId);
                        found.push({ id: extId, name, version: ver, sourceDir: srcDir, icon });
                    } catch {}
                    break;
                }
            }
        }
        return found;
    });

    // Install from local Chrome profile
    ipcMain.handle('ext-install-from-local', async (_e, { profileId, extensionId, sourceDir }) => {
        if (!sourceDir || !fs.existsSync(path.join(sourceDir, 'manifest.json'))) {
            return { ok: false, error: 'Source directory or manifest not found' };
        }

        const destDir = path.join(EXTENSIONS_DIR, extensionId);
        try {
            if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true });
            fs.cpSync(sourceDir, destDir, { recursive: true, errorOnExist: false });
        } catch (e) {
            return { ok: false, error: `Copy failed: ${e.message}` };
        }

        patchExtensionManifest(destDir);

        const mf   = JSON.parse(fs.readFileSync(path.join(destDir, 'manifest.json'), 'utf8'));
        const name = resolveI18nString(mf.name, destDir, mf.default_locale) || extensionId;

        const profList = require('./profiles').profiles;
        const profile = profList.find(p => p.id === profileId);
        if (!profile) return { ok: false, error: 'Profile not found' };

        const plugins    = JSON.parse(JSON.stringify(profile.plugins || {}));
        const extensions = plugins.extensions || [];
        const existing   = extensions.findIndex(e => e.id === extensionId);
        const entry      = { id: extensionId, name, enabled: true, localPath: destDir };
        if (existing >= 0) extensions[existing] = entry;
        else               extensions.push(entry);
        plugins.extensions = extensions;

        const updated = await api.updateProfile({ id: profileId, plugins });
        if (updated) {
            const idx = profList.findIndex(p => p.id === profileId);
            if (idx >= 0) profList[idx] = updated;
        }

        const sess   = session.fromPartition(`persist:${profileId}`);
        const oldExt = sess.getAllExtensions().find(e => e.id === extensionId || e.path === destDir);
        if (oldExt) { try { sess.removeExtension(oldExt.id); } catch {} }
        try { await sess.loadExtension(destDir, { allowFileAccess: true }); } catch {}

        const profWin = state.profileWindows.get(profileId);
        if (profWin && !profWin.isDestroyed()) profWin.webContents.send('ext-installed', { id: extensionId, name });

        return { ok: true, id: extensionId, name };
    });

    // Open new tab from extension
    ipcMain.handle('ext-open-new-tab', async (e, { url, active = true } = {}) => {
        const senderUrl = (() => { try { return e.sender.getURL(); } catch { return ''; } })();

        let targetWin = null;
        for (const [profileId, profWin] of state.profileWindows) {
            if (!profWin || profWin.isDestroyed()) continue;
            const sess = session.fromPartition(`persist:${profileId}`);
            const matched = sess.getAllExtensions().some(ex => senderUrl.startsWith(`chrome-extension://${ex.id}/`));
            if (matched) { targetWin = profWin; break; }
        }
        if (!targetWin) targetWin = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows().find(w => state.windowProfiles.has(w.id)) || null;
        if (!targetWin || targetWin.isDestroyed()) return { ok: false };

        targetWin.webContents.send('ext-open-new-tab', { url, active });
        return { ok: true };
    });

    // DevTools for active BrowserView
    ipcMain.on('open-devtools', (e) => {
        const win   = state.getWin(e);
        const tabId = state.getActiveId(win);
        const tab   = state.getTabs(win).get(tabId);
        if (tab?.view && !tab.view.webContents.isDestroyed()) {
            tab.view.webContents.openDevTools({ mode: 'detach' });
        }
    });

    // Dev Mode toggle
    ipcMain.handle('toggle-dev-mode', async () => {
        const configMod = require('./config');
        const enabled = !configMod.globalConfig.devMode;
        await configMod.saveGlobalConfig({ devMode: enabled });

        BrowserWindow.getAllWindows().forEach(win => {
            if (state.windowProfiles.has(win.id)) {
                state.getTabs(win).forEach(tab => {
                    if (!tab?.view || tab.view.webContents.isDestroyed()) return;
                    if (enabled) {
                        tab.view.webContents.openDevTools({ mode: 'detach' });
                    } else if (tab.view.webContents.isDevToolsOpened()) {
                        tab.view.webContents.closeDevTools();
                    }
                });
            }
            const { settingsWinProfile } = require('./windows');
            if (settingsWinProfile.has(win.id)) {
                if (enabled && !win.isDestroyed()) {
                    win.webContents.openDevTools({ mode: 'detach' });
                } else if (!enabled && win.webContents.isDevToolsOpened()) {
                    win.webContents.closeDevTools();
                }
            }
        });

        return { ok: true, devMode: enabled };
    });

    // ── chrome.tabs.sendMessage → deliver to content scripts ─────────────────
    // Dispatches a CustomEvent in the page's main world; content-api-polyfill
    // bridges it into the isolated world via chrome.runtime.onMessage.
    // reqId enables sendResponse callbacks (Fix #2).
    ipcMain.handle('ext-tabs-send-message', async (_e, { tabId, message, extensionId, reqId }) => {
        const wc = webContents.fromId(tabId);
        if (!wc || wc.isDestroyed()) return undefined;
        const sender = { tab: { id: tabId }, frameId: 0, url: wc.getURL(), id: extensionId || '' };
        const responsePromise = reqId ? new Promise((resolve) => {
            const handler = (_e2, d) => {
                if (d?.reqId !== reqId) return;
                ipcMain.off('ext-msg-resp', handler);
                clearTimeout(timer);
                resolve(d.data);
            };
            const timer = setTimeout(() => { ipcMain.off('ext-msg-resp', handler); resolve(undefined); }, 8000);
            ipcMain.on('ext-msg-resp', handler);
        }) : Promise.resolve(undefined);
        try {
            await wc.executeJavaScript(
                `(function(){try{window.dispatchEvent(new CustomEvent('__defis_ext_msg__',` +
                `{detail:${JSON.stringify({ message, sender, reqId })},bubbles:false}));}catch(e){}})();true`
            );
        } catch {}
        return await responsePromise;
    });

    // ── chrome.windows.create({type:'popup'}) → real BrowserWindow ───────────
    ipcMain.handle('ext-open-popup-window', (event, { url, width, height, profileId: reqPid }) => {
        if (!url) return { ok: false };
        const senderWin = BrowserWindow.fromWebContents(event.sender);

        // Resolve which profile this extension belongs to
        let resolvedPid = reqPid;
        if (!resolvedPid) {
            // Check if sender window is a profile window
            if (senderWin) resolvedPid = state.windowProfiles.get(senderWin.id)?.id || null;
        }
        if (!resolvedPid) {
            // Find from sender's session (extension URL → session → profile)
            const senderUrl = (() => { try { return event.sender.getURL(); } catch { return ''; } })();
            for (const [pid, pw] of state.profileWindows) {
                if (!pw || pw.isDestroyed()) continue;
                const sess = session.fromPartition(`persist:${pid}`);
                if (sess.getAllExtensions().some(ex => senderUrl.startsWith(`chrome-extension://${ex.id}/`))) {
                    resolvedPid = pid; break;
                }
            }
        }

        const parentWin = senderWin && state.windowProfiles.has(senderWin.id) ? senderWin
            : (resolvedPid ? state.profileWindows.get(resolvedPid) : null) || BrowserWindow.getFocusedWindow();

        const popupWin = openExtPopupWindow(url, resolvedPid || 'default', parentWin);
        if ((width || height) && !popupWin.isDestroyed()) {
            popupWin.setContentSize(
                Math.min(Math.max(width || 400, 200), 900),
                Math.min(Math.max(height || 600, 100), 700)
            );
        }
        return { ok: true };
    });

    // ── chrome.notifications.create → OS notification ─────────────────────────
    ipcMain.handle('ext-notify', (_e, { title, message, iconUrl }) => {
        try {
            if (!Notification.isSupported()) return { ok: false };
            const n = new Notification({ title: title || 'Extension', body: message || '', icon: iconUrl || undefined });
            n.show();
            return { ok: true };
        } catch { return { ok: false }; }
    });

    // ── chrome.contextMenus → store items, inject into right-click menu ───────
    ipcMain.handle('ext-contextmenu-register', (_e, { extId, props }) => {
        if (!extId || !props) return;
        return registerContextMenuItem(extId, props);
    });
    ipcMain.handle('ext-contextmenu-remove', (_e, { extId, id }) => {
        if (extId) removeContextMenuItem(extId, id);
    });
    ipcMain.handle('ext-contextmenu-removeall', (_e, { extId }) => {
        if (extId) removeAllContextMenuItems(extId);
    });

    // ── chrome.sidePanel → real BrowserView on right side of window ───────────
    ipcMain.handle('ext-sidepanel-open', (event, opts) => {
        const senderWin = BrowserWindow.fromWebContents(event.sender);
        const profWin = (senderWin && state.windowProfiles.has(senderWin.id)) ? senderWin
            : BrowserWindow.getAllWindows().find(w => state.windowProfiles.has(w.id)) || null;
        if (!profWin) return { ok: false };

        let url = opts?.path || opts?.url;
        const extId = opts?.extensionId || '';
        if (!url && extId) {
            const profileId = state.windowProfiles.get(profWin.id)?.id;
            if (profileId) {
                const sess = session.fromPartition(`persist:${profileId}`);
                const ext = sess.getAllExtensions().find(e => e.id === extId);
                if (ext) {
                    try {
                        const mf = JSON.parse(fs.readFileSync(path.join(ext.path, 'manifest.json'), 'utf8'));
                        const panelPath = mf.side_panel?.default_path || mf.sidebar_action?.default_panel;
                        if (panelPath) url = `chrome-extension://${ext.id}/${panelPath}`;
                    } catch {}
                }
            }
        }
        if (!url) return { ok: false, error: 'No panel URL' };
        openSidePanel(profWin, extId, url);
        return { ok: true };
    });
    ipcMain.handle('ext-sidepanel-close', (event) => {
        const senderWin = BrowserWindow.fromWebContents(event.sender);
        const profWin = (senderWin && state.windowProfiles.has(senderWin.id)) ? senderWin
            : BrowserWindow.getAllWindows().find(w => state.windowProfiles.has(w.id)) || null;
        if (!profWin) return { ok: false };
        closeSidePanel(profWin);
        return { ok: true };
    });
    ipcMain.handle('ext-sidepanel-setopts', (event, opts) => {
        if (opts?.path) {
            const senderWin = BrowserWindow.fromWebContents(event.sender);
            const profWin = (senderWin && state.windowProfiles.has(senderWin.id)) ? senderWin
                : BrowserWindow.getAllWindows().find(w => state.windowProfiles.has(w.id)) || null;
            if (profWin) {
                const extId = opts.extensionId || '';
                const entry = _sidePanels.get(profWin.id);
                if (entry) {
                    const url = `chrome-extension://${extId}/${opts.path}`;
                    entry.view.webContents.loadURL(url).catch(() => {});
                }
            }
        }
        return {};
    });

    // Active tab info for chrome.tabs.query override
    ipcMain.on('ext-get-active-tab', (e) => {
        const popupWin = BrowserWindow.fromWebContents(e.sender);
        let profileWin = null;
        if (popupWin) {
            try { profileWin = popupWin.getParentWindow(); } catch {}
        }
        if (!profileWin) {
            profileWin = BrowserWindow.getAllWindows().find(w => state.windowProfiles.has(w.id)) || null;
        }
        if (!profileWin) return (e.returnValue = null);

        const tabId = state.getActiveId(profileWin);
        const tab   = state.getTabs(profileWin).get(tabId);
        if (!tab?.view || tab.view.webContents.isDestroyed()) return (e.returnValue = null);

        const wc = tab.view.webContents;
        e.returnValue = {
            id:               wc.id,
            url:              wc.getURL(),
            title:            wc.getTitle(),
            active:           true,
            highlighted:      true,
            selected:         true,
            pinned:           false,
            audible:          false,
            discarded:        false,
            autoDiscardable:  false,
            mutedInfo:        { muted: false },
            windowId:         profileWin.id,
            index:            0,
            status:           'complete',
            incognito:        false,
        };
    });

    // Script injection fallback
    ipcMain.handle('ext-execute-script', async (_e, { tabId, func, args, code, files }) => {
        if (!tabId) return [];
        const wc = webContents.fromId(tabId);
        if (!wc || wc.isDestroyed()) return [];
        try {
            let js;
            if (func) {
                const argStr = Array.isArray(args) && args.length
                    ? args.map(a => JSON.stringify(a)).join(',')
                    : '';
                js = `(${func})(${argStr})`;
            } else if (code) {
                js = code;
            } else {
                return [];
            }
            const result = await wc.executeJavaScript(js, true);
            return [{ result }];
        } catch (err) {
            return [{ error: { message: err.message } }];
        }
    });

    // Identity auth
    ipcMain.on('ext-identity-auth-start', (e) => {
        const win = BrowserWindow.fromWebContents(e.sender);
        if (win) win._defiAuthInProgress = true;
    });
    ipcMain.on('ext-identity-auth-end', (e) => {
        const win = BrowserWindow.fromWebContents(e.sender);
        if (win) win._defiAuthInProgress = false;
    });

    ipcMain.handle('ext-identity-auth', (_e, { url, interactive, extensionId }) => {
        if (!interactive) return Promise.resolve({ error: 'Non-interactive mode not supported' });
        if (!url) return Promise.resolve({ error: 'No URL provided' });

        return new Promise((resolve) => {
            let resolved = false;

            const authWin = new BrowserWindow({
                width: 800, height: 700,
                title: 'Sign In',
                webPreferences: { contextIsolation: true, nodeIntegration: false },
            });

            const redirectBase = `https://${extensionId}.chromiumapp.org`;

            function tryCapture(navUrl) {
                if (!navUrl || resolved) return false;
                if (navUrl.startsWith(redirectBase) ||
                    navUrl.startsWith(`http://${extensionId}.chromiumapp.org`)) {
                    resolved = true;
                    resolve({ url: navUrl });
                    setImmediate(() => { if (!authWin.isDestroyed()) authWin.close(); });
                    return true;
                }
                return false;
            }

            authWin.webContents.on('will-redirect', (e, u) => { if (tryCapture(u)) e.preventDefault(); });
            authWin.webContents.on('will-navigate', (e, u) => { if (tryCapture(u)) e.preventDefault(); });
            authWin.webContents.on('did-navigate',  (_e, u) => tryCapture(u));

            authWin.on('closed', () => {
                if (!resolved) resolve({ error: 'User cancelled authentication' });
            });

            authWin.loadURL(url);
        });
    });
}

// ── declarativeNetRequest (DNR) → session.webRequest fallback ────
// Electron 28 has no DNR support. Extensions that call
// chrome.declarativeNetRequest.updateDynamicRules() have their rules
// applied here via session.webRequest (Fix #3).
const _dnrRules   = new Map(); // partition → Map<extId, rules[]>
const _dnrHandlers = new Map(); // partition → { unregister }

function _dnrUrlToRegex(urlFilter) {
    // Convert DNR urlFilter wildcards to a regex
    let pat = urlFilter
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // escape regex special chars (except * and |)
        .replace(/\\\*/g, '.*')                  // * → .*
        .replace(/^\|\|/, '(?:https?:\\/\\/|wss?:\\/\\/)[^\\/]*') // || → any scheme+host
        .replace(/^\|/, '^')                     // leading | → start anchor
        .replace(/\|$/, '$')                     // trailing | → end anchor
        .replace(/\^/g, '[/?#]?');               // ^ → separator
    try { return new RegExp(pat, 'i'); } catch { return null; }
}

function _dnrApplyRules(sess, extId, addRules, removeRuleIds) {
    if (!_dnrRules.has(sess.partition)) _dnrRules.set(sess.partition, new Map());
    const sessRules = _dnrRules.get(sess.partition);
    if (!sessRules.has(extId)) sessRules.set(extId, []);
    let rules = sessRules.get(extId);

    if (removeRuleIds?.length) {
        const removeSet = new Set(removeRuleIds);
        rules = rules.filter(r => !removeSet.has(r.id));
    }
    if (addRules?.length) rules = rules.concat(addRules);
    sessRules.set(extId, rules);

    _dnrRebuildHandlers(sess);
}

function _dnrLoadStaticRules(sess, ext) {
    try {
        const mf = JSON.parse(fs.readFileSync(path.join(ext.path, 'manifest.json'), 'utf8'));
        const resources = mf.declarative_net_request?.rule_resources || [];
        for (const res of resources) {
            if (res.enabled === false) continue;
            try {
                const rulePath = path.join(ext.path, res.path);
                const rules = JSON.parse(fs.readFileSync(rulePath, 'utf8'));
                _dnrApplyRules(sess, ext.id, rules, []);
            } catch {}
        }
    } catch {}
}

function _dnrRebuildHandlers(sess) {
    // Remove existing handler for this session
    if (_dnrHandlers.has(sess.partition)) {
        try { _dnrHandlers.get(sess.partition).unregister(); } catch {}
        _dnrHandlers.delete(sess.partition);
    }

    const sessRules = _dnrRules.get(sess.partition);
    if (!sessRules) return;

    // Flatten all rules from all extensions, sorted by priority desc
    const allRules = [];
    for (const [, rules] of sessRules) allRules.push(...rules);
    if (!allRules.length) return;
    allRules.sort((a, b) => (b.priority || 1) - (a.priority || 1));

    // Build block/redirect/modifyHeaders lists
    const blockRules    = allRules.filter(r => r.action?.type === 'block');
    const redirectRules = allRules.filter(r => r.action?.type === 'redirect' && r.action.redirect);
    const headerRules   = allRules.filter(r => r.action?.type === 'modifyHeaders');

    function _urlMatchesCond(url, condition) {
        if (!condition) return false;
        const re = condition.urlFilter ? _dnrUrlToRegex(condition.urlFilter)
            : condition.regexFilter   ? (() => { try { return new RegExp(condition.regexFilter, 'i'); } catch { return null; } })()
            : null;
        return re ? re.test(url) : true;
    }

    let unregBefore = null, unregHeaders = null;

    if (blockRules.length || redirectRules.length) {
        sess.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
            const url = details.url;
            for (const rule of blockRules) {
                if (_urlMatchesCond(url, rule.condition)) {
                    return callback({ cancel: true });
                }
            }
            for (const rule of redirectRules) {
                if (_urlMatchesCond(url, rule.condition)) {
                    const redir = rule.action.redirect;
                    const redirectUrl = redir.url || redir.extensionPath
                        ? (redir.url || `chrome-extension://unknown/${redir.extensionPath}`)
                        : null;
                    if (redirectUrl) return callback({ redirectURL: redirectUrl });
                }
            }
            callback({});
        });
        unregBefore = () => { try { sess.webRequest.onBeforeRequest(null); } catch {} };
    }

    if (headerRules.length) {
        sess.webRequest.onHeadersReceived({ urls: ['*://*/*'] }, (details, callback) => {
            let rh = Object.assign({}, details.responseHeaders || {});
            for (const rule of headerRules) {
                if (!_urlMatchesCond(details.url, rule.condition)) continue;
                for (const mod of (rule.action.responseHeaders || [])) {
                    const k = mod.header.toLowerCase();
                    if (mod.operation === 'remove') { delete rh[k]; }
                    else if (mod.operation === 'set') { rh[k] = [mod.value]; }
                    else if (mod.operation === 'append') { rh[k] = [...(rh[k] || []), mod.value]; }
                }
            }
            callback({ responseHeaders: rh });
        });
        unregHeaders = () => { try { sess.webRequest.onHeadersReceived(null); } catch {} };
    }

    if (unregBefore || unregHeaders) {
        _dnrHandlers.set(sess.partition, {
            unregister: () => { unregBefore?.(); unregHeaders?.(); }
        });
    }
}

module.exports = {
    setExtensionsDir,
    crx3ToZip, resolveI18nString, patchExtensionManifest,
    configureSessionForExtensions,
    findExtensionBackground, makeExtTabInfo, dispatchTabEvent, reloadAllTabs,
    downloadExtension, loadExtensionsForProfile,
    preCleanGhostSWsFromDisk, openExtPopupWindow,
    // Context menus
    registerContextMenuItem, removeContextMenuItem, removeAllContextMenuItems,
    getExtContextMenuItems, dispatchContextMenuClicked,
    // Side panel
    getSidePanelWidth, getSidePanelView, openSidePanel, closeSidePanel,
    registerExtensionIPC,
};
