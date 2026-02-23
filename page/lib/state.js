'use strict';
// ── Shared mutable state (singleton Maps) ─────────────────────────
// All modules import from here. Mutations are performed in-place so
// every module sees the same object references.

const { BrowserWindow } = require('electron');

// Per-window state
const windowProfiles     = new Map();  // windowId  → profile object
const profileWindows     = new Map();  // profileId → BrowserWindow
const windowTabs         = new Map();  // windowId  → Map<tabId, { view }>
const windowActive       = new Map();  // windowId  → activeTabId
const searchEngines      = new Map();  // windowId  → engine name
const windowOverlayCount = new Map();  // windowId  → number of open overlays
const windowNotepadOpen  = new Map();  // windowId  → bool
const windowAgentOpen    = new Map();  // windowId  → bool
const windowFindBarOpen  = new Map();  // windowId  → bool
const pendingUrls        = new Map();  // winId     → url (for fresh extra windows)

let tabCounter = 0;

// Sync status
let serverConnected = false;
let lastSyncTime    = null;

// Browsing history (in-memory buffer, capped at 500)
const browserHistory = [];

// ── Per-window helpers ────────────────────────────────────────────
function getWin(e)        { return BrowserWindow.fromWebContents(e.sender); }
function getProfile(win)  { return windowProfiles.get(win.id); }
function getTabs(win)     { return windowTabs.get(win.id) || new Map(); }
function getActiveId(win) { return windowActive.get(win.id); }

module.exports = {
    windowProfiles, profileWindows, windowTabs, windowActive,
    searchEngines, windowOverlayCount, windowNotepadOpen, windowAgentOpen,
    windowFindBarOpen, pendingUrls,
    get tabCounter()         { return tabCounter; },
    set tabCounter(v)        { tabCounter = v; },
    get serverConnected()    { return serverConnected; },
    set serverConnected(v)   { serverConnected = v; },
    get lastSyncTime()       { return lastSyncTime; },
    set lastSyncTime(v)      { lastSyncTime = v; },
    browserHistory,
    getWin, getProfile, getTabs, getActiveId,
};
