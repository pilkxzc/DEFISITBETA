# Chrome Extension Support

> DEFIS supports loading unpacked Chrome extensions (CRX3) with full Manifest V2 and V3 compatibility via a custom Electron shim layer.

---

## Table of Contents

- [Installing Extensions](#installing-extensions)
- [API Support Matrix](#api-support-matrix)
- [API Reference & Usage Examples](#api-reference--usage-examples)
  - [chrome.storage](#chromestorage)
  - [chrome.tabs](#chrometabs)
  - [chrome.windows](#chromewindows)
  - [chrome.notifications](#chromenotifications)
  - [chrome.contextMenus](#chromecontextmenus)
  - [chrome.sidePanel](#chromesidepanel)
  - [chrome.alarms](#chromealarms)
  - [chrome.identity](#chromeidentity)
  - [chrome.scripting / executeScript](#chromescripting--executescript)
  - [chrome.action / browserAction](#chromeaction--browsertaction)
  - [chrome.permissions](#chromepermissions)
  - [chrome.tts](#chrometts)
  - [chrome.webNavigation](#chromewebnavigation)
  - [declarativeNetRequest (DNR)](#declarativenetrequest-dnr)
- [Architecture](#architecture)
- [Manifest Patching](#manifest-patching)
- [Known Limitations](#known-limitations)

---

## Installing Extensions

### From the Chrome Web Store (by ID)

```js
// Renderer — trigger via the Extensions menu
ipcRenderer.invoke('ext-install', {
  profileId:   'my-profile-id',
  extensionId: 'cjpalhdlnbpafiamejdnhcphjbkeiagm', // uBlock Origin
});
```

The extension CRX3 file is fetched from the Chrome Web Store, extracted to:

```
<Electron userData>/defis-extensions/<extension-id>/
```

### From a Local Chrome / Chromium Profile

The UI scans common extension directories automatically:

```
~/.config/google-chrome/Default/Extensions/
~/.config/chromium/Default/Extensions/
~/.config/BraveSoftware/Brave-Browser/Default/Extensions/
~/snap/chromium/common/chromium/Default/Extensions/
```

```js
// Renderer
const found = await ipcRenderer.invoke('ext-scan-chrome-profile');
// found: [{ id, name, version, sourceDir, icon }]

await ipcRenderer.invoke('ext-install-from-local', {
  profileId:   'my-profile-id',
  extensionId: found[0].id,
  sourceDir:   found[0].sourceDir,
});
```

### From an Unpacked Directory

1. Unzip / extract your `.crx` file into a directory.
2. Open **Extensions** menu → **Load Extension** → select the directory.

The extension is loaded via `session.loadExtension(path, { allowFileAccess: true })`.

### Managing Extensions

```js
// Toggle enabled/disabled
await ipcRenderer.invoke('ext-toggle', { profileId, extensionId, enabled: false });

// Remove
await ipcRenderer.invoke('ext-remove', { profileId, extensionId });

// List loaded in a session
const list = await ipcRenderer.invoke('ext-list-loaded', profileId);
// list: [{ id, name }]

// Get info for toolbar (icons, popup presence)
const info = await ipcRenderer.invoke('ext-get-for-profile', profileId);
// info: [{ id, electronId, name, loaded, icon, hasPopup }]
```

---

## API Support Matrix

| Chrome API | MV2 | MV3 | Notes |
|---|---|---|---|
| `chrome.storage.local` | ✅ | ✅ | Native Electron |
| `chrome.storage.sync` | ✅ | ✅ | Redirected to `storage.local` |
| `chrome.storage.onChanged` | ✅ | ✅ | Fires for both `local` and `sync` areas |
| `chrome.tabs.query` | ✅ | ✅ | Returns real active BrowserView tab |
| `chrome.tabs.create` | ✅ | ✅ | Opens in DEFIS tab system |
| `chrome.tabs.sendMessage` | ✅ | ✅ | Full relay via IPC + CustomEvent |
| `chrome.tabs.executeScript` | ✅ | — | MV2; falls back to IPC |
| `chrome.windows.create` | ✅ | ✅ | `popup` → real `BrowserWindow` |
| `chrome.windows.getCurrent` | ✅ | ✅ | |
| `chrome.windows.getLastFocused` | ✅ | ✅ | |
| `chrome.runtime.sendMessage` | ✅ | ✅ | Native |
| `chrome.runtime.onMessage` | ✅ | ✅ | Native + polyfill bridge |
| `chrome.runtime.getURL` | ✅ | ✅ | Native |
| `chrome.runtime.openOptionsPage` | ✅ | ✅ | Opens options in a new tab |
| `chrome.runtime.onConnect` | ✅ | ✅ | Stub (no-op) |
| `chrome.action.setBadgeText` | — | ✅ | Stub (no visible badge) |
| `chrome.action.setBadgeBackgroundColor` | — | ✅ | Stub |
| `chrome.action.setIcon` | — | ✅ | Stub |
| `chrome.action.setTitle` | — | ✅ | Stub |
| `chrome.action.setPopup` | — | ✅ | Stub |
| `chrome.action.onClicked` | — | ✅ | Dispatched on toolbar click |
| `chrome.browserAction` | ✅ | ✅ | Aliased to `chrome.action` |
| `chrome.notifications.create` | ✅ | ✅ | → Native OS notification |
| `chrome.notifications.clear` | ✅ | ✅ | No-op (always resolves true) |
| `chrome.notifications.update` | ✅ | ✅ | No-op stub |
| `chrome.notifications.getAll` | ✅ | ✅ | Returns `{}` |
| `chrome.contextMenus.create` | ✅ | ✅ | Shown in right-click menu |
| `chrome.contextMenus.update` | ✅ | ✅ | |
| `chrome.contextMenus.remove` | ✅ | ✅ | |
| `chrome.contextMenus.removeAll` | ✅ | ✅ | |
| `chrome.contextMenus.onClicked` | ✅ | ✅ | Dispatched to background SW |
| `chrome.sidePanel.open` | — | ✅ | Real `BrowserView` (380 px wide) |
| `chrome.sidePanel.close` | — | ✅ | |
| `chrome.sidePanel.setOptions` | — | ✅ | Can change panel URL at runtime |
| `chrome.alarms.create` | ✅ | ✅ | Backed by `setTimeout` / `setInterval` |
| `chrome.alarms.get / getAll` | ✅ | ✅ | |
| `chrome.alarms.clear / clearAll` | ✅ | ✅ | |
| `chrome.alarms.onAlarm` | ✅ | ✅ | |
| `chrome.identity.launchWebAuthFlow` | ✅ | ✅ | Opens auth window, captures redirect |
| `chrome.identity.getRedirectURL` | ✅ | ✅ | |
| `chrome.identity.getAuthToken` | ⚠️ | ⚠️ | Returns `null` (no Google account) |
| `chrome.scripting.executeScript` | — | ✅ | Falls back to IPC on failure |
| `chrome.permissions.request` | ✅ | ✅ | Always grants |
| `chrome.permissions.contains` | ✅ | ✅ | Always returns `false` |
| `chrome.permissions.remove` | ✅ | ✅ | Always grants |
| `chrome.permissions.getAll` | ✅ | ✅ | Returns `{permissions:[],origins:[]}` |
| `chrome.tts.speak` | ✅ | ✅ | Stub (silent) |
| `chrome.webNavigation.*` | ✅ | ✅ | Event stubs (no-op listeners) |
| `chrome.cookies.get/set` | ✅ | ✅ | Via Electron session |
| `chrome.history` | ⚠️ | ⚠️ | Partial |
| `chrome.webRequest` | ⚠️ | — | Partial (MV2 only) |
| `declarativeNetRequest` (static) | — | ✅ | Rules loaded from `rule_resources` |
| `declarativeNetRequest` (dynamic) | — | ✅ | Via `defis-ipc://dnr-update` |
| Native messaging | ❌ | ❌ | Not supported |
| `chrome.enterprise` / `chrome.sync` | ❌ | ❌ | Not supported |

---

## API Reference & Usage Examples

### chrome.storage

`storage.sync` is silently redirected to `storage.local`. Change events fire with both `area="local"` and `area="sync"` so libraries like `@plasmohq/storage` work correctly.

```js
// Background SW or content script — no changes needed
chrome.storage.sync.set({ key: 'value' }, () => {
  console.log('Saved'); // works — goes to storage.local
});

chrome.storage.sync.get(['key'], (result) => {
  console.log(result.key); // 'value'
});

chrome.storage.onChanged.addListener((changes, area) => {
  // fires for area="local" AND area="sync"
  if (changes.key) console.log('Changed:', changes.key.newValue);
});
```

---

### chrome.tabs

`chrome.tabs.query({ active: true })` returns the real active `BrowserView` tab instead of an empty array.

```js
// Get the current active tab
chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  console.log(tab.url, tab.title, tab.id);
});

// Open a new tab
chrome.tabs.create({ url: 'https://example.com' }, (tab) => {
  console.log('Opened:', tab.url);
});

// Send a message to a content script in a tab
chrome.tabs.sendMessage(tab.id, { action: 'highlight' }, (response) => {
  console.log('Content script replied:', response);
});
```

In the content script (`sendResponse` callback works correctly):

```js
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'highlight') {
    document.body.style.outline = '3px solid red';
    sendResponse({ ok: true });
  }
  return true; // keep the channel open for async sendResponse
});
```

---

### chrome.windows

```js
// Open a popup window — creates a real frameless BrowserWindow
chrome.windows.create({
  url:    'chrome-extension://<id>/popup.html',
  type:   'popup',
  width:  400,
  height: 600,
});

// Open URLs in new tabs instead
chrome.windows.create({ url: 'https://example.com', type: 'normal' });

// Get current window info
chrome.windows.getCurrent((win) => {
  console.log(win.id, win.state); // -1, 'normal'
});
```

Popup windows:
- Auto-resize based on rendered content (`ResizeObserver`).
- Close on `Escape` or when they lose focus (unless a child window — e.g. DevTools, auth dialog — is focused).
- `F12` / `Ctrl+Shift+I` opens detached DevTools.

---

### chrome.notifications

Maps directly to Electron's native `Notification` API.

```js
chrome.notifications.create('my-id', {
  type:     'basic',
  title:    'Task Complete',
  message:  'Your export finished successfully.',
  iconUrl:  'icons/icon48.png',
}, (notificationId) => {
  console.log('Shown:', notificationId);
});

chrome.notifications.clear('my-id');
```

---

### chrome.contextMenus

Context menu items are stored in the main process and injected into the Electron right-click menu.

```js
// Background SW
chrome.contextMenus.create({
  id:       'translate',
  title:    'Translate "%s"',
  contexts: ['selection'],
});

chrome.contextMenus.create({
  id:       'save-link',
  title:    'Save Link',
  contexts: ['link'],
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'translate') {
    console.log('Selected text:', info.selectionText);
  }
});
```

Supported context values: `page`, `selection`, `link`, `image`, `video`, `audio`, `editable`, `all`.

---

### chrome.sidePanel

Opens a real `BrowserView` anchored to the right side of the profile window (380 px wide).

```js
// MV3 — open the panel declared in manifest.json
// manifest.json:
// "side_panel": { "default_path": "panel/panel.html" }

chrome.sidePanel.open({ tabId: tab.id });

// Change the panel URL at runtime
chrome.sidePanel.setOptions({ path: 'panel/settings.html' });

// Close the panel
chrome.sidePanel.close();
```

The panel is created with the profile's session partition and the `ext-preload.js` preload, so all `chrome.*` APIs work inside it.

---

### chrome.alarms

Backed by `setTimeout` / `setInterval` inside the Service Worker context. Survives as long as the SW process is alive.

```js
// Fire once after 5 minutes
chrome.alarms.create('refresh', { delayInMinutes: 5 });

// Repeat every 30 minutes, starting immediately
chrome.alarms.create('sync', { periodInMinutes: 30 });

// Fire at a specific time
chrome.alarms.create('meeting', { when: Date.now() + 60_000 });

chrome.alarms.onAlarm.addListener((alarm) => {
  console.log('Alarm fired:', alarm.name);
});

// Cancel
chrome.alarms.clear('refresh');
chrome.alarms.clearAll();

// Query
chrome.alarms.get('sync', (alarm) => console.log(alarm?.scheduledTime));
chrome.alarms.getAll((alarms) => console.log(alarms.length));
```

---

### chrome.identity

`launchWebAuthFlow` opens a real `BrowserWindow` and captures the OAuth redirect URL. Works from both the background SW (via `defis-ipc://`) and from popup pages (via IPC).

```js
// Works from background SW and popup alike
chrome.identity.launchWebAuthFlow(
  {
    url: 'https://accounts.google.com/o/oauth2/auth?' + new URLSearchParams({
      client_id:    'YOUR_CLIENT_ID',
      redirect_uri: chrome.identity.getRedirectURL(),
      response_type:'token',
      scope:        'email profile',
    }),
    interactive: true,
  },
  (redirectUrl) => {
    if (chrome.runtime.lastError) {
      console.error(chrome.runtime.lastError.message);
      return;
    }
    const token = new URL(redirectUrl).hash.match(/access_token=([^&]+)/)?.[1];
    console.log('Token:', token);
  }
);
```

The auth window closes automatically when the redirect URL starts with `https://<extensionId>.chromiumapp.org/`.

---

### chrome.scripting / executeScript

`chrome.scripting.executeScript` falls back to an IPC-based injection when Chromium's native call fails (which it always does for DEFIS `BrowserView` tabs, because tab IDs are Electron `webContents` IDs, not Chromium tab IDs).

```js
// MV3 — inject a function
const [{ result }] = await chrome.scripting.executeScript({
  target: { tabId: tab.id },
  func:   (color) => {
    document.body.style.backgroundColor = color;
    return document.title;
  },
  args: ['#ffeb3b'],
});
console.log('Page title:', result);

// MV2 — tabs.executeScript (code string)
chrome.tabs.executeScript(tab.id, {
  code: 'document.body.style.border = "2px solid red"; document.title;',
}, ([result]) => {
  console.log(result);
});
```

---

### chrome.action / browserAction

`chrome.action` and `chrome.browserAction` are aliased to each other so MV2 extensions load in MV3 sessions and vice versa.

```js
// MV3
chrome.action.onClicked.addListener((tab) => {
  console.log('Clicked for tab:', tab.url);
});

// setBadgeText / setIcon are stubs (no visible change in UI)
chrome.action.setBadgeText({ text: '5' });
chrome.action.setIcon({ path: 'icons/active.png' });
```

When a toolbar button is clicked and the extension has no `default_popup`, DEFIS dispatches `chrome.action.onClicked` (MV3) or `chrome.browserAction.onClicked` (MV2) to the background SW.

---

### chrome.permissions

All `permissions.request()` calls are auto-granted (no UI prompt). `contains()` always returns `false` (conservative — extensions should not rely on pre-checking).

```js
chrome.permissions.request(
  { permissions: ['tabs'], origins: ['https://*/*'] },
  (granted) => {
    console.log('Granted:', granted); // always true
  }
);

chrome.permissions.getAll((perms) => {
  console.log(perms); // { permissions: [], origins: [] }
});
```

---

### chrome.tts

All TTS calls are silently no-op stubs. Extensions that call `tts.speak()` will not throw.

```js
chrome.tts.speak('Hello world', { rate: 1.2, pitch: 1.0 }, () => {});
chrome.tts.stop();
chrome.tts.isSpeaking((speaking) => console.log(speaking)); // false
chrome.tts.getVoices((voices) => console.log(voices));      // []
```

---

### chrome.webNavigation

All events are stubs with working `addListener` / `removeListener` — extensions can register handlers without throwing, but events are never fired.

```js
chrome.webNavigation.onCompleted.addListener((details) => {
  // Never called in DEFIS, but won't throw
  console.log('Navigated to:', details.url);
}, { url: [{ hostContains: 'example.com' }] });
```

---

### declarativeNetRequest (DNR)

Static rules are loaded from `manifest.json` → `declarative_net_request.rule_resources` on extension load. Dynamic rules are applied via the `defis-ipc://dnr-update` custom protocol from inside the Service Worker.

```js
// Dynamic rules — works from background SW
chrome.declarativeNetRequest.updateDynamicRules({
  addRules: [
    {
      id:        1,
      priority:  1,
      action:    { type: 'block' },
      condition: { urlFilter: '||ads.example.com^', resourceTypes: ['script'] },
    },
    {
      id:        2,
      priority:  1,
      action:    { type: 'redirect', redirect: { url: 'https://safe.example.com/' } },
      condition: { urlFilter: '||tracker.example.com^' },
    },
  ],
  removeRuleIds: [],
});
```

Supported rule actions: `block`, `redirect`, `modifyHeaders` (response headers: `set`, `append`, `remove`).

Static rules defined in the manifest are loaded automatically:

```json
{
  "declarative_net_request": {
    "rule_resources": [
      { "id": "ruleset_1", "enabled": true, "path": "rules/block_list.json" }
    ]
  }
}
```

---

## Architecture

### Message Flow: Content Script → Background SW

```
content-api-polyfill.js       ext-preload.js (BrowserView)
(isolated world)                    │
       │                            │
       │  CustomEvent               │
       │  __defis_ext_msg__   ◄─────┘  (window.addEventListener)
       │
       ▼
IPC: ext-tabs-send-message
       │
       ▼
lib/extensions.js (main process)
  webContents.executeJavaScript(CustomEvent dispatch)
       │
       ▼
content-api-polyfill.js (target tab, isolated world)
  → chrome.runtime.onMessage.dispatch(message, sender, sendResponse)
       │
       ▼ (sendResponse called)
CustomEvent __defis_ext_resp__
       │
       ▼
ext-preload.js → ipcRenderer.send('ext-msg-resp') → main → SW fetch response
```

### Message Flow: Background SW → Content Script (MV3)

Service Workers have no `ipcRenderer`. They use the `defis-ipc://` custom protocol (via `fetch`) to reach the main process directly:

```
Service Worker
  fetch('defis-ipc://tabs-send-msg', { body: JSON.stringify({tabId, message}) })
       │
       ▼
sess.protocol.handle('defis-ipc', ...)  [main process]
       │
       ▼
webContents.fromId(tabId).executeJavaScript(CustomEvent)
       │
       ▼
content-api-polyfill.js → chrome.runtime.onMessage
```

As a fallback (when no direct IPC is possible), SWs relay through BroadcastChannel:

```
SW: BroadcastChannel('defis-tabs-msg').postMessage(...)
       │
       ▼
ext-preload.js (popup / extension page — has ipcRenderer)
  → ipcRenderer.invoke('ext-tabs-send-message', ...)
```

### Service Worker Wrapper (MV3, non-module)

For non-module MV3 Service Workers, DEFIS automatically generates `defis-sw-init.js` and prepends it as the actual `background.service_worker`. This wrapper:

1. Stubs missing `chrome.*` APIs (`storage.sync`, `action`, `tabs`, `windows`, `notifications`, `contextMenus`, `alarms`, `webNavigation`, `identity`, `permissions`).
2. Sets up the `defis-ipc://` fetch relay for IPC-less SW → main communication.
3. Then calls `importScripts(originalSW)` to run the extension's original SW code.

The wrapper is regenerated automatically if it changes (e.g. after a DEFIS update).

### Popup Windows

When an extension calls `chrome.windows.create({ type: 'popup' })` or has a `default_popup`:

1. DEFIS intercepts the call in `ext-preload.js` or `defis-sw-init.js`.
2. Sends `defis-ipc://win-create` (SW) or `ipcRenderer.invoke('ext-open-popup-window')` (popup page).
3. Main process creates a real frameless `BrowserWindow` with the profile's session partition.
4. `ext-preload.js` is loaded as a preload, so all `chrome.*` shims are active inside the popup.
5. Auto-resize via `ResizeObserver` (max 900×700, min 200×100).
6. Closes on `Escape` or focus loss (unless a child window is focused).

### Side Panel

`chrome.sidePanel.open()` creates a `BrowserView` (380 px) docked to the right side of the profile window. It resizes automatically with the window and sits above the tab `BrowserView` but below the toolbar.

---

## Manifest Patching

`lib/extensions.js:patchExtensionManifest()` modifies `manifest.json` in-place before loading:

| Change | MV2 | MV3 | Reason |
|---|---|---|---|
| Remove unsupported permissions (`identity`, `gcm`, etc.) | ✅ | ✅ | Electron rejects them |
| Add `http://*/*`, `https://*/*` to `permissions[]` | ✅ | — | Enable content scripts |
| Remove URL patterns from `permissions[]` | — | ✅ | Only `host_permissions` allowed in MV3 |
| Add `<all_urls>` to `host_permissions[]` | — | ✅ | Grant full network access |
| Fix `content_scripts[].matches` | ✅ | ✅ | Replace `<all_urls>` with explicit patterns |
| Inject `defis-content-polyfill.js` as first content script | ✅ | ✅ | Installs isolated-world shims before the extension's own code |
| Generate `defis-sw-init.js` wrapper | — | ✅ | Stubs missing SW APIs |

---

## Known Limitations

- `chrome.action.setBadgeText` / `setIcon` are stubs — no visual badge is rendered in the toolbar.
- `chrome.tts.speak` is a no-op — no audio output.
- `chrome.webNavigation` events are never fired — only the listener registration is safe to call.
- `chrome.identity.getAuthToken` always returns `null` (no Google account integration).
- `chrome.webRequest` is partial and MV2-only.
- `declarativeNetRequest` `allow` and `allowAllRequests` actions are not implemented.
- Extensions requiring `chrome.enterprise`, `chrome.sync`, `chrome.vpnProvider`, native messaging, or Chrome's internal sync will not work.
- Extensions are loaded per-profile — enabling an extension in one profile does not affect others.
- MV3 Service Workers that use `importScripts()` with ES module syntax may fail; use non-module SW or set `"type": "module"` in `manifest.json`.
