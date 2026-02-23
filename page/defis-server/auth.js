'use strict';

const jwt = require('jsonwebtoken');

const JWT_SECRET  = process.env.DEFIS_JWT_SECRET || 'defis-default-secret-change-in-prod';
const JWT_EXPIRES = '30d';

function signToken(payload) {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function verifyToken(token) {
    return jwt.verify(token, JWT_SECRET);
}

// Express middleware: require valid JWT
function requireAuth(req, res, next) {
    const header = req.headers['authorization'] || '';
    const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'No token' });
    try {
        req.user = verifyToken(token);
        next();
    } catch {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
}

// Express middleware: require admin role
function requireAdmin(req, res, next) {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    next();
}

module.exports = { signToken, verifyToken, requireAuth, requireAdmin };
