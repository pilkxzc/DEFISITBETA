'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pickerApi', {
    getProfiles:   ()         => ipcRenderer.invoke('picker-get-profiles'),
    openProfile:   (profileId) => ipcRenderer.invoke('picker-open-profile', profileId),
    createProfile: ()         => ipcRenderer.send('picker-create-profile'),
    close:         ()         => ipcRenderer.send('picker-close'),
});
