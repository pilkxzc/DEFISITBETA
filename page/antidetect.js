/**
 * DEFIS Browser — Anti-detect preload
 * Runs in each BrowserView (contextIsolation: false)
 * Profile config is passed via additionalArguments: --defis-profile=<encoded JSON>
 */

// ── Parse per-profile config ──────────────────────────────────────
const _arg = (typeof process !== 'undefined' && process.argv || [])
    .find(a => typeof a === 'string' && a.startsWith('--defis-profile='));

let _cfg = {};
if (_arg) {
    try { _cfg = JSON.parse(decodeURIComponent(_arg.slice('--defis-profile='.length))); } catch(e) {}
}

const _fp  = _cfg.fingerprint || { canvas: true, webgl: true, audioContext: true, geolocation: true };
const _os  = _cfg.os || 'win11';
const _bv  = _cfg.browserVersion || 'chrome120';
const _dnt = !!_cfg.dnt;

// ── Seeded PRNG (deterministic per profile) ───────────────────────
// Mulberry32 — ensures canvas/audio noise is stable across calls for the same profile.
// Without this, Math.random() gives different values every call, causing plugin
// "flickering" issues (security plugins detect inconsistent canvas reads as tampering).
(function() {
    let _s = 0xDEFB;
    const _pid = String(_cfg.id || '');
    for (let i = 0; i < _pid.length; i++) _s = (Math.imul(_s, 31) + _pid.charCodeAt(i)) & 0xFFFFFFFF;
    function _rng() {
        _s += 0x6D2B79F5;
        let t = _s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    window.__defis_rng = _rng;
})();

// ── Build UA & platform strings from config ───────────────────────
const _platform = { win11: 'Win32', win10: 'Win32', macos: 'MacIntel', linux: 'Linux x86_64' }[_os] || 'Win32';
const _osStr    = {
    win11:  'Windows NT 10.0; Win64; x64',
    win10:  'Windows NT 10.0; Win64; x64',
    macos:  'Macintosh; Intel Mac OS X 10_15_7',
    linux:  'X11; Linux x86_64',
}[_os] || 'Windows NT 10.0; Win64; x64';

let _ua;
if (_bv === 'firefox120') {
    _ua = `Mozilla/5.0 (${_osStr}; rv:120.0) Gecko/20100101 Firefox/120.0`;
} else {
    const _cv = { chrome120: '120.0.0.0', chrome119: '119.0.0.0', chrome118: '118.0.0.0' }[_bv] || '120.0.0.0';
    _ua = `Mozilla/5.0 (${_osStr}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${_cv} Safari/537.36`;
}

// ── Platform & User-Agent DOM override ───────────────────────────
try { Object.defineProperty(navigator, 'platform',   { get: () => _platform, configurable: true }); } catch(e){}
try { Object.defineProperty(navigator, 'userAgent',  { get: () => _ua,       configurable: true }); } catch(e){}
try { Object.defineProperty(navigator, 'appVersion', { get: () => _ua.replace('Mozilla/', ''), configurable: true }); } catch(e){}
try { Object.defineProperty(navigator, 'languages',  { get: () => ['uk-UA', 'uk', 'en-US', 'en'], configurable: true }); } catch(e){}
try { Object.defineProperty(navigator, 'webdriver',  { get: () => false, configurable: true }); } catch(e){}
try { Object.defineProperty(navigator, 'vendor',     { get: () => 'Google Inc.', configurable: true }); } catch(e){}

// ── navigator.userAgentData (Chrome User-Agent Client Hints API) ──
// Many modern extensions and sites use this to detect Chrome.
// Electron does not expose this by default → build a compliant mock.
try {
    if (!navigator.userAgentData) {
        const _cv = (_bv === 'firefox120') ? null
            : ({ chrome120: '120', chrome119: '119', chrome118: '118' }[_bv] || '120');
        if (_cv) {
            const _uaBrands = [
                { brand: 'Chromium',       version: _cv },
                { brand: 'Google Chrome',  version: _cv },
                { brand: 'Not-A.Brand',    version: '99' },
            ];
            const _uaDataMobile = false;
            const _uaDataPlatform = (_os === 'macos') ? 'macOS' : (_os === 'linux') ? 'Linux' : 'Windows';
            const _uaData = {
                brands:   _uaBrands,
                mobile:   _uaDataMobile,
                platform: _uaDataPlatform,
                getHighEntropyValues(hints) {
                    const r = {};
                    const _map = {
                        brands:          _uaBrands,
                        mobile:          _uaDataMobile,
                        platform:        _uaDataPlatform,
                        architecture:    'x86',
                        bitness:         '64',
                        model:           '',
                        platformVersion: (_os === 'win11') ? '15.0.0' : (_os === 'macos') ? '12.0.0' : '',
                        fullVersionList:  _uaBrands.map(b => ({ brand: b.brand, version: b.version + '.0.0.0' })),
                        uaFullVersion:   _cv + '.0.0.0',
                    };
                    for (const h of (hints || [])) if (h in _map) r[h] = _map[h];
                    return Promise.resolve(r);
                },
                toJSON() {
                    return { brands: _uaBrands, mobile: _uaDataMobile, platform: _uaDataPlatform };
                },
            };
            Object.defineProperty(navigator, 'userAgentData', {
                get: () => _uaData, configurable: true, enumerable: true,
            });
        }
    }
} catch(e){}

// ── Ensure window.chrome exists (some sites / extensions check it) ─
try {
    if (typeof window.chrome === 'undefined') {
        window.chrome = {};
    }
    // Minimal chrome.app stub (checked by bot detectors)
    if (!window.chrome.app) {
        window.chrome.app = {
            isInstalled: false,
            InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
            RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
            getDetails:   () => null,
            getIsInstalled: () => false,
            runningState: () => 'cannot_run',
        };
    }
    // csi (Chrome Internal) stub
    if (!window.chrome.csi) {
        window.chrome.csi = () => ({
            startE: Date.now(),
            onloadT: Date.now(),
            pageT: Date.now() - performance.timeOrigin,
            tran: 15,
        });
    }
    // loadTimes stub
    if (!window.chrome.loadTimes) {
        window.chrome.loadTimes = () => ({
            requestTime:        performance.timeOrigin / 1000,
            startLoadTime:      performance.timeOrigin / 1000,
            commitLoadTime:     performance.timeOrigin / 1000,
            finishDocumentLoadTime: 0,
            finishLoadTime:     0,
            firstPaintTime:     0,
            firstPaintAfterLoadTime: 0,
            navigationType:    'Other',
            wasFetchedViaSpdy: false,
            wasNpnNegotiated:  false,
            npnNegotiatedProtocol: 'http/1.1',
            wasAlternateProtocolAvailable: false,
            connectionInfo:    'http/1.1',
        });
    }
} catch(e){}

// ── Do Not Track ──────────────────────────────────────────────────
if (_dnt) {
    try { Object.defineProperty(navigator, 'doNotTrack', { get: () => '1', configurable: true }); } catch(e){}
}

// ── Canvas fingerprint: micro-noise ──────────────────────────────
if (_fp.canvas !== false) {
    try {
        // Always create 2D contexts with willReadFrequently=true to suppress
        // the "Multiple readback operations are faster with willReadFrequently" warning.
        const _origGetCtx = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function(type, attrs) {
            if (type === '2d') attrs = Object.assign({ willReadFrequently: true }, attrs || {});
            return _origGetCtx.call(this, type, attrs);
        };

        const _origToDU = HTMLCanvasElement.prototype.toDataURL;
        HTMLCanvasElement.prototype.toDataURL = function(type, quality) {
            const ctx = this.getContext && this.getContext('2d');
            if (ctx) {
                try {
                    const px = ctx.getImageData(0, 0, 1, 1);
                    px.data[0] ^= (window.__defis_rng() * 2) | 0;
                    ctx.putImageData(px, 0, 0);
                } catch(e) {}
            }
            return _origToDU.call(this, type, quality);
        };

        const _origGID = CanvasRenderingContext2D.prototype.getImageData;
        CanvasRenderingContext2D.prototype.getImageData = function(x, y, w, h) {
            const data = _origGID.call(this, x, y, w, h);
            data.data[0] ^= (window.__defis_rng() * 2) | 0;
            return data;
        };
    } catch(e) {}
}

// ── WebGL vendor / renderer spoof ────────────────────────────────
if (_fp.webgl !== false) {
    function _patchWebGL(ctor) {
        try {
            const orig = ctor.prototype.getParameter;
            ctor.prototype.getParameter = function(p) {
                if (p === 37445) return 'Intel Inc.';               // UNMASKED_VENDOR_WEBGL
                if (p === 37446) return 'Intel Iris OpenGL Engine'; // UNMASKED_RENDERER_WEBGL
                return orig.call(this, p);
            };
        } catch(e) {}
    }
    if (window.WebGLRenderingContext)  _patchWebGL(WebGLRenderingContext);
    if (window.WebGL2RenderingContext) _patchWebGL(WebGL2RenderingContext);
}

// ── AudioContext noise ────────────────────────────────────────────
if (_fp.audioContext !== false) {
    try {
        const _AC = window.AudioContext || window.webkitAudioContext;
        if (_AC) {
            const _origCA = _AC.prototype.createAnalyser;
            _AC.prototype.createAnalyser = function() {
                const analyser = _origCA.call(this);
                const _origGFFD = analyser.getFloatFrequencyData.bind(analyser);
                analyser.getFloatFrequencyData = function(arr) {
                    _origGFFD(arr);
                    for (let i = 0; i < arr.length; i++) {
                        if (arr[i] !== -Infinity) arr[i] += (window.__defis_rng() - 0.5) * 0.01;
                    }
                };
                return analyser;
            };
        }
    } catch(e) {}
}

// ── Hide Electron markers ─────────────────────────────────────────
try { if (typeof module  !== 'undefined') delete window.module;  } catch(e){}
try { if (typeof require !== 'undefined') delete window.require; } catch(e){}

// ── Fonts spoofing ────────────────────────────────────────────────
if (_cfg.fonts !== false) {
    const _fontsWin   = new Set(['Arial','Arial Black','Calibri','Cambria','Comic Sans MS','Courier New','Georgia','Impact','Segoe UI','Tahoma','Times New Roman','Trebuchet MS','Verdana','Wingdings']);
    const _fontsMac   = new Set(['Arial','Courier New','Georgia','Helvetica','Helvetica Neue','Times New Roman','Trebuchet MS','Verdana']);
    const _fontsLinux = new Set(['DejaVu Sans','DejaVu Serif','Liberation Sans','Liberation Serif','Ubuntu','Ubuntu Mono']);
    const _allowedFonts = (_os === 'macos') ? _fontsMac : (_os === 'linux') ? _fontsLinux : _fontsWin;
    try {
        const _origCheck = document.fonts.check.bind(document.fonts);
        document.fonts.check = function(font, text) {
            const m = /(?:^|\s)["']?([^"',0-9][^"',]*)["']?\s*$/.exec(font);
            const family = m ? m[1].trim() : '';
            if (family && !_allowedFonts.has(family)) return false;
            return _origCheck(font, text);
        };
    } catch(e) {}
}

// ── Timezone spoofing ─────────────────────────────────────────────
if (_cfg.timezone === 'manual' && _cfg.timezoneValue) {
    const _tz = _cfg.timezoneValue;
    try {
        const _OrigDTF = Intl.DateTimeFormat;
        Intl.DateTimeFormat = function(locale, opts = {}) {
            if (!opts.timeZone) opts = { ...opts, timeZone: _tz };
            return new _OrigDTF(locale, opts);
        };
        Object.assign(Intl.DateTimeFormat, _OrigDTF);
        Intl.DateTimeFormat.prototype = _OrigDTF.prototype;
    } catch(e) {}
    try {
        Date.prototype.getTimezoneOffset = function() {
            const d = new Date(this.valueOf());
            const utcStr = d.toLocaleString('en-US', { timeZone: 'UTC' });
            const tzStr  = d.toLocaleString('en-US', { timeZone: _tz });
            return (new Date(utcStr) - new Date(tzStr)) / 60000;
        };
    } catch(e) {}
}


// ── chrome.storage.sync stub for content scripts ──────────────────
// Content scripts on regular pages can call chrome.storage.sync but Electron
// doesn't always support it. Redirect sync → local to prevent "sync is not
// available" uncaught promise errors.
try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        const _loc = chrome.storage.local;
        try {
            Object.defineProperty(chrome.storage, 'sync', {
                get: () => _loc, set: () => {}, configurable: true, enumerable: true,
            });
        } catch {
            try { chrome.storage.sync = _loc; } catch {}
        }
    }
} catch(e) {}

// WebRTC IP handling is set in BrowserView webPreferences:
// webrtcIPHandlingPolicy: 'disable_non_proxied_udp'
