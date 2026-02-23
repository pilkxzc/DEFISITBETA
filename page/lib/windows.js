'use strict';
const { BrowserWindow, app } = require('electron');
const path = require('path');

const state  = require('./state');
const config = require('./config');

const APP_ICON = path.join(__dirname, '..', 'logo.png');

// ── Settings window tracking ──────────────────────────────────────
const settingsWindows    = new Map();  // profileId → BrowserWindow
const settingsWinProfile = new Map();  // windowId  → profileId

// ── Login window ──────────────────────────────────────────────────
let loginWindow = null;

function openLoginWindow() {
    if (loginWindow && !loginWindow.isDestroyed()) { loginWindow.focus(); return; }

    loginWindow = new BrowserWindow({
        width:  420,
        height: 560,
        resizable:    false,
        frame:        false,
        center:       true,
        icon:         APP_ICON,
        backgroundColor: '#030303',
        webPreferences: {
            preload:          path.join(__dirname, '..', 'login-preload.js'),
            contextIsolation: true,
            nodeIntegration:  false,
        },
    });

    loginWindow.loadFile(path.join(__dirname, '..', 'login.html'));
    loginWindow.on('closed', () => { loginWindow = null; });
}

// ── Profile picker window ─────────────────────────────────────────
let pickerWindow = null;

function openProfilePickerWindow() {
    if (pickerWindow && !pickerWindow.isDestroyed()) { pickerWindow.focus(); return; }

    const { profiles } = require('./profiles');
    const cols = Math.min(4, Math.max(1, profiles.length + 1));
    const rows = Math.ceil((profiles.length + 1) / cols);
    const cardW = 148, cardH = 116, gap = 8, padX = 48, padY = 108;
    const w = Math.max(340, Math.min(700, cols * (cardW + gap) - gap + padX));
    const h = Math.max(260, Math.min(580, rows * (cardH + gap) - gap + padY));

    pickerWindow = new BrowserWindow({
        width:  w,
        height: h,
        resizable:    false,
        frame:        false,
        center:       true,
        icon:         APP_ICON,
        backgroundColor: '#030303',
        webPreferences: {
            preload:          path.join(__dirname, '..', 'profile-picker-preload.js'),
            contextIsolation: true,
            nodeIntegration:  false,
        },
    });

    pickerWindow.loadFile(path.join(__dirname, '..', 'profile-picker.html'));
    pickerWindow.on('closed', () => { pickerWindow = null; });
}

// ── Browser window ────────────────────────────────────────────────
function createWindow(profile, { fresh = false } = {}) {
    if (!fresh && state.profileWindows.has(profile.id)) {
        state.profileWindows.get(profile.id).focus();
        return state.profileWindows.get(profile.id);
    }

    const saved  = config.savedWindowStates[profile.id];
    const bounds = saved?.bounds || {};

    const win = new BrowserWindow({
        width:     bounds.width  || 1400,
        height:    bounds.height || 900,
        x:         bounds.x,
        y:         bounds.y,
        minWidth:  900,
        minHeight: 600,
        frame:     false,
        icon:      APP_ICON,
        backgroundColor: '#121212',
        webPreferences: {
            preload:          path.join(__dirname, '..', 'preload.js'),
            contextIsolation: true,
            nodeIntegration:  false,
        },
    });

    if (saved?.maximized) win.maximize();

    state.windowProfiles.set(win.id, profile);
    if (!fresh) state.profileWindows.set(profile.id, win);
    state.windowTabs.set(win.id, new Map());
    state.windowOverlayCount.set(win.id, 0);

    const { applyProxy }             = require('./proxy');
    const { setupDownloads }          = require('./downloads');
    const { loadExtensionsForProfile } = require('./extensions');
    const { loadCookiesForProfile, saveCookiesForProfile } = require('./cookies');

    applyProxy(profile);
    setupDownloads(profile, win);

    loadExtensionsForProfile(profile).catch(() => {});
    loadCookiesForProfile(profile).catch(() => {});

    // Window state persistence (debounced)
    let saveTimer = null;
    const debouncedSave = () => {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => config.saveWindowState(profile.id, win), 500);
    };
    const resizeActiveView = () => {
        const { getViewBounds } = require('./tabs');
        const tabId = state.getActiveId(win);
        if (tabId == null) return;
        const tab = state.getTabs(win).get(tabId);
        if (tab?.view && (state.windowOverlayCount.get(win.id) || 0) === 0)
            tab.view.setBounds(getViewBounds(win));
    };
    win.on('resize',     () => { debouncedSave(); resizeActiveView(); });
    win.on('move',       debouncedSave);
    win.on('maximize',   () => { debouncedSave(); setTimeout(resizeActiveView, 30); });
    win.on('unmaximize', () => { debouncedSave(); setTimeout(resizeActiveView, 30); });

    win.on('close', () => {
        saveCookiesForProfile(profile).catch(() => {});
    });

    win.on('closed', () => {
        state.windowProfiles.delete(win.id);
        if (!fresh) state.profileWindows.delete(profile.id);
        state.windowTabs.delete(win.id);
        state.windowActive.delete(win.id);
        state.searchEngines.delete(win.id);
        state.windowOverlayCount.delete(win.id);
        state.windowNotepadOpen.delete(win.id);
        state.windowAgentOpen.delete(win.id);
        state.windowFindBarOpen.delete(win.id);
        state.pendingUrls.delete(win.id);
        require('../defis-agent').stopAgent(win);
    });

    win.loadFile(path.join(__dirname, '..', 'index.html'));
    return win;
}

