'use strict';

// ── Load .env file (no extra deps, built-in fs only) ─────────────
const fs   = require('fs');
const path = require('path');
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
    fs.readFileSync(envFile, 'utf8').split('\n').forEach(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const eq = trimmed.indexOf('=');
        if (eq < 1) return;
        const key = trimmed.slice(0, eq).trim();
        const val = trimmed.slice(eq + 1).trim();
        if (!(key in process.env)) process.env[key] = val;
    });
}

const express = require('express');
const cors    = require('cors');
const db      = require('./db');

const PORT = process.env.DEFIS_PORT || 3717;
const HOST = process.env.DEFIS_HOST || '0.0.0.0';

// Extra allowed CORS origins from env, comma-separated
// e.g. DEFIS_ALLOWED_ORIGINS=http://example.com,https://example.com
const EXTRA_ORIGINS = (process.env.DEFIS_ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);

// Initialise DB (migrate + seed)
db.init();

const app = express();

// ── CORS ──────────────────────────────────────────────────────────
// Allow:
//   • requests with no Origin header (Electron main-process net.fetch)
//   • "null" origin  (Electron renderer running from file://)
//   • localhost / 127.0.0.1  (local development)
//   • any origin listed in DEFIS_ALLOWED_ORIGINS env variable
app.use(cors({
    origin: (origin, cb) => {
        if (!origin || origin === 'null') return cb(null, true);
        if (EXTRA_ORIGINS.includes(origin)) return cb(null, true);
        try {
            const u = new URL(origin);
            if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return cb(null, true);
        } catch {}
        cb(new Error('CORS policy: origin not allowed'));
    },
    credentials: true,
}));

app.use(express.json({ limit: '10mb' }));

// ── Static: serve uploaded release files ─────────────────────────
const releasesDir = path.join(__dirname, 'releases');
if (!fs.existsSync(releasesDir)) fs.mkdirSync(releasesDir, { recursive: true });
app.use('/releases', express.static(releasesDir, { dotfiles: 'deny' }));

// ── Simple in-memory rate limiter ─────────────────────────────────
const _rateBuckets = new Map(); // key → { count, resetAt }

function rateLimit(maxPerWindow, windowMs = 60_000) {
    return (req, res, next) => {
        const key  = req.ip + ':' + req.path;
        const now  = Date.now();
        let   slot = _rateBuckets.get(key);
        if (!slot || now > slot.resetAt) {
            slot = { count: 0, resetAt: now + windowMs };
            _rateBuckets.set(key, slot);
        }
        slot.count++;
        if (slot.count > maxPerWindow) {
            return res.status(429).json({ error: 'Too many requests, please wait.' });
        }
        next();
    };
}

// Prune stale rate buckets every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of _rateBuckets) if (now > v.resetAt) _rateBuckets.delete(k);
}, 300_000);

// ── Routes ────────────────────────────────────────────────────────
// Strict rate limit on auth endpoints (10 attempts per minute per IP)
app.use('/api/auth',    rateLimit(10, 60_000), require('./routes/auth'));
app.use('/api/profiles', require('./routes/profiles'));
app.use('/api/profiles', require('./routes/bookmarks'));
app.use('/api/profiles', require('./routes/notes'));
app.use('/api/config',   require('./routes/config'));
app.use('/api/history',  require('./routes/history'));
app.use('/api/admin',    require('./routes/admin'));
app.use('/api/version',  require('./routes/version'));

// Health
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// 404
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// Error handler
app.use((err, _req, res, _next) => {
    if (err.message && err.message.startsWith('CORS')) {
        return res.status(403).json({ error: err.message });
    }
    console.error('[server error]', err.message || err);
    res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, HOST, () => {
    console.log(`DEFIS Server  →  http://${HOST === '0.0.0.0' ? '0.0.0.0' : HOST}:${PORT}`);
});

module.exports = app;
