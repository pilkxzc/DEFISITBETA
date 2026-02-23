'use strict';

const express = require('express');
const db      = require('../db');
const { requireAuth, requireAdmin } = require('../auth');

const router = express.Router();

router.use(requireAuth);

// GET /api/config
router.get('/', (req, res) => {
    res.json(db.getConfig());
});

// PUT /api/config  (admin only)
router.put('/', requireAdmin, (req, res) => {
    const cfg = db.saveConfig(req.body || {});
    db.addLog(req.user.id, null, 'save_config', '');
    res.json(cfg);
});

module.exports = router;
