# Anti-Detection

> How DEFIS spoofs browser fingerprints to prevent cross-profile tracking.

---

## Overview

Browser fingerprinting collects dozens of signals to create a unique identifier for your browser session. DEFIS randomises or overrides the most significant signals per-profile, making each profile appear as a distinct, consistent browser.

Fingerprint values are generated **once at profile creation** and remain stable for that profile's lifetime — so the profile always presents the same fingerprint, but it differs from every other profile.

---

## Spoofed Signals

### User Agent

The User-Agent string is overridden at three levels:

1. **HTTP request headers** — via `webRequest.onBeforeSendHeaders` (exact match to the spoofed UA)
2. **`navigator.userAgent`** — via `Object.defineProperty` in the injected script
3. **`navigator.platform`**, **`navigator.vendor`**, **`navigator.appVersion`** — all consistent with the chosen UA

### Canvas Fingerprint

Canvas fingerprinting extracts pixel data from a hidden `<canvas>` element. DEFIS adds imperceptible random noise to `getImageData()` output:

```js
// Real pixel data: [255, 127, 63, 255, ...]
// After spoof:     [254, 128, 63, 255, ...] (±1 per channel, seeded per profile)
```

The noise is deterministic (seeded from the profile ID) so the same canvas always returns the same result within a profile session, but differs from other profiles.

### WebGL Fingerprint

WebGL exposes the GPU vendor and renderer strings, plus subtle rendering differences. DEFIS:

- Overrides `UNMASKED_VENDOR_WEBGL` and `UNMASKED_RENDERER_WEBGL` with a chosen value
- Adds subtle noise to `readPixels()` output (same seeded approach as Canvas)

### AudioContext Fingerprint

The AudioContext API's `getChannelData()` and `getFloatFrequencyData()` produce subtly different values per CPU/OS. DEFIS adds seeded noise to the Float32Array output before it's returned to the page.

### Navigator Properties

| Property | Spoofed |
|----------|---------|
| `navigator.userAgent` | ✅ |
| `navigator.platform` | ✅ |
| `navigator.vendor` | ✅ |
| `navigator.language` | ✅ |
| `navigator.languages` | ✅ |
| `navigator.hardwareConcurrency` | ✅ |
| `navigator.deviceMemory` | ✅ |
| `navigator.cookieEnabled` | Preserved |
| `navigator.doNotTrack` | Configurable |

### Timezone & Locale

- `Intl.DateTimeFormat().resolvedOptions().timeZone` → overridden to the profile's configured timezone
- `Date` object behaviour is consistent with the spoofed timezone
- `navigator.language` and `navigator.languages` → overridden to the profile's configured locale

### Screen Resolution

`screen.width`, `screen.height`, `screen.availWidth`, `screen.availHeight` are overridden to a value from a realistic set of common resolutions.

---

## Injection Mechanism

`antidetect.js` is registered as a **preload script** on the BrowserView session:

```js
session.setPreloads(['/path/to/antidetect.js'])
```

This runs the script **before any page JavaScript**, in the same renderer process as the page but in an isolated world — so page scripts cannot detect or remove the overrides.

---

## Per-Profile Fingerprint Storage

Each profile stores its fingerprint configuration in the backend:

```json
{
  "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)...",
  "platform": "Win32",
  "language": "en-US",
  "timezone": "America/New_York",
  "screen": { "width": 1920, "height": 1080 },
  "hardwareConcurrency": 8,
  "deviceMemory": 8,
  "canvasSeed": 847291,
  "webglVendor": "Google Inc. (NVIDIA)",
  "webglRenderer": "ANGLE (NVIDIA, GeForce RTX 3070...)"
}
```

The `canvasSeed` is used to generate consistent but unique noise for Canvas, WebGL, and Audio APIs.

---

## What's Not Spoofed

| Signal | Status | Reason |
|--------|--------|--------|
| IP address | ❌ | Use per-profile proxy (see proxy configuration) |
| TLS fingerprint (JA3) | ❌ | Chromium-level, not patchable from preload |
| TCP/IP stack | ❌ | OS-level |
| Font enumeration | ⚠️ | Partial — system fonts still visible |
| Battery API | ✅ | Disabled / returns `null` |
| Bluetooth / USB | ✅ | Disabled |
| WebRTC local IP | ✅ | Disabled via `ses.setProxy` leak prevention |

---

## Best Practices

1. **Always pair a profile with a proxy** matching the target region — IP is the strongest fingerprint signal
2. **Use realistic User Agents** — UA strings for obsolete browser versions are an instant tell
3. **Keep screen resolution consistent** with the proxy country's common resolutions
4. **Don't share profiles** between team members — the fingerprint should be stable and associated with one "identity"
