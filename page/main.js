'use strict';
// ── DEFIS Browser — main process bootstrap ────────────────────────
// GPU flags MUST be set before app.whenReady()
const { app, ipcMain, protocol } = require('electron');

// Register custom defis-ipc:// scheme BEFORE app ready.
// Extension Service Workers use fetch('defis-ipc://action', {method:'POST', body})
// to reach the main process without needing an open popup window.
protocol.registerSchemesAsPrivileged([{
    scheme: 'defis-ipc',
    privileges: { standard: false, secure: true, corsEnabled: true, supportFetchAPI: true, allowServiceWorkers: true },
}]);

app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('disable-gpu-vsync');
app.commandLine.appendSwitch('disable-features',
    'VaapiVideoDecoder,VaapiVideoEncoder,ExtensionsMenuAccessControl');

// ── Module imports ────────────────────────────────────────────────
const fs  = require('fs');
const api = require('./api-client');

const { loadSavedToken, saveToken, clearToken } = require('./lib/auth');
const config = require('./lib/config');
const { loadProfiles }    = require('./lib/profiles');
const { registerProxyAuth } = require('./lib/proxy');
const { setExtensionsDir, preCleanGhostSWsFromDisk } = require('./lib/extensions');
const { openLoginWindow, openProfilePickerWindow, createWindow } = require('./lib/windows');

// ── IPC registration ──────────────────────────────────────────────
const { registerTabIPC }       = require('./lib/tabs');
const { registerWindowIPC }    = require('./lib/windows');
const { registerProfileIPC }   = require('./lib/profiles');
const { registerExtensionIPC } = require('./lib/extensions');
const { registerConfigIPC }    = require('./lib/config');

registerTabIPC(ipcMain);
registerWindowIPC(ipcMain);
registerProfileIPC(ipcMain);
registerExtensionIPC(ipcMain);
registerConfigIPC(ipcMain);

// Register proxy auth event handler
registerProxyAuth();

// ── App startup ───────────────────────────────────────────────────
async function startApp() {
    const path = require('path');
    const extensionsDir = path.join(app.getPath('userData'), 'defis-extensions');
    fs.mkdirSync(extensionsDir, { recursive: true });
    setExtensionsDir(extensionsDir);

    config.loadServerConfig();
    config.loadWindowStates();

    const savedToken = loadSavedToken();

    if (!savedToken) {
        openLoginWindow();
        return;
    }

    api.configure(config.serverConfig.serverUrl, savedToken);

    try {
        const authRes = await api.me();
        if (authRes.status === 401 || authRes.status === 403) {
            clearToken();
            openLoginWindow();
            return;
        }
    } catch {
        // Server offline — proceed without auth check (offline mode)
    }

    await loadProfiles().catch(() => {});

    // Ensure at least a placeholder profile so the window opens
    // (only reached when server is offline and profiles can't be fetched)
    const profMod = require('./lib/profiles');
    if (profMod.profiles.length === 0) {
        profMod.profiles = [{
            id: 'default', name: 'Default', color: '#9d7cce',
            proxy: { enabled: false, protocol: 'http', host: '', port: '', user: '', pass: '' },
        }];
    }

    await config.loadGlobalConfig().catch(() => {});
    preCleanGhostSWsFromDisk();
    openProfilePickerWindow();

    // Server health check every 30 s
    config.checkServerHealth().catch(() => {});
    setInterval(() => config.checkServerHealth().catch(() => {}), 30000);
}

// ── App lifecycle ─────────────────────────────────────────────────
app.whenReady().then(startApp);

app.on('window-all-closed', () => {
    app.exit(0);
});

app.on('activate', () => {
    const { BrowserWindow } = require('electron');
    const profMod = require('./lib/profiles');
    if (BrowserWindow.getAllWindows().length === 0) {
        if (profMod.profiles.length > 0) createWindow(profMod.profiles[0]);
        else openLoginWindow();
    }
});
