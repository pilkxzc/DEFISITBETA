'use strict';

const express = require('express');
const db      = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

router.use(requireAuth);

// Helper: check profile access (admin sees all; user must be assigned)
function canAccessProfile(user, profileId) {
    if (user.role === 'admin') return true;
    const dbInstance = db.getDb();
    const row = dbInstance.prepare(
        'SELECT 1 FROM profile_assignments WHERE profile_id = ? AND user_id = ?'
    ).get(profileId, user.id);
    return !!row;
}

// GET /api/profiles/:id/bookmarks
router.get('/:id/bookmarks', (req, res) => {
    if (!canAccessProfile(req.user, req.params.id)) return res.status(403).json({ error: 'Forbidden' });
    res.json(db.getBookmarks(req.params.id));
});

// POST /api/profiles/:id/bookmarks   body: { url, title }
router.post('/:id/bookmarks', (req, res) => {
    if (!canAccessProfile(req.user, req.params.id)) return res.status(403).json({ error: 'Forbidden' });
    const { url, title } = req.body || {};
    if (!url) return res.status(400).json({ error: 'url required' });
    const bm = db.addBookmark(req.params.id, url, title || url);
    res.status(201).json(bm);
});

// DELETE /api/profiles/:id/bookmarks/:bmId
router.delete('/:id/bookmarks/:bmId', (req, res) => {
    if (!canAccessProfile(req.user, req.params.id)) return res.status(403).json({ error: 'Forbidden' });
    const ok = db.removeBookmark(req.params.id, req.params.bmId);
    if (!ok) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
});

module.exports = router;
