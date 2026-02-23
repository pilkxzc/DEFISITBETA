'use strict';

const express = require('express');
const db      = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

router.use(requireAuth);

// GET /api/history
router.get('/', (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    res.json(db.getHistory(req.user.id, req.user.role, limit));
});

// POST /api/history
router.post('/', (req, res) => {
    const { profileId, url, title } = req.body || {};
    if (!url) return res.status(400).json({ error: 'url required' });
    db.addHistory(profileId || '', req.user.id, url, title || '');
    res.json({ ok: true });
});

// DELETE /api/history — clear own history
router.delete('/', (req, res) => {
    const count = db.clearHistory(req.user.id);
    res.json({ ok: true, deleted: count });
});

module.exports = router;
