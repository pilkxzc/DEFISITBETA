# Build & Release

> How to build DEFIS installers and publish releases to the update server.

---

## Prerequisites

| Tool | Required for | Install |
|------|-------------|---------|
| Node.js 18+ | All builds | [nodejs.org](https://nodejs.org) |
| npm 8+ | All builds | Bundled with Node.js |
| Wine | Windows builds on Linux | `sudo pacman -S wine` / `sudo apt install wine` |
| `curl` | Uploading releases | Usually pre-installed |

Check everything is in order:

```bash
node --version   # v18+
npm --version    # 8+
wine --version   # only needed for Windows builds
curl --version
```

---

## One-Time Setup

### 1. Install dependencies

```bash
cd page
npm install

cd defis-server
npm install
```

### 2. Configure release credentials

```bash
cp page/.release-env.example page/.release-env
```

Edit `page/.release-env`:

```bash
DEFIS_SERVER_URL="http://your-server:3717"
DEFIS_ADMIN_EMAIL="admin@example.com"
DEFIS_ADMIN_PASS="your-admin-password"
```

This file is gitignored and never committed.

---

## Building Manually

```bash
cd page

# Linux AppImage
npm run build:linux

# Arch Linux package (.pkg.tar.zst)
npm run build:arch

# Windows installer (.exe)
npm run build:win

# All targets
npm run build:all
```

Build output goes to `page/dist/`.

---

## The Release Script

`release.sh` automates everything: version bump → build → upload → publish.

```
release.sh
    │
    ├─ 1. Parse args (version, flags)
    ├─ 2. Check dependencies
    ├─ 3. Validate server connectivity
    ├─ 4. Authenticate with admin credentials (get JWT)
    ├─ 5. Bump version in package.json
    ├─ 6. Build all targets (npm run build:all)
    ├─ 7. Upload binaries to /api/version/upload
    └─ 8. Publish version metadata to /api/version
```

### Usage

```bash
cd page

# Bump patch automatically (1.0.3 → 1.0.4) and deploy
./release.sh

# Deploy a specific version
./release.sh 1.2.0

# Build only — skip server upload
./release.sh 1.2.0 --no-upload

# Include release notes
./release.sh 1.2.0 --notes "Fix proxy auth on Windows"

# Force update — clients on older versions are blocked
./release.sh 1.2.0 --force

# Override server URL for this run
./release.sh 1.2.0 --server http://staging-server:3717
```

### What Gets Uploaded

| File | Platform | API key |
|------|----------|---------|
| `DEFIS-Browser-*.exe` | Windows | `win32` |
| `DEFIS-Browser-*.AppImage` | Linux | `linux` |
| `DEFIS-Browser-*.pkg.tar.zst` | Arch | `arch` |

---

## Auto-Update Flow

When the Electron app starts, it calls `GET /api/version/latest`. If the returned version is newer than the running version:

1. A toast notification appears: *"Update available: v1.0.4"*
2. User clicks the notification → download starts in the background
3. After download, the user is prompted to restart and install

If `forceUpdate: true`, the app shows a blocking modal and refuses to continue until updated.

---

## Build Configuration

`page/package.json` (electron-builder section):

```json
{
  "build": {
    "appId": "app.defis.browser",
    "productName": "DEFIS Browser",
    "directories": { "output": "dist" },
    "linux": {
      "target": ["AppImage"],
      "icon": "build/icon.png",
      "category": "Network"
    },
    "pacman": {
      "target": ["pacman"]
    },
    "win": {
      "target": ["nsis"],
      "icon": "build/icon.png"
    },
    "nsis": {
      "oneClick": false,
      "allowToChangeInstallationDirectory": true
    }
  }
}
```

---

## Versioning

DEFIS follows [Semantic Versioning](https://semver.org/):

- **Patch** (`1.0.x`) — bug fixes, no breaking changes → `./release.sh`
- **Minor** (`1.x.0`) — new features, backwards compatible → `./release.sh 1.1.0`
- **Major** (`x.0.0`) — breaking changes → `./release.sh 2.0.0 --force`

The version is stored in `page/package.json` and `page/defis-server/package.json`. The release script bumps both.

---

## Troubleshooting

**Wine not found (Windows build on Linux)**
```bash
sudo pacman -S wine         # Arch
sudo apt install wine64     # Ubuntu/Debian
```

**Server not reachable during upload**
```bash
curl http://your-server:3717/api/version/latest
# Should return JSON. If it times out, check firewall rules.
```

**Build fails with electron-builder error**
```bash
# Clear the dist cache
rm -rf page/dist page/node_modules/.cache
cd page && npm install
```

**Permission denied on release.sh**
```bash
chmod +x page/release.sh
```
