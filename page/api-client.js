'use strict';

/**
 * DEFIS API Client — Node.js (main process) fetch wrapper with JWT.
 * Used from Electron main process (Node context), not from renderer.
 */

const { net } = require('electron');

let _serverUrl = 'http://188.137.178.124:3717';
let _token     = null;

function configure(serverUrl, token) {
    _serverUrl = (serverUrl || 'http://188.137.178.124:3717').replace(/\/$/, '');
    _token     = token || null;
}

function setToken(token) {
    _token = token;
}

function getToken() {
    return _token;
}

/**
 * Make an HTTP request via Electron's net module.
 * Returns { ok, status, data } or throws on network error.
 */
async function request(method, path, body) {
    const url = _serverUrl + path;

    const headers = { 'Content-Type': 'application/json' };
    if (_token) headers['Authorization'] = `Bearer ${_token}`;

    const options = { method, headers };
    if (body !== undefined) options.body = JSON.stringify(body);

    let res;
    try {
        res = await net.fetch(url, options);
    } catch (err) {
        throw new Error(`Network error: ${err.message}`);
    }

    let data;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
        data = await res.json();
    } else {
        data = await res.text();
    }

    return { ok: res.ok, status: res.status, data };
}

async function get(path)         { return request('GET',    path); }
async function post(path, body)  { return request('POST',   path, body); }
async function put(path, body)   { return request('PUT',    path, body); }
async function del(path)         { return request('DELETE', path); }

// ── Auth ──────────────────────────────────────────────────────────

async function me() {
    return get('/api/auth/me');
}

async function login(serverUrl, email, password) {
    const savedUrl = _serverUrl;
    if (serverUrl) _serverUrl = serverUrl.replace(/\/$/, '');
    try {
        const res = await post('/api/auth/login', { email, password });
        if (res.ok && res.data.token) {
            _token = res.data.token;
            _serverUrl = serverUrl ? serverUrl.replace(/\/$/, '') : savedUrl;
            return { ok: true, token: res.data.token, user: res.data.user };
        }
        _serverUrl = savedUrl;
        return { ok: false, error: res.data?.error || 'Login failed' };
    } catch (err) {
        _serverUrl = savedUrl;
        return { ok: false, error: err.message };
    }
}

// ── Profiles ──────────────────────────────────────────────────────

async function getProfiles() {
    const res = await get('/api/profiles');
    return res.ok ? res.data : [];
}

async function updateProfile(data) {
    const res = await put(`/api/profiles/${data.id}`, data);
    return res.ok ? res.data : null;
}

async function createProfile(data) {
    const res = await post('/api/profiles', data);
    return res.ok ? res.data : null;
}

async function deleteProfile(id) {
    const res = await del(`/api/profiles/${id}`);
    return res.ok ? res.data : { ok: false, error: res.data?.error };
}

// ── Cookies ───────────────────────────────────────────────────────

async function getCookies(profileId) {
    const res = await get(`/api/profiles/${profileId}/cookies`);
    return res.ok ? res.data : [];
}

async function saveCookies(profileId, cookies) {
    const res = await put(`/api/profiles/${profileId}/cookies`, cookies);
    return res.ok;
}

// ── Config ────────────────────────────────────────────────────────

async function getConfig() {
    const res = await get('/api/config');
    return res.ok ? res.data : {};
}

async function saveConfig(data) {
    const res = await put('/api/config', data);
    return res.ok ? res.data : {};
}

// ── History ───────────────────────────────────────────────────────

async function getHistory(limit = 100) {
    const res = await get(`/api/history?limit=${limit}`);
    return res.ok ? res.data : [];
}

async function addHistory(profileId, url, title) {
    await post('/api/history', { profileId, url, title });
}

async function clearHistory() {
    await del('/api/history');
}

// ── Bookmarks ─────────────────────────────────────────────────────

async function getBookmarks(profileId) {
    const res = await get(`/api/profiles/${profileId}/bookmarks`);
    return res.ok ? res.data : [];
}

async function addBookmark(profileId, bm) {
    const res = await post(`/api/profiles/${profileId}/bookmarks`, bm);
    return res.ok ? res.data : null;
}

async function removeBookmark(profileId, bmId) {
    const res = await del(`/api/profiles/${profileId}/bookmarks/${bmId}`);
    return res.ok;
}

// ── Notes ─────────────────────────────────────────────────────────

async function getNotes(profileId) {
    const res = await get(`/api/profiles/${profileId}/notes`);
    return res.ok ? res.data : [];
}

async function saveNote(profileId, note) {
    const res = await post(`/api/profiles/${profileId}/notes`, note);
    return res.ok ? res.data : null;
}

async function deleteNote(profileId, noteId) {
    const res = await del(`/api/profiles/${profileId}/notes/${noteId}`);
    return res.ok;
}

// ── Admin ─────────────────────────────────────────────────────────

