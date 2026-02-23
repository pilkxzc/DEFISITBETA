'use strict';
const { session, net, app } = require('electron');

// ── Build user-agent from profile settings ────────────────────────
function buildUA(profile) {
    const os = profile?.os || 'win11';
    const bv = profile?.browserVersion || 'chrome120';
    const osStr = {
        win11:  'Windows NT 10.0; Win64; x64',
        win10:  'Windows NT 10.0; Win64; x64',
        macos:  'Macintosh; Intel Mac OS X 10_15_7',
        linux:  'X11; Linux x86_64',
    }[os] || 'Windows NT 10.0; Win64; x64';
    if (bv === 'firefox120') {
        return `Mozilla/5.0 (${osStr}; rv:120.0) Gecko/20100101 Firefox/120.0`;
    }
    const cv = { chrome120: '120.0.0.0', chrome119: '119.0.0.0', chrome118: '118.0.0.0' }[bv] || '120.0.0.0';
    return `Mozilla/5.0 (${osStr}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${cv} Safari/537.36`;
}

async function applyProxy(profile) {
    try {
        const sess = session.fromPartition(`persist:${profile.id}`);
        sess.setUserAgent(buildUA(profile));
        const p = profile.proxy;
        if (p?.enabled && p.host && p.port) {
            const prefix = (p.protocol || 'http').toLowerCase() === 'socks5' ? 'socks5' : 'http';
            await sess.setProxy({ proxyRules: `${prefix}://${p.host}:${p.port}`, proxyBypassRules: '<local>' });
        } else {
            await sess.setProxy({ mode: 'direct' });
        }
    } catch (e) { console.error('applyProxy:', e); }
}

async function checkProxyForProfile(profile) {
    if (!profile?.proxy?.enabled) return { ok: true, direct: true };

    try {
        const sess       = session.fromPartition(`persist:${profile.id}`);
        const controller = new AbortController();
        const timer      = setTimeout(() => controller.abort(), 8000);

        let res;
        try {
            res = await net.fetch('https://api.ipify.org?format=json', {
                session: sess,
                signal:  controller.signal,
            });
        } finally {
            clearTimeout(timer);
        }

        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        const data = await res.json();
        return { ok: true, ip: data.ip || 'Unknown' };
    } catch (err) {
        const msg = err.name === 'AbortError'
            ? 'Timeout (8s)'
            : (err.message || String(err));
        return { ok: false, error: msg };
    }
}

// ── Proxy authentication event ────────────────────────────────────
// Call this once during app startup
function registerProxyAuth() {
    const state = require('./state');
    app.on('login', (event, webContents, _details, authInfo, callback) => {
        if (!authInfo.isProxy) return;
        for (const [winId, tabs] of state.windowTabs) {
            for (const [, tab] of tabs) {
                if (tab.view && tab.view.webContents === webContents) {
                    const profile = state.windowProfiles.get(winId);
                    if (profile?.proxy?.enabled && profile.proxy.user) {
                        event.preventDefault();
                        callback(profile.proxy.user, profile.proxy.pass || '');
                    }
                    return;
                }
            }
        }
    });
}

module.exports = { buildUA, applyProxy, checkProxyForProfile, registerProxyAuth };
