# Architecture

> Deep dive into DEFIS Browser's process model, IPC design, and data flow.

---

## Process Model

DEFIS uses the standard Electron multi-process architecture with three distinct process types:

```
┌─────────────────────────────────────────────────────────────────────┐
│  MAIN PROCESS  (Node.js)                                            │
│                                                                     │
│  main.js → lib/windows.js                                          │
│           → lib/tabs.js                                             │
│           → lib/profiles.js                                         │
│           → lib/extensions.js                                       │
│           → lib/config.js                                           │
└──────────────┬───────────────────────┬──────────────────────────────┘
               │ IPC (contextBridge)   │ IPC (contextBridge)
               ▼                       ▼
┌──────────────────────┐   ┌──────────────────────────────────────────┐
│  RENDERER PROCESS    │   │  BROWSERVIEW PROCESSES  (one per tab)    │
│  (Chromium)          │   │  (Chromium, isolated partition)          │
│                      │   │                                          │
│  index.html          │   │  Tab web content                         │
│  renderer.js         │   │  + ext-preload.js  (injected)           │
│  preload.js          │   │  + antidetect.js   (injected)           │
└──────────────────────┘   │  + content-api-polyfill.js (injected)   │
                           └──────────────────────────────────────────┘
```

### Why BrowserView per tab?

Each tab is a `BrowserView` attached to the main `BrowserWindow`. This provides:

- **True process isolation** — a crashed tab doesn't kill the browser chrome
- **Partition isolation** — each profile uses its own `persist:profileId` session partition, giving completely separate cookie stores, storage, and network state
- **Scriptable** — the main process can call `webContents.executeJavaScript()` on any tab for agent automation and extension message passing

---

## Startup Sequence

```
app.ready
    │
    ▼
main.js
    │  1. Set GPU flags (disable vsync, ignore GPU blocklist)
    │  2. Register all IPC handlers
    │  3. Load saved JWT token from disk
    │
    ▼
lib/config.js → GET /api/auth/validate
    │
    ├─ 401 / 403 ──────────────► login.html (full re-auth)
    │
    ├─ Network error ──────────► Offline mode
    │                             └─ Single "Default" profile (local only)
    │
    └─ 200 OK ─────────────────► GET /api/profiles
                                   │
                                   ▼
                                profile-picker.html
                                   │
                                   ▼
                                index.html (browser window)
                                   │
                                   ▼
                                Server health check every 30 s
```

---

## IPC Architecture

All communication between renderer and main process goes through `preload.js`, which exposes a typed `window.api` object via Electron's `contextBridge`. Direct Node.js access from the renderer is disabled (`nodeIntegration: false`, `contextIsolation: true`).

### Channel Map

| Direction | Channel | Handler | Description |
|-----------|---------|---------|-------------|
| R → M | `tab:create` | `lib/tabs.js` | Open new tab |
| R → M | `tab:close` | `lib/tabs.js` | Close tab by id |
| R → M | `tab:navigate` | `lib/tabs.js` | Navigate tab to URL |
| R → M | `tab:getState` | `lib/tabs.js` | Get all tabs state |
| R → M | `profile:list` | `lib/profiles.js` | List all profiles |
| R → M | `profile:create` | `lib/profiles.js` | Create new profile |
| R → M | `profile:update` | `lib/profiles.js` | Update profile |
| R → M | `profile:delete` | `lib/profiles.js` | Delete profile |
| R → M | `config:get` | `lib/config.js` | Read global config |
| R → M | `config:set` | `lib/config.js` | Write global config |
| R → M | `ext:list` | `lib/extensions.js` | List loaded extensions |
| R → M | `ext:load` | `lib/extensions.js` | Load extension from path |
| R → M | `agent:run` | `lib/tabs.js` | Start AI agent task |
| R → M | `agent:stop` | `lib/tabs.js` | Stop running agent |
| M → R | `tabs:updated` | renderer.js | Tab state changed |
| M → R | `nav:updated` | renderer.js | Navigation state changed |
| M → R | `agent:delta` | renderer.js | Agent streaming chunk |
| M → R | `profiles:changed` | renderer.js | Profile list updated |

---

## Tab Lifecycle

```
tab:create (profileId, url?)
    │
    ▼
lib/tabs.js
    │  1. Create BrowserView
    │  2. Set session partition = "persist:<profileId>"
    │  3. Set user agent from profile fingerprint
    │  4. Inject antidetect.js via preload
    │  5. Inject ext-preload.js if extensions loaded
    │  6. Attach BrowserView to BrowserWindow
    │  7. Load URL (or about:blank)
    │
    ▼
webContents events
    │  did-start-loading   → update tab spinner
    │  did-stop-loading    → update tab title/favicon
    │  did-navigate        → update address bar
    │  page-title-updated  → update tab label
    │  crashed             → show crash page
    │
    ▼
tab:close
    │  1. Detach BrowserView
    │  2. Destroy webContents
    │  3. Notify renderer
```

---

## Profile & Partition Isolation

Each profile maps to a named Electron session partition:

```js
session.fromPartition(`persist:${profile.id}`)
```

This gives each profile:

| Resource | Isolated? |
|----------|-----------|
| Cookies | ✅ Completely separate |
| localStorage / IndexedDB | ✅ Completely separate |
| Cache | ✅ Completely separate |
| Network stack / DNS cache | ✅ Completely separate |
| Service workers | ✅ Completely separate |
| Proxy settings | ✅ Per-profile (`ses.setProxy()`) |
| User Agent | ✅ Per-profile (overridden in `will-send-request`) |
| Fingerprint | ✅ Per-profile (injected via `antidetect.js`) |

---

## Extension Architecture

See [EXTENSIONS.md](EXTENSIONS.md) for the full breakdown. In brief:

1. `lib/extensions.js` extracts a CRX3 archive, patches the manifest, and registers the extension with `ses.loadExtension()`
2. `ext-preload.js` is injected into every `BrowserView` and provides the full `chrome.*` API surface
3. MV3 service workers communicate via `BroadcastChannel` rather than direct IPC (since SWs run in a separate renderer context)
4. Extension popup windows are real `BrowserWindow` instances, not new tabs

---

## Server Sync

The backend is an Express + SQLite server running at `http://127.0.0.1:3717` by default.

```
Electron app ──HTTP + JWT──► defis-server
                              │
                              ├─ /api/auth        (login, validate)
                              ├─ /api/profiles    (CRUD)
                              ├─ /api/bookmarks   (per-profile)
                              ├─ /api/notes       (per-profile)
                              ├─ /api/history     (per-profile)
                              ├─ /api/config      (global app config)
                              └─ /api/version     (update check & download)
```

The main process checks server health every 30 seconds via `lib/config.js`. If the server becomes unreachable, the app continues in offline mode using the last known local state.

---

## Security Considerations

| Concern | Mitigation |
|---------|-----------|
| Renderer → Node.js access | `nodeIntegration: false` + `contextIsolation: true` |
| IPC surface | All channels explicitly registered; no wildcard handlers |
| Extension sandboxing | Extensions run in their own BrowserView partition |
| JWT storage | Saved to `userData/server-config.json`, not the system keychain |
| Credentials in git | `.release-env`, `.admin-credentials` are gitignored |
| CORS | Server allows only `localhost`, `null` (file://), and configured origins |
