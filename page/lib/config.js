'use strict';
const { app, BrowserWindow, shell, dialog } = require('electron');
const path = require('path');
const fs   = require('fs');
const api  = require('../api-client');

const state = require('./state');

// ── Semver comparison ─────────────────────────────────────────────
// Returns true if `remote` is strictly newer than `local`
function isNewerVersion(local, remote) {
    try {
        const parse = v => v.split('.').map(Number);
        const [la, lb, lc] = parse(local);
        const [ra, rb, rc] = parse(remote);
        if (ra !== la) return ra > la;
        if (rb !== lb) return rb > lb;
        return rc > lc;
    } catch { return false; }
}

// ── server-config.json ────────────────────────────────────────────
const SERVER_CONFIG_PATH = path.join(__dirname, '..', 'server-config.json');
let serverConfig = { serverUrl: 'http://188.137.178.124:3717' };

function loadServerConfig() {
    try {
        if (fs.existsSync(SERVER_CONFIG_PATH))
            serverConfig = JSON.parse(fs.readFileSync(SERVER_CONFIG_PATH, 'utf8'));
    } catch {}
}

function saveServerConfig() {
    try { fs.writeFileSync(SERVER_CONFIG_PATH, JSON.stringify(serverConfig, null, 2), 'utf8'); } catch {}
}

// ── Global config (cached from API) ───────────────────────────────
let globalConfig = {};

async function loadGlobalConfig() {
    try { globalConfig = await api.getConfig(); } catch {}
}

async function saveGlobalConfig(data) {
    try {
        globalConfig = await api.saveConfig(data);
        return globalConfig;
    } catch { return globalConfig; }
}

// ── Window state persistence (local, lightweight) ─────────────────
let windowStatePath;
let savedWindowStates = {};

function loadWindowStates() {
    windowStatePath = path.join(app.getPath('userData'), 'defis-window-states.json');
    try {
        if (fs.existsSync(windowStatePath))
            savedWindowStates = JSON.parse(fs.readFileSync(windowStatePath, 'utf8'));
    } catch { savedWindowStates = {}; }
}

function saveWindowState(profileId, win) {
    try {
        const maximized = win.isMaximized();
        const bounds    = maximized ? savedWindowStates[profileId]?.bounds || win.getBounds() : win.getBounds();
        savedWindowStates[profileId] = { maximized, bounds };
        fs.writeFileSync(windowStatePath, JSON.stringify(savedWindowStates), 'utf8');
    } catch (e) { console.error('saveWindowState:', e); }
}

// ── Sync status helpers ───────────────────────────────────────────
function broadcastSyncStatus() {
    const status = { connected: state.serverConnected, lastSync: state.lastSyncTime };
    BrowserWindow.getAllWindows().forEach(w => {
        try { if (!w.isDestroyed() && state.windowProfiles.has(w.id)) w.webContents.send('sync-status', status); } catch {}
    });
}

async function checkServerHealth() {
    try {
        const fresh  = await api.getConfig();
        if (fresh) {
            // Inject current app version so settings window can read it
            globalConfig = Object.assign({ appVersion: app.getVersion() }, fresh);
            state.serverConnected = true;
            state.lastSyncTime = new Date().toISOString();
        }
    } catch { state.serverConnected = false; }
    broadcastSyncStatus();
    checkForUpdate().catch(() => {});
}

// ── Version / update check ─────────────────────────────────────────
let _lastUpdateInfo = null;

async function checkForUpdate() {
    try {
        const info = await api.getLatestVersion();
        if (!info) return;
        const current = app.getVersion();
        if (isNewerVersion(current, info.latestVersion)) {
            // Only broadcast if this is a new update we haven't announced yet
            if (!_lastUpdateInfo || _lastUpdateInfo.latestVersion !== info.latestVersion) {
                _lastUpdateInfo = info;
                broadcastUpdateAvailable(info);
            }
        }
    } catch {}
}

function broadcastUpdateAvailable(info) {
    BrowserWindow.getAllWindows().forEach(w => {
        try {
            if (!w.isDestroyed() && state.windowProfiles.has(w.id)) {
                w.webContents.send('update-available', info);
            }
        } catch {}
    });
}

