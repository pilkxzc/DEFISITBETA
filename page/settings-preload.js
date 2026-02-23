/**
 * DEFIS Browser — Settings window preload
 * IPC bridge for setings.html
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsApi', {
    getInitProfile:  ()  => ipcRenderer.invoke('settings-get-init-profile'),
    getProfiles:     ()  => ipcRenderer.invoke('get-profiles'),
    getCurrentUser:  ()  => ipcRenderer.invoke('get-current-user'),
    logout:          ()  => ipcRenderer.invoke('logout'),
    updateProfile:  (d) => ipcRenderer.invoke('update-profile', d),
    checkProxy:     (id)=> ipcRenderer.invoke('check-proxy', id),
    getConfig:      ()  => ipcRenderer.invoke('get-config'),
    saveConfig:     (d) => ipcRenderer.invoke('save-config', d),

    // Server URL
    getServerUrl:   ()  => ipcRenderer.invoke('get-server-url'),
    saveServerUrl:  (u) => ipcRenderer.invoke('save-server-url', u),

    // Chrome Extensions
    extInstall:         (d) => ipcRenderer.invoke('ext-install',            d),
    extRemove:          (d) => ipcRenderer.invoke('ext-remove',             d),
    extToggle:          (d) => ipcRenderer.invoke('ext-toggle',             d),
    extListLoaded:      (id)=> ipcRenderer.invoke('ext-list-loaded',        id),
    extScanChrome:      ()  => ipcRenderer.invoke('ext-scan-chrome-profile'),
    extInstallFromLocal:(d) => ipcRenderer.invoke('ext-install-from-local', d),

    // AI Agent
    fetchGeminiModels: (apiKey) => ipcRenderer.invoke('fetch-gemini-models', { apiKey }),

    // Admin / Team
    adminGetUsers:       ()     => ipcRenderer.invoke('admin-get-users'),
    adminCreateUser:     (d)    => ipcRenderer.invoke('admin-create-user', d),
    adminDeleteUser:     (id)   => ipcRenderer.invoke('admin-delete-user', id),
    adminAssignProfiles: (d)    => ipcRenderer.invoke('admin-assign-profiles', d),
    adminGetLogs:        ()     => ipcRenderer.invoke('admin-get-logs'),

    // Version / update
    checkUpdate:         ()               => ipcRenderer.invoke('check-update'),
    adminSetVersion:     (d)              => ipcRenderer.invoke('admin-set-version', d),
    adminPickFile:       (opts)           => ipcRenderer.invoke('admin-pick-file', opts),
    adminUploadRelease:  (filePath, plat) => ipcRenderer.invoke('admin-upload-release', { filePath, platform: plat }),
    adminDeleteRelease:  (plat)           => ipcRenderer.invoke('admin-delete-release', plat),
    openDownloadUrl:     (url)            => ipcRenderer.send('open-download-url', url),
    onUploadProgress:    (cb)             => ipcRenderer.on('upload-progress', (_e, d) => cb(d)),
    offUploadProgress:   ()               => ipcRenderer.removeAllListeners('upload-progress'),
});
