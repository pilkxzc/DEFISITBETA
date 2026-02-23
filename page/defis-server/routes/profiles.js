'use strict';

const express = require('express');
const db      = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

// All routes require auth
router.use(requireAuth);

// GET /api/profiles
router.get('/', (req, res) => {
    const profiles = db.getProfiles(req.user.id, req.user.role);
    res.json(profiles);
});

// GET /api/profiles/:id
router.get('/:id', (req, res) => {
    const p = db.getProfile(req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    res.json(p);
});

// POST /api/profiles  (admin/manager)
router.post('/', (req, res) => {
    if (req.user.role !== 'admin' && req.user.role !== 'manager') {
        return res.status(403).json({ error: 'Forbidden' });
    }
    try {
        const profile = db.createProfile(req.body);
        db.addLog(req.user.id, profile.id, 'create_profile', `name=${profile.name}`);
        res.status(201).json(profile);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// PUT /api/profiles/:id  (admin/manager)
router.put('/:id', (req, res) => {
    if (req.user.role !== 'admin' && req.user.role !== 'manager') {
        return res.status(403).json({ error: 'Forbidden' });
    }
    const profile = db.updateProfile(req.params.id, req.body);
    if (!profile) return res.status(404).json({ error: 'Not found' });
    db.addLog(req.user.id, profile.id, 'update_profile', `name=${profile.name}`);
    res.json(profile);
});

// DELETE /api/profiles/:id  (admin)
router.delete('/:id', (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    const ok = db.deleteProfile(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Not found' });
    db.addLog(req.user.id, req.params.id, 'delete_profile', '');
    res.json({ ok: true });
});

// GET /api/profiles/:id/cookies
router.get('/:id/cookies', (req, res) => {
    res.json(db.getCookies(req.params.id));
});

// PUT /api/profiles/:id/cookies
router.put('/:id/cookies', (req, res) => {
    const data = Array.isArray(req.body) ? req.body : [];
    db.saveCookies(req.params.id, data);
    res.json({ ok: true });
});

module.exports = router;