// ── IPC ───────────────────────────────────────────────────────────
function registerConfigIPC(ipcMain) {
    ipcMain.handle('get-config',    ()         => globalConfig);
    ipcMain.handle('save-config',   async (_e, d) => saveGlobalConfig(d));
    ipcMain.handle('get-server-url',() => serverConfig.serverUrl || 'http://188.137.178.124:3717');
    ipcMain.handle('save-server-url', async (_e, url) => {
        serverConfig.serverUrl = url;
        saveServerConfig();
        api.configure(url, api.getToken());
        return { ok: true };
    });
    ipcMain.handle('get-sync-status', () => ({ connected: state.serverConnected, lastSync: state.lastSyncTime }));

    // Admin IPC — users
    ipcMain.handle('admin-get-users',       ()           => api.getUsers());
    ipcMain.handle('admin-create-user',     (_e, d)      => api.createUser(d.email, d.password, d.name, d.role));
    ipcMain.handle('admin-update-user',     (_e, id, d)  => api.updateUser(id, d));
    ipcMain.handle('admin-delete-user',     (_e, id)     => api.deleteUser(id));
    ipcMain.handle('admin-assign-profiles', (_e, d)      => api.assignProfiles(d.userId, d.profileIds));
    ipcMain.handle('admin-get-logs',        ()           => api.getLogs());

    // Admin IPC — AdsPower
    ipcMain.handle('admin-adspower-test',     ()      => api.adspowerTest());
    ipcMain.handle('admin-adspower-profiles', ()      => api.adspowerProfiles());
    ipcMain.handle('admin-adspower-import',   (_e, d) => api.adspowerImport(d.profileIds, d));

    // Current user info
    ipcMain.handle('get-current-user', () => api.me().then(r => r.data?.user ?? r.data).catch(() => null));

    // Version / update IPC
    ipcMain.handle('check-update',  async () => {
        await checkForUpdate();
        return _lastUpdateInfo;
    });

    ipcMain.on('open-download-url', async (_e, url) => {
        if (!url || (!url.startsWith('https://') && !url.startsWith('http://'))) return;

        const os      = require('os');
        const pathMod = require('path');
        const fs      = require('fs');
        const http    = require('node:http');
        const https   = require('node:https');
        const { execFile } = require('child_process');

        // Broadcast install status to all browser windows
        const bcast = (state, extra = {}) => BrowserWindow.getAllWindows().forEach(w => {
            try { if (!w.isDestroyed()) w.webContents.send('update-install-status', { state, ...extra }); } catch {}
        });

        const fileName = decodeURIComponent(url.split('/').pop().split('?')[0]) || 'DEFIS-update';
        const destPath = pathMod.join(os.tmpdir(), fileName);

        bcast('downloading', { pct: 0 });

        // Download with redirect + progress support
        const download = (dlUrl, depth = 0) => new Promise((resolve, reject) => {
            if (depth > 5) return reject(new Error('Too many redirects'));
            const mod = dlUrl.startsWith('https:') ? https : http;
            mod.get(dlUrl, { headers: { 'User-Agent': 'DEFIS-Browser-Updater/1.0' } }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume();
                    return download(res.headers.location, depth + 1).then(resolve).catch(reject);
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    return reject(new Error(`HTTP ${res.statusCode}`));
                }
                const total = parseInt(res.headers['content-length'] || '0');
                const file  = fs.createWriteStream(destPath);
                let received = 0;
                res.on('data', chunk => {
                    file.write(chunk);
                    received += chunk.length;
                    if (total > 0) bcast('downloading', { pct: Math.round(received / total * 100) });
                });
                res.on('end',   () => file.end(() => resolve(destPath)));
                res.on('error', err => { file.destroy(); reject(err); });
                file.on('error', reject);
            }).on('error', reject);
        });

        try {
            await download(url);
            bcast('downloading', { pct: 100 });

            if (process.platform === 'linux') {
                const { clipboard } = require('electron');
                const appImagePath = process.env.APPIMAGE; // set by Electron when running as AppImage
                const isAppImage   = /\.appimage$/i.test(fileName);
                const isPacman     = /\.pacman$/i.test(fileName);

                if (isAppImage) {
                    // ── AppImage file: chmod+x, then self-replace if possible ─
                    bcast('installing');
                    try {
                        fs.chmodSync(destPath, 0o755);
                        if (appImagePath) {
                            // Running AS an AppImage — atomic self-replace
                            try {
                                fs.renameSync(destPath, appImagePath);
                            } catch {
                                fs.copyFileSync(destPath, appImagePath);
                                fs.chmodSync(appImagePath, 0o755);
                                try { fs.unlinkSync(destPath); } catch {}
                            }
                            bcast('done');
                            setTimeout(() => { app.relaunch(); app.exit(0); }, 1500);
                        } else {
                            // Installed via pacman/other — can't self-replace, just open file manager
                            bcast('manual', { path: destPath });
                            dialog.showMessageBox({
                                type:    'info',
                                title:   'Оновлення завантажено',
                                message: `AppImage збережено: ${destPath}`,
                                detail:  'Запустіть файл вручну або скопіюйте в зручне місце.',
                                buttons: ['OK'],
                            }).catch(() => {});
                            shell.showItemInFolder(destPath);
                        }
                    } catch (replaceErr) {
                        bcast('error', { message: `Не вдалося встановити AppImage: ${replaceErr.message}` });
                    }

                } else if (isPacman) {
                    // ── .pacman: pkexec → terminal emulator → manual ──────
                    const manualCmd = `sudo pacman -U --noconfirm "${destPath}"`;
                    bcast('waiting-auth');

                    const doInstall = async () => {
                        // 1) Try pkexec (works when a polkit agent is running)
                        const pkexecOk = await new Promise(resolve => {
                            execFile('pkexec', ['pacman', '-U', '--noconfirm', destPath],
                                { timeout: 120_000 },
                                err => resolve(!err));
                        });
                        if (pkexecOk) return true;

                        // 2) Fall back: open a terminal emulator with sudo
                        bcast('waiting-auth');
                        const donePath   = pathMod.join(os.tmpdir(), '.defis-update-rc');
                        const scriptPath = pathMod.join(os.tmpdir(), '.defis-updater.sh');
                        try { fs.unlinkSync(donePath); } catch {}
                        fs.writeFileSync(scriptPath, [
                            '#!/bin/bash',
                            'echo "=== DEFIS Browser Update ==="',
                            `sudo pacman -U --noconfirm "${destPath}"`,
                            `echo $? > "${donePath}"`,
                            'echo ""',
                            'echo "=== Натисніть Enter для закриття ==="',
                            'read',
                        ].join('\n'), { mode: 0o755 });

                        const { spawn } = require('child_process');
                        const terminals = [
                            ['xterm',          ['-title', 'DEFIS Update', '-e', `bash "${scriptPath}"`]],
                            ['alacritty',      ['-T', 'DEFIS Update', '-e', 'bash', scriptPath]],
                            ['kitty',          ['bash', scriptPath]],
                            ['konsole',        ['--noclose', '-e', 'bash', scriptPath]],
                            ['gnome-terminal', ['--wait', '--', 'bash', scriptPath]],
                            ['xfce4-terminal', ['--', 'bash', scriptPath]],
                            ['foot',           ['bash', scriptPath]],
                            ['wezterm',        ['start', '--', 'bash', scriptPath]],
                        ];

                        for (const [bin, args] of terminals) {
                            const result = await new Promise(resolve => {
                                const child = spawn(bin, args, { detached: false });
                                child.on('error', () => resolve(null)); // binary not found
                                child.on('close', () => {
                                    try {
                                        const rc = parseInt(fs.readFileSync(donePath, 'utf8').trim());
                                        resolve(rc === 0);
                                    } catch { resolve(false); }
                                });
                            });
                            if (result === null) continue; // try next terminal
                            return result;
                        }
                        return false;
                    };

                    setTimeout(async () => {
                        const ok = await doInstall();
                        if (ok) {
                            bcast('done');
                            setTimeout(() => { app.relaunch(); app.exit(0); }, 1500);
                        } else {
                            clipboard.writeText(manualCmd);
                            bcast('manual', { path: destPath });
                            dialog.showMessageBox({
                                type:    'info',
                                title:   'Встановіть оновлення вручну',
                                message: 'Команда скопійована в буфер обміну',
                                detail:  `Відкрийте термінал і вставте:\n\n${manualCmd}`,
                                buttons: ['OK'],
                            }).catch(() => {});
                        }
                    }, 200);

                } else {
                    // ── Невідомий формат — відкрити в менеджері файлів ───
                    bcast('manual', { path: destPath });
                    shell.showItemInFolder(destPath);
                }

            } else if (process.platform === 'win32') {
                bcast('installing');
                execFile(destPath, [], (err) => {
                    if (!err) { bcast('done'); setTimeout(() => app.exit(0), 1000); }
                    else { bcast('manual', { path: destPath }); shell.openPath(destPath); }
                });
            } else {
                shell.openPath(destPath);
                bcast('done');
            }
        } catch (err) {
            bcast('error', { message: err.message });
            shell.openExternal(url);
        }
    });

    // Admin: open native file dialog and return real path
    ipcMain.handle('admin-pick-file', async (_e, { platform }) => {
        const filters = {
            linux: [{ name: 'Linux Package', extensions: ['pacman', 'deb', 'rpm', 'appimage'] }],
            win:   [{ name: 'Windows Installer', extensions: ['exe'] }],
            mac:   [{ name: 'macOS Package', extensions: ['dmg', 'pkg', 'zip'] }],
        };
        const result = await dialog.showOpenDialog({
            title: `Виберіть файл для ${platform}`,
            filters: filters[platform] || [{ name: 'All Files', extensions: ['*'] }],
            properties: ['openFile'],
        });
        if (result.canceled || !result.filePaths.length) return null;
        const filePath = result.filePaths[0];
        const stat = fs.statSync(filePath);
        return { path: filePath, name: path.basename(filePath), size: stat.size };
    });

    ipcMain.handle('admin-set-version', async (_e, data) => {
        const res = await api.setLatestVersion(data);
        return res;
    });

    // Upload release file (filePath = absolute path, platform = linux|win|mac)
    ipcMain.handle('admin-upload-release', async (_e, { filePath, platform }) => {
        // progress events sent back to all settings windows
        const sendProgress = (pct) => {
            BrowserWindow.getAllWindows().forEach(w => {
                try { w.webContents.send('upload-progress', { platform, pct }); } catch {}
            });
        };
        try {
            const result = await api.uploadRelease(filePath, platform, sendProgress);
            return result;
        } catch (err) {
            return { ok: false, data: { error: err.message } };
        }
    });

    ipcMain.handle('admin-delete-release', async (_e, platform) => {
        const res = await api.deleteRelease(platform);
        return res;
    });

    ipcMain.handle('get-platform', () => process.platform);

    // Translator
    ipcMain.on('get-translator-config', (e) => {
        e.returnValue = globalConfig.translator || { enabled: false, sourceLang: 'auto', targetLang: 'uk' };
    });
    ipcMain.handle('translate', async (_e, { text, sl, tl }) => {
        if (!text || !tl) return null;
        const src = sl || 'auto';
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${src}&tl=${tl}&dt=t&dt=ld&q=${encodeURIComponent(text)}`;
        try {
            const { net } = require('electron');
            const res = await net.fetch(url, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' },
            });
            if (!res.ok) return null;
            const data = await res.json();
            const translation  = data[0]?.map(x => x[0]).filter(Boolean).join('') || null;
            const detectedLang = data[2] || null;
            return translation ? { translation, detectedLang } : null;
        } catch { return null; }
    });
}

module.exports = {
    SERVER_CONFIG_PATH,
    get serverConfig()    { return serverConfig; },
    loadServerConfig, saveServerConfig,
    get globalConfig()    { return globalConfig; },
    set globalConfig(v)   { globalConfig = v; },
    loadGlobalConfig, saveGlobalConfig,
    get savedWindowStates() { return savedWindowStates; },
    loadWindowStates, saveWindowState,
    broadcastSyncStatus, checkServerHealth,
    registerConfigIPC,
};
