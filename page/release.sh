#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════
#  DEFIS Browser — release build + deploy script
#  Usage:
#    ./release.sh                        # bump patch (1.0.0 → 1.0.1)
#    ./release.sh 1.2.0                  # explicit version
#    ./release.sh 1.2.0 --no-upload      # build only, skip server upload
#    ./release.sh 1.2.0 --notes "Fix X"  # custom release notes
#    ./release.sh 1.2.0 --force          # force update (block old versions)
#
#  Credentials are loaded automatically from .release-env (gitignored).
#  Create it once:
#    cp .release-env.example .release-env
#    # then fill in your credentials
#
#  Builds: Windows (.exe NSIS) + Linux AppImage + Arch pacman
#  Uploads to DEFIS server via /api/version/upload
#  Publishes version via /api/version
# ══════════════════════════════════════════════════════════════════
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Load credentials file (.release-env) ──────────────────────────
# Create .release-env once (see .release-env.example) — never committed to git
if [[ -f "$SCRIPT_DIR/.release-env" ]]; then
    # shellcheck disable=SC1091
    source "$SCRIPT_DIR/.release-env"
fi

# ── Colors ────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${CYAN}[INFO]${RESET}  $*"; }
ok()      { echo -e "${GREEN}[OK]${RESET}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
error()   { echo -e "${RED}[ERR]${RESET}   $*" >&2; exit 1; }
header()  { echo -e "\n${BOLD}━━━  $*  ━━━${RESET}"; }

# ── Config ────────────────────────────────────────────────────────
SERVER_URL="${DEFIS_SERVER_URL:-http://188.137.178.124:3717}"
ADMIN_EMAIL="${DEFIS_ADMIN_EMAIL:-}"
ADMIN_PASS="${DEFIS_ADMIN_PASS:-}"
RELEASES_DIR="$SCRIPT_DIR/defis-server/releases"
DIST_DIR="$SCRIPT_DIR/dist"

# ── Parse args ────────────────────────────────────────────────────
# Collect all positional args first, then flags — order doesn't matter
NEW_VERSION=""
DO_UPLOAD=true
RELEASE_NOTES=""
FORCE_UPDATE=false

POSITIONAL_ARGS=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --no-upload)
            DO_UPLOAD=false
            shift
            ;;
        --force)
            FORCE_UPDATE=true
            shift
            ;;
        --notes)
            # Guard: next arg must exist and not start with --
            if [[ $# -lt 2 ]]; then
                error "--notes requires a value"
            fi
            RELEASE_NOTES="$2"
            shift 2
            ;;
        --notes=*)
            RELEASE_NOTES="${1#*=}"
            shift
            ;;
        --server)
            if [[ $# -lt 2 ]]; then error "--server requires a value"; fi
            SERVER_URL="$2"
            shift 2
            ;;
        --server=*)
            SERVER_URL="${1#*=}"
            shift
            ;;
        --email)
            if [[ $# -lt 2 ]]; then error "--email requires a value"; fi
            ADMIN_EMAIL="$2"
            shift 2
            ;;
        --pass)
            if [[ $# -lt 2 ]]; then error "--pass requires a value"; fi
            ADMIN_PASS="$2"
            shift 2
            ;;
        -*)
            warn "Unknown flag: $1 (ignored)"
            shift
            ;;
        *)
            POSITIONAL_ARGS+=("$1")
            shift
            ;;
    esac
done

# First positional arg = version
if [[ ${#POSITIONAL_ARGS[@]} -gt 0 ]]; then
    NEW_VERSION="${POSITIONAL_ARGS[0]}"
fi

# ── Determine version ─────────────────────────────────────────────
CURRENT_VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "1.0.0")

if [[ -z "$NEW_VERSION" ]]; then
    IFS='.' read -r major minor patch <<< "$CURRENT_VERSION"
    NEW_VERSION="${major}.${minor}.$((patch + 1))"
    info "Auto-bumped: ${CURRENT_VERSION} → ${NEW_VERSION}"
else
    info "Target version: ${NEW_VERSION}"
fi

if ! [[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    error "Version must be x.y.z format, got: '${NEW_VERSION}'"
fi

# ── Check deps ────────────────────────────────────────────────────
header "Checking dependencies"

command -v wine >/dev/null 2>&1    || error "wine not installed (required for Windows build)"
command -v curl >/dev/null 2>&1    || error "curl not installed"
command -v node >/dev/null 2>&1    || error "node not installed"
[[ -f "./node_modules/.bin/electron-builder" ]] \
    || error "electron-builder not found — run: npm install"

ok "All dependencies present"

# ── Bump version in package.json ──────────────────────────────────
header "Setting version ${NEW_VERSION}"

node -e "
const fs  = require('fs');
const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf8'));
pkg.version = process.argv[1];
fs.writeFileSync('./package.json', JSON.stringify(pkg, null, 2) + '\n');
" -- "$NEW_VERSION"

ok "package.json → v${NEW_VERSION}"

# ── Clean previous dist artifacts ─────────────────────────────────
header "Cleaning dist/"
rm -f  "${DIST_DIR}/"*.exe "${DIST_DIR}/"*.pacman "${DIST_DIR}/"*.blockmap "${DIST_DIR}/"*.AppImage
rm -rf "${DIST_DIR}/win-unpacked" "${DIST_DIR}/linux-unpacked"
ok "dist/ cleaned"

# ── Build Windows ─────────────────────────────────────────────────
header "Building Windows installer"
LANG=en_US.UTF-8 ./node_modules/.bin/electron-builder --win nsis --x64 2>&1 \
    | grep -E '(•|error|Error|warn|building|target|✓|✗)' || true

WIN_FILE=$(find "${DIST_DIR}" -maxdepth 1 -name "*.exe" -not -name "*.blockmap" 2>/dev/null | head -1)
[[ -n "$WIN_FILE" ]] || error "Windows .exe not found in dist/ — build failed"
ok "Windows: $(basename "$WIN_FILE") ($(du -sh "$WIN_FILE" | cut -f1))"

# ── Build Linux (AppImage + pacman) ───────────────────────────────
header "Building Linux packages (AppImage + pacman)"
./node_modules/.bin/electron-builder --linux appimage pacman --x64 2>&1 \
    | grep -E '(•|error|Error|warn|building|target|✓|✗)' || true

APPIMAGE_FILE=$(find "${DIST_DIR}" -maxdepth 1 -name "*.AppImage" 2>/dev/null -printf '%T@ %p\n' | sort -rn | head -1 | cut -d' ' -f2-)
[[ -n "$APPIMAGE_FILE" ]] || error "AppImage not found in dist/ — build failed"
ok "AppImage: $(basename "$APPIMAGE_FILE") ($(du -sh "$APPIMAGE_FILE" | cut -f1))"

ARCH_FILE=$(find "${DIST_DIR}" -maxdepth 1 -name "*.pacman" 2>/dev/null -printf '%T@ %p\n' | sort -rn | head -1 | cut -d' ' -f2-)
if [[ -n "$ARCH_FILE" ]]; then
    ok "pacman:   $(basename "$ARCH_FILE") ($(du -sh "$ARCH_FILE" | cut -f1))"
else
    warn "Arch .pacman not found (skipped)"
fi

# ── Copy to local releases dir ────────────────────────────────────
header "Copying to releases/"
mkdir -p "${RELEASES_DIR}"

WIN_DEST="${RELEASES_DIR}/DEFIS-Browser-${NEW_VERSION}-win.exe"
LINUX_DEST="${RELEASES_DIR}/DEFIS-Browser-${NEW_VERSION}-x86_64.AppImage"
ARCH_DEST="${RELEASES_DIR}/DEFIS-Browser-${NEW_VERSION}-arch.pacman"

cp "$WIN_FILE"      "$WIN_DEST"
cp "$APPIMAGE_FILE" "$LINUX_DEST"
[[ -n "$ARCH_FILE" ]] && cp "$ARCH_FILE" "$ARCH_DEST" || true
ok "Copied to releases/"
info "  Win:     $(basename "$WIN_DEST")"
info "  Linux:   $(basename "$LINUX_DEST")"
[[ -n "$ARCH_FILE" ]] && info "  pacman:  $(basename "$ARCH_DEST")"

# ── Skip upload? ──────────────────────────────────────────────────
if [[ "$DO_UPLOAD" != true ]]; then
    warn "Skipping server upload (--no-upload)"
    echo -e "\n${GREEN}${BOLD}Build complete!${RESET} v${NEW_VERSION}"
    echo "  Win:   $WIN_DEST"
    echo "  Linux: $LINUX_DEST"
    exit 0
fi

# ── Server upload ─────────────────────────────────────────────────
header "Uploading to ${SERVER_URL}"

# Check server reachability first
if ! curl -sf --max-time 5 "${SERVER_URL}/health" >/dev/null 2>&1; then
    echo -e "${RED}[ERR]${RESET}   Cannot reach server at ${SERVER_URL}"
    echo -e "       Check that the server is running and the URL is correct."
    echo -e "       Set DEFIS_SERVER_URL env var or use --server <url> to override."
    exit 1
fi

# Credentials
if [[ -z "$ADMIN_EMAIL" ]]; then
    read -rp "  Admin email:    " ADMIN_EMAIL
fi
if [[ -z "$ADMIN_PASS" ]]; then
    read -rsp "  Admin password: " ADMIN_PASS
    echo
fi

# Login — use -s (no -f so HTTP 4xx doesn't abort curl)
info "Authenticating…"
LOGIN_RESP=$(curl -s --max-time 10 -X POST "${SERVER_URL}/api/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"${ADMIN_EMAIL}\",\"password\":\"${ADMIN_PASS}\"}" 2>&1) \
    || error "Network error during login"

TOKEN=$(node -e "
try {
    const j = JSON.parse(process.argv[1]);
    process.stdout.write(j.token || '');
} catch { process.stdout.write(''); }
" -- "$LOGIN_RESP" 2>/dev/null)

if [[ -z "$TOKEN" ]]; then
    # Show why it failed
    ERR_MSG=$(node -e "
try { const j=JSON.parse(process.argv[1]); process.stdout.write(j.error||'unknown'); }
catch { process.stdout.write('invalid response'); }
" -- "$LOGIN_RESP" 2>/dev/null)
    error "Login failed: ${ERR_MSG}  (server said: ${LOGIN_RESP})"
fi
ok "Authenticated as ${ADMIN_EMAIL}"

# Upload a file and return the URL
upload_file() {
    local file="$1"
    local platform="$2"
    local label="$3"
    local size
    size=$(du -sh "$file" | cut -f1)
    info "Uploading ${label} (${size})…"

    local RESP
    RESP=$(curl -s --max-time 600 \
        -H "Authorization: Bearer ${TOKEN}" \
        -F "platform=${platform}" \
        -F "file=@${file}" \
        --progress-bar \
        "${SERVER_URL}/api/version/upload" 2>/dev/null) \
        || error "Network error while uploading ${label}"

    local URL
    URL=$(node -e "
try { const j=JSON.parse(process.argv[1]); process.stdout.write(j.url||j.data?.url||''); }
catch { process.stdout.write(''); }
" -- "$RESP" 2>/dev/null)

    if [[ -z "$URL" ]]; then
        local ERR
        ERR=$(node -e "
try { const j=JSON.parse(process.argv[1]); process.stdout.write(j.error||j.data?.error||'unknown'); }
catch { process.stdout.write(process.argv[1].slice(0,120)); }
" -- "$RESP" 2>/dev/null)
        error "Upload failed for ${label}: ${ERR}"
    fi

    ok "${label} → ${URL}"
}

upload_file "$WIN_DEST"    "win"   "Windows .exe"
upload_file "$LINUX_DEST"  "linux" "Linux AppImage"

# ── Publish version metadata ──────────────────────────────────────
header "Publishing version ${NEW_VERSION}"

[[ -z "$RELEASE_NOTES" ]] && RELEASE_NOTES="DEFIS Browser v${NEW_VERSION}"

FORCE_JSON="false"
[[ "$FORCE_UPDATE" == true ]] && FORCE_JSON="true"

# Build JSON payload safely via node (handles Unicode, special chars, newlines)
JSON_PAYLOAD=$(node -e "
const obj = {
    latestVersion: process.argv[1],
    releaseNotes:  process.argv[2],
    forceUpdate:   process.argv[3] === 'true',
};
process.stdout.write(JSON.stringify(obj));
" -- "$NEW_VERSION" "$RELEASE_NOTES" "$FORCE_JSON")

PUB_RESP=$(curl -s --max-time 10 -X PUT "${SERVER_URL}/api/version" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d "$JSON_PAYLOAD") \
    || error "Network error while publishing version"

PUB_OK=$(node -e "
try { const j=JSON.parse(process.argv[1]); process.stdout.write(String(j.ok||'')); }
catch { process.stdout.write(''); }
" -- "$PUB_RESP" 2>/dev/null)

if [[ "$PUB_OK" != "true" ]]; then
    ERR=$(node -e "
try { const j=JSON.parse(process.argv[1]); process.stdout.write(j.error||'unknown'); }
catch { process.stdout.write(process.argv[1].slice(0,120)); }
" -- "$PUB_RESP" 2>/dev/null)
    error "Publish failed: ${ERR}"
fi

ok "Version ${NEW_VERSION} published on server"

# ── Done ──────────────────────────────────────────────────────────
echo -e "\n${GREEN}${BOLD}✓ Release ${NEW_VERSION} complete!${RESET}"
echo -e "  ${CYAN}Win:${RESET}   $(basename "$WIN_DEST")"
echo -e "  ${CYAN}Linux:${RESET} $(basename "$LINUX_DEST")"
echo -e "  ${CYAN}Notes:${RESET} ${RELEASE_NOTES}"
echo -e "  ${CYAN}Server:${RESET} ${SERVER_URL}/api/version"
echo -e "\nВсі клієнти побачать оновлення при наступній перевірці."
