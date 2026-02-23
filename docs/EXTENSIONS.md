# Chrome Extension Support

> DEFIS supports loading unpacked Chrome extensions (CRX3) with Manifest V2 and V3 compatibility.

---

## Loading an Extension

1. Unzip / extract your CRX3 file into a directory
2. Open the **Extensions** menu in the browser toolbar
3. Click **Load Extension** and select the extracted directory
4. The extension appears in the list immediately

Extension directories are stored at:

```
<Electron userData>/defis-extensions/<extension-id>/
```

---

## API Support Matrix

| Chrome API | MV2 | MV3 | Notes |
|-----------|-----|-----|-------|
| `chrome.tabs.sendMessage` | ✅ | ✅ | Full relay via BroadcastChannel + IPC |
| `chrome.tabs.query` | ✅ | ✅ | |
| `chrome.tabs.create` | ✅ | ✅ | |
| `chrome.windows.create` | ✅ | ✅ | Real BrowserWindow popup |
| `chrome.windows.getCurrent` | ✅ | ✅ | |
| `chrome.runtime.sendMessage` | ✅ | ✅ | |
| `chrome.runtime.onMessage` | ✅ | ✅ | |
| `chrome.runtime.getURL` | ✅ | ✅ | |
| `chrome.storage.local` | ✅ | ✅ | |
| `chrome.storage.sync` | ✅ | ✅ | Backed by local storage |
| `chrome.notifications.create` | ✅ | ✅ | → Native OS notification |
| `chrome.notifications.clear` | ✅ | ✅ | |
| `chrome.action.setBadgeText` | — | ✅ | |
| `chrome.action.setIcon` | — | ✅ | |
| `chrome.cookies.get/set` | ✅ | ✅ | |
| `chrome.history` | ⚠️ | ⚠️ | Partial |
| `chrome.identity` | ⚠️ | ⚠️ | Partial (no OAuth flow) |
| `chrome.webRequest` | ⚠️ | — | Partial (MV2 only) |
| Native messaging | ❌ | ❌ | Not supported |

---

## Architecture

### Message Flow: Content Script → Background SW

```
content-api-polyfill.js       ext-preload.js (BrowserView)
(in page context)                  │
       │                           │
       │  CustomEvent              │
       │  __defis_ext_msg__   ◄────┘  (event listener)
       │
       ▼
IPC: ext-tabs-send-message
       │
       ▼
lib/extensions.js (main process)
       │
       ▼
target tab webContents.executeJavaScript(CustomEvent dispatch)
       │
       ▼
content-api-polyfill.js (target tab)
  → chrome.runtime.onMessage.dispatch()
```

### Message Flow: Background SW → Content Script (MV3)

```
Service Worker (SW context)
       │
       │  BroadcastChannel('defis-tabs-msg')
       ▼
ext-preload.js
       │
       │  IPC: ext-tabs-send-message
       ▼
Main process → executeJavaScript → content script
```

### Popup Windows

When an extension calls `chrome.windows.create({ type: 'popup' })`:

1. The call is intercepted in `ext-preload.js`
2. Sent via IPC `ext-open-popup-window` to the main process
3. Main process creates a real `BrowserWindow` with the extension's popup URL
4. Popup inherits the profile's session partition
5. `Escape` key closes the popup
6. Window resizes automatically via `ResizeObserver` (no fixed size hack)
7. Losing focus only closes the popup if no child window (DevTools, auth dialog) is in focus

### Notifications

`chrome.notifications.create(id, options, callback)` maps directly to Electron's `Notification` API:

```js
// Extension calls:
chrome.notifications.create('n1', {
  type: 'basic',
  title: 'Done',
  message: 'Task completed',
  iconUrl: 'icon.png'
})

// DEFIS translates to:
new Notification({ title: 'Done', body: 'Task completed' }).show()
```

---

## CRX3 Extraction

When `lib/extensions.js` loads an extension directory:

1. Detects manifest version (2 or 3)
2. Patches `manifest.json` if needed (removes unsupported keys)
3. Calls `session.loadExtension(path, { allowFileAccess: true })`
4. Stores extension metadata in memory (id, name, version, icons)
5. Notifies the renderer to refresh the Extensions menu

---

## i18n Support

Extensions with `_locales/` directories work normally. DEFIS passes the system locale to the extension runtime, falling back to `en` if the locale is unavailable.

---

## Known Limitations

- Extensions that require Chrome's internal APIs (`chrome.sync`, `chrome.enterprise`) will not work
- Extensions relying on native messaging cannot communicate with local binaries
- MV3 `declarativeNetRequest` rules are not applied (no network interception at that level)
- Extensions are loaded globally and are visible in all profiles — per-profile extension lists are not yet implemented