async function getUsers() {
    const res = await get('/api/admin/users');
    return res.ok ? res.data : [];
}

async function createUser(email, password, name, role) {
    const res = await post('/api/admin/users', { email, password, name, role });
    return res.ok ? { ok: true, user: res.data } : { ok: false, error: res.data?.error };
}

async function deleteUser(id) {
    const res = await del(`/api/admin/users/${id}`);
    return res.ok;
}

async function assignProfiles(userId, profileIds) {
    const res = await put(`/api/admin/users/${userId}/profiles`, profileIds);
    return res.ok;
}

async function getLogs(limit = 200) {
    const res = await get(`/api/admin/logs?limit=${limit}`);
    return res.ok ? res.data : [];
}

// ── Admin user management ─────────────────────────────────────────

async function updateUser(id, data) {
    const res = await put(`/api/admin/users/${id}`, data);
    return res.ok ? res.data : { ok: false, error: res.data?.error };
}

// ── AdsPower ──────────────────────────────────────────────────────

async function adspowerTest() {
    const res = await get('/api/admin/adspower/test');
    return res.ok ? res.data : { ok: false, error: res.data?.error };
}

async function adspowerProfiles() {
    const res = await get('/api/admin/adspower/profiles');
    return res.ok ? res.data : { ok: false, profiles: [], error: res.data?.error };
}

async function adspowerImport(profileIds, opts = {}) {
    const res = await post('/api/admin/adspower/import', { profileIds, ...opts });
    return res.ok ? res.data : { ok: false, error: res.data?.error };
}

// ── Version check ─────────────────────────────────────────────────

async function getLatestVersion() {
    const res = await get('/api/version');
    return res.ok ? res.data : null;
}

async function setLatestVersion(data) {
    const res = await put('/api/version', data);
    return res.ok ? res.data : null;
}

async function deleteRelease(platform) {
    const res = await del(`/api/version/upload/${platform}`);
    return res.ok ? res.data : { ok: false, error: res.data?.error };
}

/**
 * Upload a release file via multipart/form-data.
 * Uses Node's http/https with manual boundary to support progress.
 * @param {string} filePath   - absolute path to file on disk
 * @param {string} platform   - linux | win | mac
 * @param {function} onProgress - (pct: 0-100) => void
 */
function uploadRelease(filePath, platform, onProgress) {
    const http  = require('node:http');
    const https = require('node:https');
    const fs    = require('node:fs');

    return new Promise((resolve, reject) => {
        const fileSize = fs.statSync(filePath).size;
        const fileName = require('node:path').basename(filePath);
        const boundary = '----DefisUpload' + Date.now().toString(16);

        const partHead = Buffer.from(
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
            `Content-Type: application/octet-stream\r\n\r\n`
        );
        const platformPart = Buffer.from(
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="platform"\r\n\r\n` +
            `${platform}\r\n`
        );
        const partTail = Buffer.from(`\r\n--${boundary}--\r\n`);
        const totalSize = platformPart.length + partHead.length + fileSize + partTail.length;

        const url = new URL(_serverUrl + '/api/version/upload');
        const mod = url.protocol === 'https:' ? https : http;

        const req = mod.request({
            hostname: url.hostname,
            port:     url.port || (url.protocol === 'https:' ? 443 : 80),
            path:     url.pathname,
            method:   'POST',
            headers: {
                'Content-Type':   `multipart/form-data; boundary=${boundary}`,
                'Content-Length': totalSize,
                'Authorization':  _token ? `Bearer ${_token}` : undefined,
            },
        }, (res) => {
            let raw = '';
            res.on('data', c => raw += c);
            res.on('end', () => {
                try {
                    const data = JSON.parse(raw);
                    resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, data });
                } catch { resolve({ ok: false, data: { error: raw } }); }
            });
        });

        req.on('error', reject);

        let sent = 0;
        function trackSent(buf) { sent += buf.length; onProgress?.(Math.round(sent / totalSize * 100)); }

        // Write platform field first, then file
        req.write(platformPart); trackSent(platformPart);
        req.write(partHead);     trackSent(partHead);

        const stream = fs.createReadStream(filePath);
        stream.on('data', chunk => { req.write(chunk); trackSent(chunk); });
        stream.on('end',  ()    => { req.write(partTail); req.end(); });
        stream.on('error', reject);
    });
}

module.exports = {
    configure, setToken, getToken,
    me, login,
    getProfiles, updateProfile, createProfile, deleteProfile,
    getCookies, saveCookies,
    getConfig, saveConfig,
    getHistory, addHistory, clearHistory,
    getBookmarks, addBookmark, removeBookmark,
    getNotes, saveNote, deleteNote,
    getUsers, createUser, updateUser, deleteUser, assignProfiles, getLogs,
    adspowerTest, adspowerProfiles, adspowerImport,
    getLatestVersion, setLatestVersion, uploadRelease, deleteRelease,
};
