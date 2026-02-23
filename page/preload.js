const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    // ── Bootstrap ───────────────────────────────────────────────
    requestInit:  () => ipcRenderer.send('request-init'),

    // ── Tabs ────────────────────────────────────────────────────
    newTab:        (url)  => ipcRenderer.send('new-tab', url),
    switchTab:     (id)   => ipcRenderer.send('switch-tab', id),
    closeTab:      (id)   => ipcRenderer.send('close-tab', id),
    duplicateTab:  (id)   => ipcRenderer.send('duplicate-tab', id),
    reloadTab:     (id)   => ipcRenderer.send('reload-tab', id),
    copyTabUrl:    (id)   => ipcRenderer.send('copy-tab-url', id),
    navigate:     (url)   => ipcRenderer.send('navigate', { url }),
    goBack:       ()      => ipcRenderer.send('go-back'),
    goForward:    ()      => ipcRenderer.send('go-forward'),
    reload:       ()      => ipcRenderer.send('reload'),

    // ── Search engine ────────────────────────────────────────────
    setSearchEngine: (e)  => ipcRenderer.send('set-search-engine', e),

    // ── Profiles ─────────────────────────────────────────────────
    getProfiles:   ()     => ipcRenderer.invoke('get-profiles'),
    createProfile: (d)    => ipcRenderer.invoke('create-profile', d),
    updateProfile: (d)    => ipcRenderer.invoke('update-profile', d),
    deleteProfile: (id)   => ipcRenderer.invoke('delete-profile', id),
    openProfile:   (id)   => ipcRenderer.send('open-profile', id),

    // ── History ──────────────────────────────────────────────────
    getHistory:   ()      => ipcRenderer.invoke('get-history'),
    clearHistory: ()      => ipcRenderer.send('clear-history'),

    // ── Cache ────────────────────────────────────────────────────
    clearCache:   ()      => ipcRenderer.invoke('clear-cache'),

    // ── Overlay (hide BrowserView while menus/modals are visible) ─
    overlayOpen:  ()      => ipcRenderer.send('overlay-open'),
    overlayClose: ()      => ipcRenderer.send('overlay-close'),

    // ── Proxy status ──────────────────────────────────────────────
    checkProxy:   (id)    => ipcRenderer.invoke('check-proxy', id),

    // ── Extensions ────────────────────────────────────────────────
    extGetForProfile: (id) => ipcRenderer.invoke('ext-get-for-profile', id),
    extOpenPopup:     (d)  => ipcRenderer.invoke('ext-open-popup', d),
    extInstall:       (d)  => ipcRenderer.invoke('ext-install',     d),

    // ── Sync status & profile control ────────────────────────────────
    getSyncStatus:   ()   => ipcRenderer.invoke('get-sync-status'),
    restartProfile:  ()   => ipcRenderer.invoke('restart-profile'),
    openExtraWindow: (d)  => ipcRenderer.invoke('open-extra-window', d),

    // ── Settings window ───────────────────────────────────────────
    openSettings: (id)    => ipcRenderer.send('open-settings', id),

    // ── Notepad panel ─────────────────────────────────────────────
    notepadOpen:  ()      => ipcRenderer.send('notepad-open'),
    notepadClose: ()      => ipcRenderer.send('notepad-close'),

    // ── AI Agent panel ────────────────────────────────────────────
    agentOpen:    ()      => ipcRenderer.send('agent-open'),
    agentClose:   ()      => ipcRenderer.send('agent-close'),
    agentStart:   (task)  => ipcRenderer.send('agent-start', { task }),
    agentStop:    ()      => ipcRenderer.send('agent-stop'),
    onAgentEvent: (cb)    => ipcRenderer.on('agent-event', (_, d) => cb(d)),
    notesGet:     (d)     => ipcRenderer.invoke('notes-get', d),
    notesSave:    (d)     => ipcRenderer.invoke('notes-save', d),
    notesDelete:  (d)     => ipcRenderer.invoke('notes-delete', d),

    // ── Navigation extras ─────────────────────────────────────────
    hardReload:      ()   => ipcRenderer.send('hard-reload'),
    viewSource:      ()   => ipcRenderer.send('view-source'),

    // ── Find in page ──────────────────────────────────────────────
    findBarOpen:     ()   => ipcRenderer.send('find-bar-open'),
    findBarClose:    ()   => ipcRenderer.send('find-bar-close'),
    findInPage:      (d)  => ipcRenderer.send('find-in-page', d),
    onFindResult:    (cb) => ipcRenderer.on('find-result', (_, d) => cb(d)),

    // ── Bookmarks ─────────────────────────────────────────────────
    bookmarksGet:    ()   => ipcRenderer.invoke('bookmarks-get'),
    bookmarksAdd:    (d)  => ipcRenderer.invoke('bookmarks-add', d),
    bookmarksRemove: (d)  => ipcRenderer.invoke('bookmarks-remove', d),

    // ── Page screenshot (for transparent menu overlay) ────────────
    captureActivePage: () => ipcRenderer.invoke('capture-active-page'),

    // ── DevTools ──────────────────────────────────────────────────
    openDevTools:  ()     => ipcRenderer.send('open-devtools'),

    // ── Dev Mode ──────────────────────────────────────────────────────
    toggleDevMode: ()     => ipcRenderer.invoke('toggle-dev-mode'),
    getConfig:     ()     => ipcRenderer.invoke('get-config'),

    // ── Window controls ──────────────────────────────────────────
    winMinimize:    ()    => ipcRenderer.send('win-minimize'),
    winMaximize:    ()    => ipcRenderer.send('win-maximize'),
    winClose:       ()    => ipcRenderer.send('win-close'),
    winFullscreen:  ()    => ipcRenderer.send('win-fullscreen'),

    // ── Events FROM main ─────────────────────────────────────────
    onTabCreated:       (cb) => ipcRenderer.on('tab-created',        (_, d) => cb(d)),
    onTabClosed:        (cb) => ipcRenderer.on('tab-closed',         (_, d) => cb(d)),
    onTabUpdate:        (cb) => ipcRenderer.on('tab-update',         (_, d) => cb(d)),
    onActiveTabChanged: (cb) => ipcRenderer.on('active-tab-changed', (_, d) => cb(d)),
    onSetProfile:       (cb) => ipcRenderer.on('set-profile',        (_, d) => cb(d)),
    onProfilesChanged:  (cb) => ipcRenderer.on('profiles-changed',   (_, d) => cb(d)),
    onDownloadStarted:  (cb) => ipcRenderer.on('download-started',   (_, d) => cb(d)),
    onDownloadProgress: (cb) => ipcRenderer.on('download-progress',  (_, d) => cb(d)),
    onDownloadDone:     (cb) => ipcRenderer.on('download-done',      (_, d) => cb(d)),
    onSyncStatus:       (cb) => ipcRenderer.on('sync-status',        (_, d) => cb(d)),
    onProfileRestarted: (cb) => ipcRenderer.on('profile-restarted',  ()     => cb()),

    // ── Shortcuts forwarded from BrowserView (before-input-event) ─
    onShortcutFind:         (cb) => ipcRenderer.on('shortcut-find',         () => cb()),
    onShortcutFocusAddress: (cb) => ipcRenderer.on('shortcut-focus-address',() => cb()),
    onShortcutBookmark:     (cb) => ipcRenderer.on('shortcut-bookmark',     () => cb()),
    onShortcutHistory:      (cb) => ipcRenderer.on('shortcut-history',      () => cb()),
    onShortcutRestoreTab:   (cb) => ipcRenderer.on('shortcut-restore-tab',  () => cb()),

    // ── Extension → browser tab bridge ───────────────────────────
    // Fired when an extension calls chrome.tabs.create / chrome.windows.create
    onExtOpenNewTab:    (cb) => ipcRenderer.on('ext-open-new-tab',    (_, d) => cb(d)),

    // ── Chrome Web Store integration ──────────────────────────────
    // Fired when the active tab navigates to a CWS extension detail page
    onCwsExtDetected:   (cb) => ipcRenderer.on('cws-ext-detected',    (_, d) => cb(d)),
    // Fired when extension is installed (to refresh UI)
    onExtInstalled:     (cb) => ipcRenderer.on('ext-installed',       (_, d) => cb(d)),

    // ── Version / update ─────────────────────────────────────────
    checkUpdate:            ()  => ipcRenderer.invoke('check-update'),
    openDownloadUrl:    (url)   => ipcRenderer.send('open-download-url', url),
    onUpdateAvailable:  (cb)    => ipcRenderer.on('update-available',      (_, d) => cb(d)),
    onUpdateInstallStatus: (cb) => ipcRenderer.on('update-install-status', (_, d) => cb(d)),
    getPlatform:            ()  => ipcRenderer.invoke('get-platform'),

    // ── Server URL ────────────────────────────────────────────────
    getServerUrl:   () => ipcRenderer.invoke('get-server-url'),

    // ── Current user info ─────────────────────────────────────────
    getCurrentUser: () => ipcRenderer.invoke('get-current-user'),
    logout:         () => ipcRenderer.invoke('logout'),

    // ── Admin: users ──────────────────────────────────────────────
    adminGetUsers:       ()      => ipcRenderer.invoke('admin-get-users'),
    adminCreateUser:     (d)     => ipcRenderer.invoke('admin-create-user', d),
    adminUpdateUser:     (id, d) => ipcRenderer.invoke('admin-update-user', id, d),
    adminDeleteUser:     (id)    => ipcRenderer.invoke('admin-delete-user', id),
    adminAssignProfiles: (d)     => ipcRenderer.invoke('admin-assign-profiles', d),
    adminGetLogs:        ()      => ipcRenderer.invoke('admin-get-logs'),

    // ── Admin: AdsPower ───────────────────────────────────────────
    adspTest:     ()  => ipcRenderer.invoke('admin-adspower-test'),
    adspProfiles: ()  => ipcRenderer.invoke('admin-adspower-profiles'),
    adspImport:   (d) => ipcRenderer.invoke('admin-adspower-import', d),
});