// ── Logout: close everything and show login window ─────────────────
function performLogout() {
    const { clearToken } = require('./auth');
    const api = require('../api-client');

    clearToken();
    api.setToken(null);

    // Close all browser windows
    BrowserWindow.getAllWindows().forEach(w => {
        try { if (!w.isDestroyed()) w.close(); } catch {}
    });

    // Small delay so windows finish closing, then show login
    setTimeout(() => openLoginWindow(), 150);
}

// ── IPC ───────────────────────────────────────────────────────────
function registerWindowIPC(ipcMain) {
    const api = require('../api-client');

    // Logout
    ipcMain.handle('logout', () => { performLogout(); return { ok: true }; });

    // Login
    ipcMain.handle('login-get-server-url', () => config.serverConfig.serverUrl || 'http://188.137.178.124:3717');

    ipcMain.handle('login-attempt', async (_e, { serverUrl, email, password }) => {
        const result = await api.login(serverUrl, email, password);
        if (result.ok) {
            if (serverUrl && serverUrl !== config.serverConfig.serverUrl) {
                config.serverConfig.serverUrl = serverUrl;
                config.saveServerConfig();
                api.configure(serverUrl, result.token);
            }
            const { saveToken } = require('./auth');
            saveToken(result.token);

            const { loadProfiles } = require('./profiles');
            const { preCleanGhostSWsFromDisk } = require('./extensions');
            await loadProfiles();
            await config.loadGlobalConfig();
            preCleanGhostSWsFromDisk();
            openProfilePickerWindow();

            if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
        }
        return result;
    });

    // Profile picker
    ipcMain.handle('picker-get-profiles', () => require('./profiles').profiles);

    ipcMain.handle('picker-open-profile', async (_e, profileId) => {
        const { profiles } = require('./profiles');
        const profile = profiles.find(p => p.id === profileId);
        if (!profile) return { ok: false, error: 'Profile not found' };

        createWindow(profile);

        setTimeout(() => {
            if (pickerWindow && !pickerWindow.isDestroyed()) pickerWindow.close();
        }, 200);

        return { ok: true };
    });

    ipcMain.on('picker-create-profile', (_e) => {
        const { profiles } = require('./profiles');
        const defaultProfile = profiles[0];
        if (defaultProfile) createWindow(defaultProfile);
        if (pickerWindow && !pickerWindow.isDestroyed()) pickerWindow.close();
    });

    ipcMain.on('picker-close', () => {
        if (pickerWindow && !pickerWindow.isDestroyed()) pickerWindow.close();
    });

    // Window controls
    ipcMain.on('win-minimize', (e) => state.getWin(e).minimize());
    ipcMain.on('win-maximize', (e) => {
        const w = state.getWin(e);
        w.isMaximized() ? w.unmaximize() : w.maximize();
    });
    ipcMain.on('win-close',      (e) => state.getWin(e).close());
    ipcMain.on('win-fullscreen', (e) => {
        const w = state.getWin(e);
        w.setFullScreen(!w.isFullScreen());
    });

    // Settings window
    ipcMain.on('open-settings', (e, profileId) => {
        const callerWin     = state.getWin(e);
        const callerProfile = state.getProfile(callerWin);
        const targetId      = profileId || callerProfile?.id;

        if (settingsWindows.has(targetId)) { settingsWindows.get(targetId).focus(); return; }

        const swin = new BrowserWindow({
            width: 1100, height: 720,
            minWidth: 800, minHeight: 580,
            icon:    APP_ICON,
            backgroundColor: '#030303',
            webPreferences: {
                preload:          path.join(__dirname, '..', 'settings-preload.js'),
                contextIsolation: true,
                nodeIntegration:  false,
            },
        });

        settingsWinProfile.set(swin.id, targetId);
        settingsWindows.set(targetId, swin);

        swin.on('closed', () => {
            settingsWinProfile.delete(swin.id);
            settingsWindows.delete(targetId);
        });

        swin.loadFile(path.join(__dirname, '..', 'settings.html'));

        if (config.globalConfig.devMode) {
            swin.webContents.once('dom-ready', () => {
                if (!swin.isDestroyed()) swin.webContents.openDevTools({ mode: 'detach' });
            });
        }
    });

    ipcMain.handle('settings-get-init-profile', (e) => {
        const win = BrowserWindow.fromWebContents(e.sender);
        const id  = settingsWinProfile.get(win.id);
        const { profiles } = require('./profiles');
        return profiles.find(p => p.id === id) || profiles[0] || null;
    });
}

module.exports = {
    settingsWindows, settingsWinProfile,
    openLoginWindow, openProfilePickerWindow,
    createWindow,
    registerWindowIPC,
};
