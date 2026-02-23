'use strict';
// This preload runs in EVERY webContents of the profile session.
// storage.sync patch applies everywhere (content scripts + extension pages).
// All other chrome.* patches only apply to chrome-extension:// pages.

const { ipcRenderer } = require('electron');
let _onChangedPatched = false; // guard: only patch onChanged once across patchChrome() calls

// ── storage.sync → storage.local (applies in ALL contexts, incl. content scripts) ─
(function patchStorageSync() {
    const c = typeof window !== 'undefined' && window.chrome;
    if (!c?.storage?.local) return;
    const _local = c.storage.local;
    try {
        Object.defineProperty(c.storage, 'sync', {
            get: () => _local, set: () => {}, configurable: true, enumerable: true,
        });
    } catch {
        try {
            const _orig = c.storage;
            const _px   = new Proxy(_orig, { get(t,p) { return p==='sync'?_local:Reflect.get(t,p); } });
            Object.defineProperty(c, 'storage', { get:()=>_px, configurable:true });
        } catch {}
    }
})();

// ── sendResponse relay: content script → ext-preload → IPC → main ────────────
// content-api-polyfill.js dispatches __defis_ext_resp__ when a content script
// calls sendResponse(data). We relay it to main via ipcMain.on('ext-msg-resp').
// Must run in ALL pages (including twitter.com), not just extension pages.
try {
    window.addEventListener('__defis_ext_resp__', function(ev) {
        try {
            var detail = (ev && ev.detail) || {};
            if (detail.reqId) ipcRenderer.send('ext-msg-resp', { reqId: detail.reqId, data: detail.data });
        } catch(e) {}
    }, false);
} catch(e) {}

if (window.location.protocol !== 'chrome-extension:') return; // rest only for extension pages

// ── BroadcastChannel relays: SW contexts → IPC ───────────────────────────────
// SW contexts (MV3 service workers) don't have ipcRenderer; they communicate
// via BroadcastChannel. Extension pages (popup, options, MV2 bg) DO have
// ipcRenderer (via this preload) and act as relay agents.
(function setupBroadcastRelays() {
    if (!window.BroadcastChannel) return;

    // 1. tabs.sendMessage relay: SW → popup → IPC → main → webContents
    try {
        const _tabsMsgCh = new BroadcastChannel('defis-tabs-msg');
        _tabsMsgCh.onmessage = async ev => {
            const { type, reqId, tabId, message, url, active } = ev.data || {};
            if (type === 'send-msg' && reqId) {
                let response;
                try {
                    response = await ipcRenderer.invoke('ext-tabs-send-message', {
                        tabId, message,
                        extensionId: window.chrome?.runtime?.id || '',
                    });
                } catch {}
                _tabsMsgCh.postMessage({ reqId, response });
            } else if (type === 'new-tab' && url) {
                ipcRenderer.invoke('ext-open-new-tab', { url, active: active !== false }).catch(() => {});
            }
        };
    } catch {}

    // 2. notifications relay: SW → popup → IPC → OS notification
    try {
        const _notifyCh = new BroadcastChannel('defis-notify');
        _notifyCh.onmessage = ev => {
            const { type, title, message, iconUrl } = ev.data || {};
            if (type === 'create') {
                ipcRenderer.invoke('ext-notify', { title, message, iconUrl }).catch(() => {});
            }
        };
    } catch {}

    // 3. windows.create relay: SW → popup → IPC
    try {
        const _winCh = new BroadcastChannel('defis-win-create');
        _winCh.onmessage = ev => {
            const { type, urls = [], url, width, height } = ev.data || {};
            if (type === 'popup') {
                const targetUrl = url || urls[0];
                if (targetUrl) {
                    ipcRenderer.invoke('ext-open-popup-window', { url: targetUrl, width, height }).catch(() => {});
                }
            } else if (type === 'tabs') {
                const allUrls = url ? [url] : urls;
                allUrls.forEach(u => ipcRenderer.invoke('ext-open-new-tab', { url: u, active: true }).catch(() => {}));
            }
        };
    } catch {}

    // 4. contextMenus relay: SW → popup → IPC → main process store
    try {
        const _cmCh = new BroadcastChannel('defis-contextmenu');
        _cmCh.onmessage = ev => {
            const { type, extId, props, id } = ev.data || {};
            if (type === 'create' && extId && props) {
                ipcRenderer.invoke('ext-contextmenu-register', { extId, props }).catch(() => {});
            } else if (type === 'update' && extId) {
                ipcRenderer.invoke('ext-contextmenu-register', { extId, props: { ...props, id } }).catch(() => {});
            } else if (type === 'remove' && extId) {
                ipcRenderer.invoke('ext-contextmenu-remove', { extId, id }).catch(() => {});
            } else if (type === 'removeAll' && extId) {
                ipcRenderer.invoke('ext-contextmenu-removeall', { extId }).catch(() => {});
            }
        };
    } catch {}
})();

