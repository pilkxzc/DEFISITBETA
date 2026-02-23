'use strict';
const { app } = require('electron');
const path = require('path');
const fs   = require('fs');

const AUTH_TOKEN_PATH = path.join(app.getPath('userData'), 'defis-auth.json');

function loadSavedToken() {
    try {
        if (fs.existsSync(AUTH_TOKEN_PATH)) {
            const d = JSON.parse(fs.readFileSync(AUTH_TOKEN_PATH, 'utf8'));
            return d.token || null;
        }
    } catch {}
    return null;
}

function saveToken(token) {
    try { fs.writeFileSync(AUTH_TOKEN_PATH, JSON.stringify({ token }), 'utf8'); } catch {}
}

function clearToken() {
    try { fs.writeFileSync(AUTH_TOKEN_PATH, JSON.stringify({ token: null }), 'utf8'); } catch {}
}

module.exports = { AUTH_TOKEN_PATH, loadSavedToken, saveToken, clearToken };
