'use strict';

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const multer  = require('multer');
const db      = require('../db');
const { requireAuth, requireAdmin } = require('../auth');

const router = express.Router();

// ── Releases storage dir ──────────────────────────────────────────
const RELEASES_DIR = path.join(__dirname, '..', 'releases');
if (!fs.existsSync(RELEASES_DIR)) fs.mkdirSync(RELEASES_DIR, { recursive: true });

// Keep only allowed extensions
const ALLOWED_EXTS = new Set(['.appimage', '.exe', '.dmg', '.zip', '.deb', '.rpm', '.pkg', '.pacman']);

const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, RELEASES_DIR),
    filename:    (_req, file, cb) => {
        // Sanitise: strip path traversal chars
        const safe = file.originalname.replace(/[/\\?%*:|"<>]/g, '_');
        cb(null, safe);
    },
});

const upload = multer({
    storage,
    limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB max
    fileFilter: (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (ALLOWED_EXTS.has(ext)) return cb(null, true);
        cb(new Error(`File type not allowed: ${ext}`));
    },
});

// ── Helpers ───────────────────────────────────────────────────────
function getBaseUrl(req) {
    return process.env.DEFIS_PUBLIC_URL
        || `${req.protocol}://${req.get('host')}`;
}

// ── GET /api/version — public, no auth ───────────────────────────
router.get('/', (req, res) => {
    const cfg = db.getConfig();
    res.json({
        latestVersion:    cfg.latestVersion    || '1.0.0',
        releaseNotes:     cfg.releaseNotes     || null,
        forceUpdate:      cfg.forceUpdate      || false,
        // per-platform URLs
        downloadUrlLinux: cfg.downloadUrlLinux || null,
        downloadUrlWin:   cfg.downloadUrlWin   || null,
        downloadUrlMac:   cfg.downloadUrlMac   || null,
        // legacy single url (backwards compat)
        downloadUrl:      cfg.downloadUrlLinux || cfg.downloadUrlWin || cfg.downloadUrlMac || null,
        // uploaded file info (name + size)
        filesInfo: {
            linux: cfg.fileInfoLinux || null,
            win:   cfg.fileInfoWin   || null,
            mac:   cfg.fileInfoMac   || null,
        },
    });
});

// ── POST /api/version/upload — upload a release file ─────────────
// Form fields: file (binary), platform (linux | win | mac)
router.post('/upload', requireAuth, requireAdmin, upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const platform = (req.body.platform || '').toLowerCase();
    if (!['linux', 'win', 'mac'].includes(platform)) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: 'platform must be linux | win | mac' });
    }

    const fileUrl  = `${getBaseUrl(req)}/releases/${req.file.filename}`;
    const fileInfo = { name: req.file.originalname, size: req.file.size, url: fileUrl };

    const urlKey  = { linux: 'downloadUrlLinux', win: 'downloadUrlWin', mac: 'downloadUrlMac' }[platform];
    const infoKey = { linux: 'fileInfoLinux',    win: 'fileInfoWin',    mac: 'fileInfoMac'    }[platform];

    db.saveConfig({ [urlKey]: fileUrl, [infoKey]: fileInfo });
    db.addLog(req.user.id, null, 'upload_release', `platform=${platform},file=${req.file.filename},size=${req.file.size}`);

    res.json({ ok: true, platform, url: fileUrl, file: fileInfo });
});

// ── DELETE /api/version/upload/:platform — remove a file ─────────
router.delete('/upload/:platform', requireAuth, requireAdmin, (req, res) => {
    const platform = req.params.platform.toLowerCase();
    if (!['linux', 'win', 'mac'].includes(platform)) {
        return res.status(400).json({ error: 'platform must be linux | win | mac' });
    }

    const urlKey  = { linux: 'downloadUrlLinux', win: 'downloadUrlWin', mac: 'downloadUrlMac' }[platform];
    const infoKey = { linux: 'fileInfoLinux',    win: 'fileInfoWin',    mac: 'fileInfoMac'    }[platform];

    const cfg  = db.getConfig();
    const info = cfg[infoKey];
    if (info && info.url) {
        const filePath = path.join(RELEASES_DIR, path.basename(info.url));
        try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
    }
    db.saveConfig({ [urlKey]: '', [infoKey]: null });
    db.addLog(req.user.id, null, 'delete_release', `platform=${platform}`);

    res.json({ ok: true });
});

// ── PUT /api/version — set version metadata ───────────────────────
router.put('/', requireAuth, requireAdmin, (req, res) => {
    const { latestVersion, releaseNotes, forceUpdate,
            downloadUrlLinux, downloadUrlWin, downloadUrlMac } = req.body || {};

    if (!latestVersion) return res.status(400).json({ error: 'latestVersion required' });
    if (!/^\d+\.\d+\.\d+$/.test(latestVersion)) {
        return res.status(400).json({ error: 'latestVersion must be in x.y.z format' });
    }

    const patch = { latestVersion, releaseNotes: releaseNotes ?? '', forceUpdate: !!forceUpdate };
    if (downloadUrlLinux !== undefined) patch.downloadUrlLinux = downloadUrlLinux;
    if (downloadUrlWin   !== undefined) patch.downloadUrlWin   = downloadUrlWin;
    if (downloadUrlMac   !== undefined) patch.downloadUrlMac   = downloadUrlMac;

    db.saveConfig(patch);
    db.addLog(req.user.id, null, 'set_version', `version=${latestVersion}`);

    res.json({ ok: true, ...patch });
});

module.exports = router;
