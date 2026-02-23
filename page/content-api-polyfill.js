// DEFIS Browser — isolated-world API polyfill
// Injected at document_start into EVERY extension's isolated world,
// before the extension's own content scripts, to fix APIs that
// Electron does not implement in content-script contexts.
(function () {
    if (typeof chrome === 'undefined') return;

    // ── Background → Content message bridge ─────────────────────────────────
    // When chrome.tabs.sendMessage(tabId, msg) is called from a background SW,
    // the main process dispatches a CustomEvent into the page's main world.
    // This listener in the isolated world picks it up and forwards it to
    // chrome.runtime.onMessage, which content scripts use to receive messages.
    try {
        window.addEventListener('__defis_ext_msg__', function(ev) {
            try {
                var detail = ev.detail || {};
                var message = detail.message;
                var sender  = detail.sender || {};
                var reqId   = detail.reqId;
                if (message === undefined || message === null) return;
                if (!chrome.runtime || !chrome.runtime.onMessage) return;
                // Build real sendResponse: dispatches __defis_ext_resp__ which ext-preload relays to main
                var _responded = false;
                var sendResponse = function(data) {
                    if (_responded) return;
                    _responded = true;
                    if (reqId) {
                        try {
                            window.dispatchEvent(new CustomEvent('__defis_ext_resp__', {
                                detail: { reqId: reqId, data: data }, bubbles: false
                            }));
                        } catch(e) {}
                    }
                };
                if (typeof chrome.runtime.onMessage.dispatch === 'function') {
                    chrome.runtime.onMessage.dispatch(message, sender, sendResponse);
                } else if (typeof chrome.runtime.onMessage.emit === 'function') {
                    chrome.runtime.onMessage.emit(message, sender, sendResponse);
                }
            } catch(e) {}
        }, false);
    } catch(e) {}

    // ── storage.sync → local fallback ────────────────────────────────
    // @plasmohq/storage and many extensions default to area:"sync".
    // Electron throws "sync is not available" in SW / isolated worlds.
    if (chrome.storage && chrome.storage.local) {
        const _local = chrome.storage.local;
        try {
            Object.defineProperty(chrome.storage, 'sync', {
                get: () => _local, set: () => {}, configurable: true, enumerable: true,
            });
        } catch {
            try {
                chrome.storage = new Proxy(chrome.storage, {
                    get(t, p) { return p === 'sync' ? t.local : Reflect.get(t, p); },
                });
            } catch {}
        }
    }

    // ── storage.onChanged relay: local → sync ─────────────────────────
    // Because sync is redirected to local, change events fire with area="local".
    // @plasmohq/storage checks `if (area !== this.area) return` where this.area="sync",
    // so its listeners never fire. Fix: wrap addListener to also call fn with area="sync"
    // whenever a local storage change occurs.
    try {
        if (chrome.storage?.onChanged) {
            const _origOnChanged = chrome.storage.onChanged;
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
                Object.defineProperty(chrome.storage, 'onChanged', {
                    get: () => _proxied, configurable: true, enumerable: true,
                });
            } catch {
                // Fallback: replace addListener directly on the event object
                const _origAdd = _origOnChanged.addListener.bind(_origOnChanged);
                _origOnChanged.addListener = (fn) => {
                    _origAdd((changes, area) => {
                        fn(changes, area);
                        if (area === 'local') fn(changes, 'sync');
                    });
                };
            }
        }
    } catch {}
})();
