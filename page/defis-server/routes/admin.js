'use strict';

const express  = require('express');
const db       = require('../db');
const { requireAuth, requireAdmin } = require('../auth');
const http     = require('http');
const https    = require('https');
const fs       = require('fs');
const path     = require('path');
const os       = require('os');

const router = express.Router();

router.use(requireAuth, requireAdmin);

// GET /api/admin/users
router.get('/users', (req, res) => {
    res.json(db.getUsers());
});

// POST /api/admin/users
router.post('/users', (req, res) => {
    const { email, password, name, role } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    try {
        const user = db.createUser(email, password, name, role || 'user');
        db.addLog(req.user.id, null, 'create_user', `email=${email},role=${role||'user'}`);
        res.status(201).json(user);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// DELETE /api/admin/users/:id
router.delete('/users/:id', (req, res) => {
    const id = parseInt(req.params.id);
    if (id === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });
    const ok = db.deleteUser(id);
    if (!ok) return res.status(404).json({ error: 'Not found' });
    db.addLog(req.user.id, null, 'delete_user', `id=${id}`);
    res.json({ ok: true });
});

// PUT /api/admin/users/:id  — update role/name/active
router.put('/users/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const { role, name, is_active } = req.body || {};
    try {
        const ok = db.updateUser(id, { role, name, is_active });
        if (!ok) return res.status(404).json({ error: 'Not found' });
        db.addLog(req.user.id, null, 'update_user', `id=${id}`);
        res.json({ ok: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// PUT /api/admin/users/:id/profiles — assign profiles to user
router.put('/users/:id/profiles', (req, res) => {
    const userId     = parseInt(req.params.id);
    const profileIds = Array.isArray(req.body) ? req.body : [];
    db.assignProfilesToUser(userId, profileIds);
    db.addLog(req.user.id, null, 'assign_profiles', `user=${userId},profiles=${profileIds.join(',')}`);
    res.json({ ok: true });
});

// GET /api/admin/logs
router.get('/logs', (req, res) => {
    const limit = parseInt(req.query.limit) || 200;
    res.json(db.getLogs(limit));
});

// ═══════════════════════════════════════════════════════════════════
//  AdsPower integration
// ═══════════════════════════════════════════════════════════════════

const ADSP_BASE = 'http://localhost:50325';

/** GET request to AdsPower local API */
function adspFetch(url) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        const req = mod.get(url, (res) => {
            res.setEncoding('utf8');
            let raw = '';
            res.on('data', c => { raw += c; });
            res.on('end', () => {
                try { resolve(JSON.parse(raw)); }
                catch (e) { reject(new Error(`JSON parse error: ${e.message} (got ${raw.slice(0,80)})`)); }
            });
            res.on('error', reject);
        });
        // Use setTimeout separately so it's a total deadline, not idle timeout
        req.setTimeout(60000, () => { req.destroy(); reject(new Error('AdsPower timeout')); });
        req.on('error', reject);
    });
}

/** POST request to AdsPower local API (used for V2 endpoints) */
function adspPost(url, body) {
    return new Promise((resolve, reject) => {
        const payload = Buffer.from(JSON.stringify(body));
        const u = new URL(url);
        const mod = u.protocol === 'https:' ? https : http;
        const req = mod.request({
            hostname: u.hostname, port: u.port, path: u.pathname,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
            timeout: 8000,
        }, (res) => {
            let raw = '';
            res.on('data', c => raw += c);
            res.on('end', () => {
                try { resolve(JSON.parse(raw)); }
                catch { reject(new Error('Invalid JSON from AdsPower')); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('AdsPower timeout')); });
        req.write(payload);
        req.end();
    });
}

/**
 * Fetch ALL AdsPower profiles using V1 API with pagination.
 * Per docs: increment page until list is empty [].
 * page_size max=100, default=1 — must be set explicitly.
 */
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchAllAdspProfiles() {
    const PAGE = 100;
    const DELAY = 600; // ms between pages — avoids "Too many requests" rate limit
    const all = [];
    let page = 1;
    while (true) {
        let data;
        try {
            data = await adspFetch(
                `${ADSP_BASE}/api/v1/user/list?page=${page}&page_size=${PAGE}`
            );
        } catch (e) {
            console.error(`[AdsPower] page ${page} fetch error:`, e.message);
            break;
        }
        // Retry once if rate-limited
        if (data && String(data.code) === '-1' && data.msg?.includes('Too many')) {
            console.log(`[AdsPower] rate limited on page ${page}, retrying after 1s…`);
            await sleep(1000);
            try { data = await adspFetch(`${ADSP_BASE}/api/v1/user/list?page=${page}&page_size=${PAGE}`); }
            catch (e) { break; }
        }
        if (!data || String(data.code) !== '0') {
            console.error(`[AdsPower] page ${page} bad code:`, data?.code, data?.msg);
            break;
        }
        const list = data.data?.list || [];
        if (list.length === 0) break;
        all.push(...list);
        console.log(`[AdsPower] page ${page}: got ${list.length}, total so far: ${all.length}`);
        if (list.length < PAGE) break;
        page++;
        await sleep(DELAY);
    }
    all.sort((a, b) => parseInt(a.serial_number || 0, 10) - parseInt(b.serial_number || 0, 10));
    return all;
}

/**
 * Detect AdsPower profile user-data directory.
 * Returns the Cookies file path if found, else null.
 */
function adspCookiePath(userId) {
    const candidates = [];
    const home = os.homedir();
    if (process.platform === 'linux') {
        // Arch / new AdsPower layout
        candidates.push(path.join(home, '.config', 'adspower_global', 'cwd_global', 'source', 'cache', userId, 'Default', 'Cookies'));
        // Legacy layout
        candidates.push(path.join(home, '.config', 'adspower_global', 'cwd', userId, 'Default', 'Cookies'));
        candidates.push(path.join(home, '.config', 'AdsPower', 'cwd', userId, 'Default', 'Cookies'));
        candidates.push(path.join(home, '.config', 'AdsPower Global', 'cwd', userId, 'Default', 'Cookies'));
    } else if (process.platform === 'darwin') {
        candidates.push(path.join(home, 'Library', 'Application Support', 'adspower_global', 'cwd_global', 'source', 'cache', userId, 'Default', 'Cookies'));
        candidates.push(path.join(home, 'Library', 'Application Support', 'adspower_global', 'cwd', userId, 'Default', 'Cookies'));
    } else {
        const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
        candidates.push(path.join(local, 'AdsPower Global', 'cwd', userId, 'Default', 'Cookies'));
        candidates.push(path.join(local, 'AdsPower', 'cwd', userId, 'Default', 'Cookies'));
    }
    return candidates.find(p => fs.existsSync(p)) || null;
}

/** Read cookies from Chrome Cookies SQLite file.
 *  Returns only unencrypted cookies (value != '' or encrypted_value is empty). */
function readChromeCookies(cookiesFile) {
    try {
        const Database = require('better-sqlite3');
        const cdb = new Database(cookiesFile, { readonly: true, fileMustExist: true });
        const rows = cdb.prepare(`
            SELECT host_key, name, value, encrypted_value, path, expires_utc,
                   is_secure, is_httponly, samesite
            FROM cookies
        `).all();
        cdb.close();

        const cookies = [];
        for (const r of rows) {
            // Skip encrypted cookies (encrypted_value non-empty AND value is empty string)
            const hasEncrypted = r.encrypted_value && r.encrypted_value.length > 0;
            const plainValue   = r.value || '';
            if (hasEncrypted && !plainValue) continue; // encrypted, skip

            // Chrome stores expiry as microseconds since 1601-01-01
            // Convert to Unix epoch seconds
            const expiresUnix = r.expires_utc
                ? Math.floor((Number(r.expires_utc) - 11644473600_000_000) / 1_000_000)
                : 0;

            cookies.push({
                domain:   r.host_key,
                name:     r.name,
                value:    plainValue,
                path:     r.path || '/',
                expires:  expiresUnix > 0 ? expiresUnix : undefined,
                secure:   !!r.is_secure,
                httpOnly: !!r.is_httponly,
                sameSite: r.samesite === 1 ? 'lax' : r.samesite === 2 ? 'strict' : 'none',
            });
        }
        return cookies;
    } catch { return []; }
}

/** Convert AdsPower profile object (V2) → DEFIS profile object */
function convertAdspProfile(adsp) {
    // V2: profile_id, profile_no, user_proxy_config
    // V1 fallback: user_id, serial_number
    const fp  = adsp.fingerprint_config || {};
    const prx = adsp.user_proxy_config  || {};

    // OS mapping
    let defiOs = 'win11';
    const osRaw = (fp.ostype || fp.os || '').toLowerCase();
    if      (osRaw.includes('win') && (fp.os || '').includes('10')) defiOs = 'win10';
    else if (osRaw.includes('win'))  defiOs = 'win11';
    else if (osRaw.includes('mac'))  defiOs = 'macos';
    else if (osRaw.includes('lin'))  defiOs = 'linux';

    // Browser version
    const verRaw = fp.browser_kernel_config?.version
        || fp.version
        || '120';
    const browserVersion = `chrome${String(verRaw).replace(/[^0-9]/g, '') || '120'}`;

    // Proxy
    const proxyType = (prx.proxy_type || '').toLowerCase();
    const proxyEnabled = proxyType !== '' && proxyType !== 'noproxy' && proxyType !== 'no_proxy';
    const proxy = {
        enabled:  proxyEnabled,
        protocol: proxyType === 'socks5' ? 'socks5' : 'http',
        host:     prx.proxy_host || '',
        port:     String(prx.proxy_port || ''),
        user:     prx.proxy_user || '',
        pass:     prx.proxy_password || '',
    };

    // Fingerprint
    const fingerprint = {
        ua:     fp.ua || '',
        webgl:  fp.webgl !== 0 && fp.webgl !== false,
        canvas: fp.canvas !== 0 && fp.canvas !== false,
        audio:  fp.audio_switch !== 0 && fp.audio_switch !== false,
    };

    // Timezone
    const timezone = fp.automatic_timezone === 1 ? 'auto' : 'manual';
    const timezoneValue = fp.timezone || 'Europe/Kyiv';

    // Fonts
    const fonts = 1; // default on

    // DNT
    const dnt = (fp.do_not_track === '1' || fp.do_not_track === 1) ? 1 : 0;

    // Name — use serial_number as fallback if name is empty
    const serial   = adsp.profile_no || adsp.serial_number || '';
    const rawName  = (adsp.name || '').trim();
    const baseName = rawName || (serial ? `Profile #${serial}` : 'AdsPower Profile');

    return {
        name:           baseName,
        color:          randomProfileColor(),
        os:             defiOs,
        browserVersion,
        proxy,
        fingerprint,
        timezone,
        timezoneValue,
        dnt,
        fonts,
        _adspId:        adsp.profile_id || adsp.user_id || adsp.id,
    };
}

const PROFILE_COLORS = ['#9d7cce','#e06c75','#61afef','#98c379','#e5c07b','#56b6c2','#c678dd','#abb2bf'];
let _colorIdx = 0;
function randomProfileColor() {
    return PROFILE_COLORS[(_colorIdx++) % PROFILE_COLORS.length];
}

// ── GET /api/admin/adspower/test ──────────────────────────────────
router.get('/adspower/test', async (req, res) => {
    try {
        // Single call — fetchAllAdspProfiles handles connectivity + full count
        const all = await fetchAllAdspProfiles();
        if (all.length > 0) {
            res.json({ ok: true, total: all.length });
        } else {
            // Try a minimal ping to distinguish "0 profiles" from "not running"
            const ping = await adspFetch(`${ADSP_BASE}/api/v1/user/list?page=1&page_size=1`).catch(() => null);
            if (ping && String(ping.code) === '0') {
                res.json({ ok: true, total: 0 });
            } else {
                res.json({ ok: false, error: ping?.msg || 'AdsPower not reachable' });
            }
        }
    } catch (e) {
        res.json({ ok: false, error: e.message });
    }
});

// ── GET /api/admin/adspower/debug-pages — debug pagination ────────
router.get('/adspower/debug-pages', requireAuth, async (req, res) => {
    const results = [];
    for (let page = 1; page <= 6; page++) {
        try {
            const data = await adspFetch(
                `${ADSP_BASE}/api/v1/user/list?page=${page}&page_size=100`
            );
            results.push({
                page,
                code: data?.code,
                msg: data?.msg,
                count: data?.data?.list?.length ?? null,
                first: data?.data?.list?.[0]?.serial_number ?? null,
                last: data?.data?.list?.slice(-1)[0]?.serial_number ?? null,
            });
            if (!data || String(data.code) !== '0' || (data.data?.list?.length ?? 0) === 0) break;
        } catch (e) {
            results.push({ page, error: e.message });
            break;
        }
    }
    res.json(results);
});

// ── GET /api/admin/adspower/profiles ─────────────────────────────
router.get('/adspower/profiles', async (req, res) => {
    try {
        const list = await fetchAllAdspProfiles();
        const preview = list.map(p => {
            // V2 fields: profile_id, profile_no, user_proxy_config
            const id  = p.profile_id || p.user_id || p.id || '';
            const prx = p.user_proxy_config || {};
            const proxyType = (prx.proxy_type || prx.proxy_soft || '').toLowerCase();
            const cookiePath = adspCookiePath(id);
            const serial = p.profile_no || p.serial_number || '';
            const rawName = (p.name || '').trim();

            return {
                id,
                name:        rawName || (serial ? `Profile #${serial}` : id),
                serial,
                remark:      p.remark || '',
                group:       p.group_name || 'Default',
                proxy_type:  (proxyType === 'noproxy' || proxyType === 'no_proxy' || proxyType === '')
                                 ? 'none' : proxyType,
                has_cookies: !!cookiePath,
            };
        });
        res.json({ ok: true, profiles: preview, total: preview.length });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ── POST /api/admin/adspower/import ──────────────────────────────
router.post('/adspower/import', async (req, res) => {
    const { profileIds, importCookies = true } = req.body || {};

    try {
        const allProfiles = await fetchAllAdspProfiles();
        let toImport = allProfiles;

        if (Array.isArray(profileIds) && profileIds.length > 0) {
            const idSet = new Set(profileIds);
            toImport = allProfiles.filter(p => idSet.has(p.profile_id || p.user_id || p.id));
        }

        const results = { imported: 0, skipped: 0, cookies_imported: 0, errors: [] };

        // Collect existing profile names to avoid duplicates
        const existingNames = new Set(
            db.getProfiles(req.user.id, 'admin').map(p => p.name)
        );

        for (const adsp of toImport) {
            try {
                const converted = convertAdspProfile(adsp);
                const adspId    = converted._adspId;
                delete converted._adspId;

                // Ensure unique name
                let finalName = converted.name;
                if (existingNames.has(finalName)) {
                    let suffix = 2;
                    while (existingNames.has(`${finalName} (${suffix})`)) suffix++;
                    finalName = `${finalName} (${suffix})`;
                }
                converted.name = finalName;
                existingNames.add(finalName);

                const profile = db.createProfile(converted);
                db.addLog(req.user.id, profile.id, 'import_from_adspower', `adsp_id=${adspId}`);
                results.imported++;

                // Cookies
                if (importCookies && adspId) {
                    const cookieFile = adspCookiePath(adspId);
                    if (cookieFile) {
                        const cookies = readChromeCookies(cookieFile);
                        if (cookies.length > 0) {
                            db.saveCookies(profile.id, cookies);
                            results.cookies_imported += cookies.length;
                        }
                    }
                }
            } catch (e) {
                results.errors.push({ id: adsp.profile_id || adsp.user_id || adsp.id, name: adsp.name, error: e.message });
                results.skipped++;
            }
        }

        res.json({ ok: true, ...results });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

module.exports = router;
