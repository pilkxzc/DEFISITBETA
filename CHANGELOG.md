# Changelog

All notable changes to DEFIS Browser are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
Versioning: [Semantic Versioning](https://semver.org/)

---

## [1.0.4] — 2026-02-22

### Added
- Full `chrome.tabs.sendMessage` implementation (MV3 service workers → content scripts via BroadcastChannel bridge)
- `chrome.windows.create({ type: 'popup' })` now opens a real `BrowserWindow` popup instead of a new tab
- `chrome.notifications.create` maps to native OS notifications via Electron Notification API
- Profile quick-switch arrow buttons `‹ ›` in the title bar
- `Ctrl+Shift+A` — open profile/accounts modal
- `Ctrl+Shift+←/→` — switch to previous/next profile
- `Ctrl+Shift+C` — navigate to claude.ai
- Claude.ai shortcut button in the toolbar
- Profile modal: auto-focus search, arrow-key navigation, Enter to open

### Changed
- Screenshots: PNG → JPEG (55% quality, max 1280 px wide) — ~70% smaller
- DOM snapshot limit: 25 000 → 10 000 chars
- DOM depth: 7 → 6; attribute value truncation: 120 → 80 chars
- Clock update interval: 15 s → 60 s
- Popup window max size: 800×600 → 900×700
- Profile label and cycle button colours adjusted for better visibility
- Settings nav labels localised to Ukrainian

### Fixed
- Popup windows no longer close when a child DevTools or auth window is focused
- Extension popup windows resize immediately via `ResizeObserver` (previously 200 ms timeout)
- `Escape` correctly closes extension popup windows

---

## [1.0.3] — 2026-02-10

### Added
- SOCKS5 proxy support with per-profile authentication
- Tab drag-and-drop reordering with visual insertion indicator
- Tab detach to new window (drag tab out of tab bar)
- Download manager with progress display
- Rich notepad with inline image support and one-click public sharing
- Find-in-page (`Ctrl+F`)

### Changed
- Profile picker now shows profile colour indicator
- Improved offline fallback — single default profile with full functionality

### Fixed
- Fixed cookie persistence across app restarts
- Fixed extension i18n `_locales` resolution on Windows

---

## [1.0.2] — 2026-01-20

### Added
- Chrome Extension support (CRX3, Manifest V2/V3)
- Extension popup windows
- `chrome.storage.local` and `chrome.storage.sync` APIs
- Content script message passing

### Fixed
- Fixed session partition isolation (profiles no longer share cookies)

---

## [1.0.1] — 2026-01-05

### Added
- AI Agent (Claude) with screenshot, click, type, navigate, getDOM, scroll, wait, evaluate tools
- Gemini provider support
- Agent streaming output to UI

### Changed
- Moved profile data to backend sync (was local-only in 1.0.0)

---

## [1.0.0] — 2025-12-01

### Added
- Initial release
- Multi-profile browser with Chromium partition isolation
- Anti-detection (UA, Canvas, WebGL, Audio, timezone spoofing)
- HTTP proxy support
- JWT authentication with Express + SQLite backend
- Bookmark and history sync
- Three.js animated new-tab background
