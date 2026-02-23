'use strict';
const { BrowserWindow } = require('electron');
const api = require('../api-client');

let profiles = [];

function genId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

async function loadProfiles() {
    try {
        profiles = await api.getProfiles();
        if (!Array.isArray(profiles)) profiles = [];
    } catch (e) {
        console.error('loadProfiles API error:', e.message);
        profiles = [];
    }

    // Ensure at least one default profile exists
    if (profiles.length === 0) {
        const def = await api.createProfile({
            id:    'default',
            name:  'Default',
            color: '#9d7cce',
            proxy: { enabled: false, protocol: 'http', host: '', port: '', user: '', pass: '' },
        }).catch(() => null);
        if (def) profiles = [def];
    }
}

function broadcastProfiles() {
    BrowserWindow.getAllWindows().forEach(w => w.webContents.send('profiles-changed', profiles));
}

// ── IPC ───────────────────────────────────────────────────────────
function registerProfileIPC(ipcMain) {
    const state = require('./state');

    ipcMain.handle('get-profiles', () => profiles);

    ipcMain.handle('create-profile', async (_e, data) => {
        const profile = await api.createProfile({
            id:    genId(),
            name:  (data.name || 'Профіль').trim(),
            color: data.color || '#9d7cce',
            proxy: data.proxy || { enabled: false, protocol: 'http', host: '', port: '', user: '', pass: '' },
        });
        if (profile) {
            profiles.push(profile);
            broadcastProfiles();
        }
        return profile;
    });

    ipcMain.handle('update-profile', async (_e, data) => {
        const updated = await api.updateProfile(data);
        if (updated) {
            const idx = profiles.findIndex(p => p.id === updated.id);
            if (idx >= 0) profiles[idx] = updated; else profiles.push(updated);
            const { applyProxy } = require('./proxy');
            await applyProxy(updated);
            broadcastProfiles();
        }
        return updated;
    });

    ipcMain.handle('delete-profile', async (e, id) => {
        const callerProfile = state.getProfile(state.getWin(e));
        if (callerProfile?.id === id) return { ok: false, reason: 'own' };
        if (profiles.length <= 1)    return { ok: false, reason: 'last' };
        const result = await api.deleteProfile(id);
        if (result?.ok) {
            profiles = profiles.filter(p => p.id !== id);
            if (state.profileWindows.has(id)) state.profileWindows.get(id).close();
            broadcastProfiles();
        }
        return result;
    });

    ipcMain.on('open-profile', (_e, profileId) => {
        const profile = profiles.find(p => p.id === profileId);
        if (profile) {
            const { createWindow } = require('./windows');
            createWindow(profile);
        }
    });

    // History & cache
    const { browserHistory } = require('./state');
    ipcMain.handle('get-history', async () => {
        try { return await api.getHistory(100); } catch { return browserHistory.slice(0, 100); }
    });
    ipcMain.on('clear-history', async () => {
        browserHistory.length = 0;
        try { await api.clearHistory(); } catch {}
    });
    ipcMain.handle('clear-cache', async (e) => {
        const { session } = require('electron');
        const profile = state.getProfile(state.getWin(e));
        if (!profile) return false;
        const sess = session.fromPartition(`persist:${profile.id}`);
        await sess.clearCache();
        await sess.clearStorageData({ storages: ['cookies','localstorage','sessionstorage','indexdb','cachestorage'] });
        return true;
    });

    // Bookmarks
    ipcMain.handle('bookmarks-get', async (e) => {
        const profile = state.getProfile(state.getWin(e));
        if (!profile) return [];
        return api.getBookmarks(profile.id).catch(() => []);
    });
    ipcMain.handle('bookmarks-add', async (e, { url, title }) => {
        const profile = state.getProfile(state.getWin(e));
        if (!profile || !url) return { ok: false };
        await api.addBookmark(profile.id, { url, title: title || url });
        return { ok: true };
    });
    ipcMain.handle('bookmarks-remove', async (e, { id }) => {
        const profile = state.getProfile(state.getWin(e));
        if (!profile) return { ok: false };
        await api.removeBookmark(profile.id, id);
        return { ok: true };
    });

    // Notes
    ipcMain.handle('notes-get', async (e, { profileId } = {}) => {
        const pid = profileId || state.getProfile(state.getWin(e))?.id;
        if (!pid) return [];
        return api.getNotes(pid).catch(() => []);
    });
    ipcMain.handle('notes-save', async (e, note) => {
        const profile = state.getProfile(state.getWin(e));
        if (!profile) return null;
        return api.saveNote(profile.id, note).catch(() => null);
    });
    ipcMain.handle('notes-delete', async (e, { id }) => {
        const profile = state.getProfile(state.getWin(e));
        if (!profile) return { ok: false };
        await api.deleteNote(profile.id, id);
        return { ok: true };
    });
}

module.exports = {
    get profiles()    { return profiles; },
    set profiles(v)   { profiles = v; },
    genId, loadProfiles, broadcastProfiles,
    registerProfileIPC,
};
