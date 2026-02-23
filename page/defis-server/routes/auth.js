'use strict';

const express  = require('express');
const bcrypt   = require('bcryptjs');
const db       = require('../db');
const { signToken, requireAuth } = require('../auth');

const router = express.Router();

// POST /api/auth/login
router.post('/login', (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });

    const user = db.getUserByEmail(email);
    if (!user || !user.is_active) return res.status(401).json({ error: 'Invalid credentials' });

    const ok = bcrypt.compareSync(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    db.addLog(user.id, null, 'login', `email=${email}`);

    const token = signToken({ id: user.id, email: user.email, role: user.role, name: user.name });
    res.json({
        token,
        user: { id: user.id, email: user.email, name: user.name, role: user.role },
    });
});

// GET /api/auth/me — validate token + get current user
router.get('/me', requireAuth, (req, res) => {
    res.json({ user: req.user });
});

module.exports = router;
