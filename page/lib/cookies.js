'use strict';
const { session } = require('electron');
const api = require('../api-client');

async function loadCookiesForProfile(profile) {
    try {
        const cookies = await api.getCookies(profile.id);
        if (!Array.isArray(cookies) || cookies.length === 0) return;
        const sess = session.fromPartition(`persist:${profile.id}`);
        for (const c of cookies) {
            try { await sess.cookies.set(c); } catch {}
        }
    } catch (e) { console.error('loadCookiesForProfile:', e.message); }
}

async function saveCookiesForProfile(profile) {
    try {
        const sess    = session.fromPartition(`persist:${profile.id}`);
        const cookies = await sess.cookies.get({});
        await api.saveCookies(profile.id, cookies);
    } catch (e) { console.error('saveCookiesForProfile:', e.message); }
}

module.exports = { loadCookiesForProfile, saveCookiesForProfile };
