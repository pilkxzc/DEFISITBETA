'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('loginApi', {
    // Returns the saved server URL from server-config.json
    getServerUrl: () => ipcRenderer.invoke('login-get-server-url'),

    // Attempt login: sends credentials to main, which calls POST /api/auth/login
    login: (payload) => ipcRenderer.invoke('login-attempt', payload),
});
