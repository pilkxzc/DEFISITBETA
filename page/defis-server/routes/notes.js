'use strict';

const express = require('express');
const db      = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

router.use(requireAuth);

// Helper: check profile access
function canAccessProfile(user, profileId) {
    if (user.role === 'admin') return true;
    const dbInstance = db.getDb();
    const row = dbInstance.prepare(
        'SELECT 1 FROM profile_assignments WHERE profile_id = ? AND user_id = ?'
    ).get(profileId, user.id);
    return !!row;
}

// GET /api/profiles/:id/notes
router.get('/:id/notes', (req, res) => {
    if (!canAccessProfile(req.user, req.params.id)) return res.status(403).json({ error: 'Forbidden' });
    res.json(db.getNotes(req.params.id));
});

// POST /api/profiles/:id/notes   body: { id?, title, content, scope, visibility }
router.post('/:id/notes', (req, res) => {
    if (!canAccessProfile(req.user, req.params.id)) return res.status(403).json({ error: 'Forbidden' });
    const note = db.saveNote(req.params.id, req.body || {});
    res.status(201).json(note);
});

// DELETE /api/profiles/:id/notes/:noteId
router.delete('/:id/notes/:noteId', (req, res) => {
    if (!canAccessProfile(req.user, req.params.id)) return res.status(403).json({ error: 'Forbidden' });
    const ok = db.deleteNote(req.params.noteId);
    if (!ok) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
});

module.exports = router;