function patchChrome() {
    const c = window.chrome;
    if (!c) return;

    // ── browserAction ↔ action bridge ────────────────────────────────────────
    // Some extensions use the MV2 API (browserAction) in MV3 context.
    if (!c.browserAction && c.action)  c.browserAction = c.action;
    if ( c.browserAction && !c.action) c.action = c.browserAction;

    // ── storage.sync → storage.local fallback (re-apply for extension pages) ─
    if (c.storage?.local) {
        const _local = c.storage.local;
        try {
            Object.defineProperty(c.storage, 'sync', {
                get: () => _local, set: () => {}, configurable: true, enumerable: true,
            });
        } catch {
            // defineProperty failed (non-configurable) — replace storage with a Proxy
            try {
                const _origStorage = c.storage;
                const _proxied = new Proxy(_origStorage, {
                    get(t, p) { return p === 'sync' ? _local : Reflect.get(t, p); },
                });
                Object.defineProperty(c, 'storage', { get: () => _proxied, configurable: true });
            } catch {}
        }
    }

    // ── storage.onChanged relay: local → sync ─────────────────────────────────
    // Because sync is redirected to local, change events fire with area="local".
    // @plasmohq/storage checks `if (area !== this.area) return` where this.area="sync",
    // so its listeners never fire. Fix: relay local changes also as area="sync".
    if (c.storage?.onChanged && !_onChangedPatched) {
        _onChangedPatched = true;
        try {
            const _origOnChanged = c.storage.onChanged;
            try {
                const _proxied = new Proxy(_origOnChanged, {
                    get(t, p) {
                        if (p !== 'addListener') return Reflect.get(t, p);
                        return (fn) => t.addListener((changes, area) => {
                            fn(changes, area);
                            if (area === 'local') fn(changes, 'sync');
                        });
                    },
                });
                Object.defineProperty(c.storage, 'onChanged', {
                    get: () => _proxied, configurable: true, enumerable: true,
                });
            } catch {
                const _origAdd = _origOnChanged.addListener.bind(_origOnChanged);
                _origOnChanged.addListener = (fn) => {
                    _origAdd((changes, area) => {
                        fn(changes, area);
                        if (area === 'local') fn(changes, 'sync');
                    });
                };
            }
        } catch {}
    }

    // ── @plasmohq/storage no-token shim ───────────────────────────────────────
    // Scoped to extensions that use a sentinel-style USER_TOKEN (Ethnos/llieeniipcooiaclgjcodcblmnmcmkkp).
    // Writing the sentinel triggers @plasmohq/storage's watchUserTokenChange listener
    // and moves the UI from "Loading..." to the login screen.
    // DO NOT apply to Wallchain (hmkmpdakcjpihbpfolonciflbkjkojdb) — it uses USER_TOKEN
    // as a real API bearer token; writing a fake sentinel causes a 401 loop.
    const _plasmoSentinelIds = new Set(['llieeniipcooiaclgjcodcblmnmcmkkp']);
    if (c.storage?.local && /\/popup\.html?(\?|#|$)/.test(window.location.pathname) &&
        _plasmoSentinelIds.has(c.runtime?.id)) {
        try {
            c.storage.local.get(['USER_TOKEN'], r => {
                if (r && !r.USER_TOKEN) {
                    // Wait 300ms for @plasmohq/storage to register its onChanged listener
                    setTimeout(() => {
                        try {
                            c.storage.local.get(['USER_TOKEN'], r2 => {
                                if (r2 && !r2.USER_TOKEN)
                                    c.storage.local.set({ USER_TOKEN: JSON.stringify('__defis_unauthenticated__') }, () => {});
                            });
                        } catch {}
                    }, 300);
                }
            });
        } catch {}
    }

    // ── Auth relay: SW launchWebAuthFlow → popup → IPC ─────────────────────────
    // The background SW calls chrome.identity.launchWebAuthFlow but has no ipcRenderer.
    // The popup (which has ipcRenderer) handles it via two parallel mechanisms:
    //   1. chrome.runtime.onMessage (primary — standard Chrome extension messaging)
    //   2. BroadcastChannel (fallback — same-origin cross-context channel)
    if (c.runtime?.id) {
        // Primary: chrome.runtime.onMessage
        try {
            if (c.runtime.onMessage?.addListener) {
                c.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
                    if (msg?._defisType !== 'launchWebAuthFlow') return false;
                    ipcRenderer.send('ext-identity-auth-start');
                    ipcRenderer.invoke('ext-identity-auth', {
                        url: msg.url, interactive: !!msg.interactive, extensionId: c.runtime.id,
                    }).then(result => {
                        ipcRenderer.send('ext-identity-auth-end');
                        sendResponse(result);
                    }).catch(err => {
                        ipcRenderer.send('ext-identity-auth-end');
                        sendResponse({ error: err.message });
                    });
                    return true; // keep sendResponse channel open for async reply
                });
            }
        } catch {}
        // Fallback: BroadcastChannel
        try {
            const _defiAuthBc = new BroadcastChannel('defis-identity-auth');
            _defiAuthBc.onmessage = async (ev) => {
                const { reqId, url, interactive } = ev.data || {};
                if (!reqId || !url) return;
                ipcRenderer.send('ext-identity-auth-start');
                try {
                    const result = await ipcRenderer.invoke('ext-identity-auth', {
                        url, interactive: !!interactive, extensionId: c.runtime.id,
                    });
                    ipcRenderer.send('ext-identity-auth-end');
                    _defiAuthBc.postMessage({ reqId, url: result?.url, error: result?.error });
                } catch (err) {
                    ipcRenderer.send('ext-identity-auth-end');
                    _defiAuthBc.postMessage({ reqId, error: err.message });
                }
            };
        } catch {}
    }

    // ── identity ──────────────────────────────────────────────────────────────
    c.identity = c.identity || {};
    c.identity.getAuthToken          = c.identity.getAuthToken          || ((d, cb) => { if (cb) cb(null); return Promise.resolve(null); });
    c.identity.getProfileUserInfo    = c.identity.getProfileUserInfo    || ((d, cb) => { if (typeof d === 'function') d({}); else if (cb) cb({}); });
    c.identity.removeCachedAuthToken = c.identity.removeCachedAuthToken || ((d, cb) => { if (cb) cb(); return Promise.resolve(); });
    c.identity.getRedirectURL        = c.identity.getRedirectURL        || ((path) => `https://${c.runtime?.id || ''}.chromiumapp.org/${path || ''}`);

    // launchWebAuthFlow — opens a real browser window and captures the redirect
    c.identity.launchWebAuthFlow = (details, callback) => {
        ipcRenderer.send('ext-identity-auth-start');  // keep popup open during auth
        const p = ipcRenderer.invoke('ext-identity-auth', {
            url:         details?.url,
            interactive: !!details?.interactive,
            extensionId: c.runtime?.id,
        }).then(result => {
            ipcRenderer.send('ext-identity-auth-end');
            if (result?.error) {
                try { c.runtime.lastError = { message: result.error }; } catch {}
                if (callback) callback(undefined);
                return undefined;
            }
            try { delete c.runtime.lastError; } catch {}
            if (callback) callback(result.url);
            return result.url;
        }).catch(err => {
            ipcRenderer.send('ext-identity-auth-end');
            try { c.runtime.lastError = { message: err.message }; } catch {}
            if (callback) callback(undefined);
            return undefined;
        });
        return p;
    };

    // ── tts stub ──────────────────────────────────────────────────────────────
    c.tts = c.tts || {
        speak:      (t, o, cb) => { if (cb) cb(); },
        stop:       () => {},
        pause:      () => {},
        resume:     () => {},
        isSpeaking: (cb) => { if (cb) cb(false); },
        getVoices:  (cb) => { if (cb) cb([]); },
        onEvent:    { addListener: () => {}, removeListener: () => {} },
    };

    // ── sidePanel → IPC (real BrowserView side panel) ─────────────────────────
    c.sidePanel = {
        open:            (opts)  => ipcRenderer.invoke('ext-sidepanel-open',  { extensionId: c.runtime?.id, ...opts }),
        close:           (opts)  => ipcRenderer.invoke('ext-sidepanel-close', opts || {}),
        setOptions:      (opts)  => ipcRenderer.invoke('ext-sidepanel-setopts', { extensionId: c.runtime?.id, ...opts }),
        getOptions:      ()      => Promise.resolve({}),
        setPanelBehavior:()      => Promise.resolve(),
        getPanelBehavior:()      => Promise.resolve({}),
    };

    // ── contextMenus → IPC (items stored in main, shown on right-click) ────────
    {
        const _cmExtId = c.runtime?.id || '';
        c.contextMenus = {
            create: (props, cb) => {
                ipcRenderer.invoke('ext-contextmenu-register', { extId: _cmExtId, props }).catch(() => {});
                if (cb) cb();
            },
            update: (id, props, cb) => {
                ipcRenderer.invoke('ext-contextmenu-register', { extId: _cmExtId, props: { ...props, id } }).catch(() => {});
                if (cb) cb();
            },
            remove: (id, cb) => {
                ipcRenderer.invoke('ext-contextmenu-remove', { extId: _cmExtId, id }).catch(() => {});
                if (cb) cb();
            },
            removeAll: (cb) => {
                ipcRenderer.invoke('ext-contextmenu-removeall', { extId: _cmExtId }).catch(() => {});
                if (cb) cb();
            },
            onClicked: { addListener: () => {}, removeListener: () => {}, hasListener: () => false },
        };
    }

    // ── Auto-grant permission requests ────────────────────────────────────────
    if (!c.permissions) c.permissions = {};
    c.permissions.request  = c.permissions.request  || ((p, cb) => { if (cb) cb(true);  return Promise.resolve(true); });
    c.permissions.contains = c.permissions.contains || ((p, cb) => { if (cb) cb(false); return Promise.resolve(false); });
    c.permissions.remove   = c.permissions.remove   || ((p, cb) => { if (cb) cb(true);  return Promise.resolve(true); });
    // getAll must return {permissions:[], origins:[]} — some extensions spread/iterate the result
    if (!c.permissions.getAll || c.permissions.getAll.toString().includes('native')) {
        c.permissions.getAll = (cb) => {
            const r = { permissions: [], origins: [] };
            if (cb) cb(r);
            return Promise.resolve(r);
        };
    }

    // ── chrome.tabs.create / chrome.tabs.sendMessage / chrome.windows.create ────
    if (c.tabs) {
        try {
            // tabs.create → open in our tab system
            c.tabs.create = (props, cb) => {
                const url = typeof props === 'string' ? props : (props?.url || 'about:blank');
                ipcRenderer.invoke('ext-open-new-tab', { url, active: props?.active !== false }).catch(() => {});
                const tab = { id: -1, url, active: true, index: 0, pinned: false, incognito: false };
                if (cb) cb(tab);
                return Promise.resolve(tab);
            };
            // tabs.sendMessage → IPC → main → CustomEvent in target webContents
            c.tabs.sendMessage = (tabId, message, optsOrCb, maybeCb) => {
                let callback;
                if (typeof optsOrCb === 'function') callback = optsOrCb;
                else if (typeof maybeCb === 'function') callback = maybeCb;
                const p = ipcRenderer.invoke('ext-tabs-send-message', {
                    tabId, message, extensionId: c.runtime?.id || '',
                }).then(r => { if (callback) callback(r); return r; })
                  .catch(() => { if (callback) callback(undefined); });
                return p;
            };
        } catch {}
    }
    if (c.windows) {
        try {
            // windows.create — popup type → real BrowserWindow; normal → tab
            c.windows.create = (props, cb) => {
                const type = props?.type;
                const urls = Array.isArray(props?.url) ? props.url : (props?.url ? [props.url] : []);
                if (type === 'popup' || type === 'detached_panel') {
                    const url = urls[0];
                    if (url) {
                        ipcRenderer.invoke('ext-open-popup-window', {
                            url, width: props?.width, height: props?.height,
                        }).catch(() => {});
                    }
                } else {
                    urls.forEach(u => ipcRenderer.invoke('ext-open-new-tab', { url: u, active: true }).catch(() => {}));
                }
                const win = { id: -1, tabs: urls.map(u => ({ id: -1, url: u, active: true })) };
                if (cb) setTimeout(() => cb(win), 0);
                return Promise.resolve(win);
            };
            c.windows.getCurrent = c.windows.getCurrent || ((opts, cb) => {
                if (typeof opts === 'function') cb = opts;
                if (cb) cb({ id: -1, focused: true, state: 'normal', type: 'normal' });
            });
            c.windows.getLastFocused = c.windows.getLastFocused || ((opts, cb) => {
                if (typeof opts === 'function') cb = opts;
                if (cb) cb({ id: -1, focused: true, state: 'normal', type: 'normal' });
            });
        } catch {}
    }

    // ── chrome.notifications.create → native OS notification ─────────────────
    if (!c.notifications) c.notifications = {};
    try {
        c.notifications.create = (id, opts, cb) => {
            if (typeof id === 'object') { cb = opts; opts = id; id = ''; }
            const nid = id || Math.random().toString(36).slice(2);
            ipcRenderer.invoke('ext-notify', {
                title: opts?.title || '', message: opts?.message || '', iconUrl: opts?.iconUrl || '',
            }).catch(() => {});
            if (cb) cb(nid);
            return Promise.resolve(nid);
        };
        c.notifications.clear     = c.notifications.clear     || ((id, cb) => { if (cb) cb(true); return Promise.resolve(true); });
        c.notifications.getAll    = c.notifications.getAll    || ((cb) => { if (cb) cb({}); return Promise.resolve({}); });
        c.notifications.update    = c.notifications.update    || ((id, opts, cb) => { if (cb) cb(true); return Promise.resolve(true); });
        const _nEv = () => ({ addListener: () => {}, removeListener: () => {}, hasListener: () => false });
        c.notifications.onClicked = c.notifications.onClicked || _nEv();
        c.notifications.onClosed  = c.notifications.onClosed  || _nEv();
    } catch {}

    // ── chrome.runtime.openOptionsPage → open options in a tab ───────────────
    if (c.runtime && !c.runtime.openOptionsPage) {
        c.runtime.openOptionsPage = (cb) => {
            try {
                const mf = c.runtime.getManifest?.() || {};
                const optUrl = mf.options_ui?.page || mf.options_page;
                if (optUrl) {
                    const fullUrl = optUrl.startsWith('http') ? optUrl
                        : `chrome-extension://${c.runtime.id}/${optUrl}`;
                    ipcRenderer.invoke('ext-open-new-tab', { url: fullUrl, active: true }).catch(() => {});
                }
            } catch {}
            if (cb) cb();
        };
    }

    // ── chrome.tabs.query — return the real active BrowserView tab ────────────
    // Electron's BrowserViews are not in Chromium's built-in tab strip, so
    // chrome.tabs.query({active:true}) normally returns []. We override it to
    // ask the main process for our actual active tab via IPC.
    if (c.tabs?.query) {
        const _origQuery = c.tabs.query.bind(c.tabs);
        c.tabs.query = (queryInfo, callback) => {
            const wantsActive = queryInfo.active === true
                             || queryInfo.currentWindow === true
                             || queryInfo.lastFocusedWindow === true;
            if (wantsActive) {
                const tabInfo = ipcRenderer.sendSync('ext-get-active-tab');
                if (tabInfo) {
                    if (callback) callback([tabInfo]);
                    return;
                }
            }
            return _origQuery(queryInfo, callback);
        };
    }

    // ── chrome.scripting.executeScript — fallback via Electron IPC ───────────
    // Our tabIds are Electron webContents IDs, not Chromium tab IDs, so native
    // scripting.executeScript always fails for our BrowserViews (throws "No tab
    // with id: X" or similar, not just "Cannot access contents"). Always fall back
    // to IPC which uses webContents.fromId() and works with our tabId system.
    if (c.scripting?.executeScript) {
        const _orig = c.scripting.executeScript.bind(c.scripting);
        c.scripting.executeScript = async (injection, callback) => {
            try {
                const result = await _orig(injection);
                if (callback) callback(result);
                return result;
            } catch (_err) {
                const result = await ipcRenderer.invoke('ext-execute-script', {
                    tabId:     injection.target?.tabId,
                    allFrames: injection.target?.allFrames,
                    func:      injection.func?.toString(),
                    args:      injection.args,
                    files:     injection.files,
                });
                if (callback) callback(result);
                return result;
            }
        };
    }

    // ── chrome.tabs.executeScript (MV2) — same fallback ──────────────────────
    if (c.tabs?.executeScript) {
        const _orig = c.tabs.executeScript.bind(c.tabs);
        c.tabs.executeScript = (tabIdOrDetails, detailsOrCb, maybeCb) => {
            let tabId, details, cb;
            if (typeof tabIdOrDetails === 'object') {
                details = tabIdOrDetails; cb = detailsOrCb;
                const t = ipcRenderer.sendSync('ext-get-active-tab');
                tabId = t?.id;
            } else {
                tabId = tabIdOrDetails; details = detailsOrCb; cb = maybeCb;
            }
            _orig(tabId, details, (result) => {
                // Fall back for ANY lastError — our tabIds are not Chromium tab IDs
                if (window.chrome?.runtime?.lastError) {
                    ipcRenderer.invoke('ext-execute-script', {
                        tabId, code: details?.code, file: details?.file,
                    }).then(r => { if (cb) cb(r); });
                } else {
                    if (cb) cb(result);
                }
            });
        };
    }
}

// Apply now and after a tick (chrome.* bindings may not be ready synchronously)
patchChrome();
setTimeout(patchChrome, 50);
document.addEventListener('DOMContentLoaded', patchChrome);
