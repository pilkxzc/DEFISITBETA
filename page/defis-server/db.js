'use strict';

const Database = require('better-sqlite3');
const bcrypt   = require('bcryptjs');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');

const DB_PATH = process.env.DEFIS_DB || path.join(__dirname, 'defis.db');

let db;

function getDb() {
    if (!db) db = new Database(DB_PATH);
    return db;
}

function migrate() {
    const db = getDb();
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            email       TEXT    NOT NULL UNIQUE,
            password_hash TEXT  NOT NULL,
            role        TEXT    NOT NULL DEFAULT 'user',
            name        TEXT    NOT NULL DEFAULT '',
            created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
            is_active   INTEGER NOT NULL DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS profiles (
            id              TEXT    PRIMARY KEY,
            name            TEXT    NOT NULL DEFAULT 'Profile',
            color           TEXT    NOT NULL DEFAULT '#9d7cce',
            os              TEXT    NOT NULL DEFAULT 'win11',
            browser_version TEXT    NOT NULL DEFAULT 'chrome120',
            proxy           TEXT    NOT NULL DEFAULT '{}',
            fingerprint     TEXT    NOT NULL DEFAULT '{}',
            timezone        TEXT    NOT NULL DEFAULT 'auto',
            timezone_value  TEXT    NOT NULL DEFAULT 'Europe/Kyiv',
            dnt             INTEGER NOT NULL DEFAULT 0,
            fonts           INTEGER NOT NULL DEFAULT 1,
            number          INTEGER DEFAULT NULL,
            updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        );

        CREATE TABLE IF NOT EXISTS profile_assignments (
            profile_id  TEXT    NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
            user_id     INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
            PRIMARY KEY (profile_id, user_id)
        );

        CREATE TABLE IF NOT EXISTS cookies (
            profile_id  TEXT    PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
            data        TEXT    NOT NULL DEFAULT '[]',
            updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        );

        CREATE TABLE IF NOT EXISTS history (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            profile_id  TEXT    NOT NULL,
            user_id     INTEGER NOT NULL,
            url         TEXT    NOT NULL,
            title       TEXT    NOT NULL DEFAULT '',
            timestamp   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        );

        CREATE TABLE IF NOT EXISTS config (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS logs (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id     INTEGER,
            profile_id  TEXT,
            action      TEXT    NOT NULL,
            detail      TEXT    NOT NULL DEFAULT '',
            timestamp   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        );

        CREATE TABLE IF NOT EXISTS bookmarks (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            profile_id TEXT    NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
            url        TEXT    NOT NULL,
            title      TEXT    NOT NULL DEFAULT '',
            added_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
            UNIQUE(profile_id, url)
        );

        CREATE TABLE IF NOT EXISTS notes (
            id         TEXT    PRIMARY KEY,
            profile_id TEXT    NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
            title      TEXT    NOT NULL DEFAULT '',
            content    TEXT    NOT NULL DEFAULT '',
            scope      TEXT    NOT NULL DEFAULT 'profile',
            visibility TEXT    NOT NULL DEFAULT 'private',
            created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
            updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        );

        CREATE TABLE IF NOT EXISTS tasks (
            id          TEXT    PRIMARY KEY,
            title       TEXT    NOT NULL,
            description TEXT    NOT NULL DEFAULT '',
            subtasks    TEXT    NOT NULL DEFAULT '[]',
            created_by  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
            profile_id  TEXT    REFERENCES profiles(id) ON DELETE SET NULL,
            status      TEXT    NOT NULL DEFAULT 'todo',
            priority    TEXT    NOT NULL DEFAULT 'medium',
            due_date    INTEGER,
            created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
            updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        );

        CREATE TABLE IF NOT EXISTS task_comments (
            id         TEXT    PRIMARY KEY,
            task_id    TEXT    NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            content    TEXT    NOT NULL,
            created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        );
    `);

    // ── Column migrations (safe to run on existing DB) ────────────
    try { db.exec('ALTER TABLE profiles ADD COLUMN number  INTEGER DEFAULT NULL'); } catch {}
    try { db.exec("ALTER TABLE profiles ADD COLUMN plugins TEXT    DEFAULT '{}'"); } catch {}
}

function seed() {
    const db = getDb();

    // Check if admin user exists
    const admin = db.prepare('SELECT id FROM users WHERE role = ?').get('admin');
    if (admin) return;

    // Generate random password and print to console
    const rawPassword = crypto.randomBytes(8).toString('hex');
    const hash        = bcrypt.hashSync(rawPassword, 10);

    db.prepare(`
        INSERT INTO users (email, password_hash, role, name)
        VALUES (?, ?, 'admin', 'Administrator')
    `).run('gerbera.uh@gmail.com', hash);

    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║         DEFIS Server — First-Run Setup           ║');
    console.log('╠══════════════════════════════════════════════════╣');
    console.log(`║  Admin email:    gerbera.uh@gmail.com            ║`);
    console.log(`║  Admin password: ${rawPassword.padEnd(32)}║`);
    console.log('╚══════════════════════════════════════════════════╝\n');

    // Save credentials to a file in the server directory (only on first run)
    const credsPath = path.join(__dirname, '.admin-credentials');
    fs.writeFileSync(credsPath, `email: gerbera.uh@gmail.com\npassword: ${rawPassword}\n`, 'utf8');
    console.log(`Credentials also saved to: ${credsPath}\n`);
}

function init() {
    migrate();
    seed();
    return getDb();
}

// ── Helper functions ──────────────────────────────────────────────

function genId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ── Profile helpers ───────────────────────────────────────────────

function profileToJson(row) {
    if (!row) return null;
    return {
        id:             row.id,
        name:           row.name,
        color:          row.color,
        os:             row.os,
        browserVersion: row.browser_version,
        proxy:          JSON.parse(row.proxy || '{}'),
        fingerprint:    JSON.parse(row.fingerprint || '{}'),
        timezone:       row.timezone,
        timezoneValue:  row.timezone_value,
        dnt:            !!row.dnt,
        fonts:          !!row.fonts,
        number:         row.number ?? null,
        plugins:        JSON.parse(row.plugins || '{}'),
        updatedAt:      row.updated_at,
    };
}

function getProfiles(userId, role) {
    const db = getDb();
    let rows;
    if (role === 'admin') {
        rows = db.prepare('SELECT * FROM profiles ORDER BY updated_at DESC').all();
    } else {
        rows = db.prepare(`
            SELECT p.* FROM profiles p
            JOIN profile_assignments pa ON pa.profile_id = p.id
            WHERE pa.user_id = ?
            ORDER BY p.updated_at DESC
        `).all(userId);
    }
    return rows.map(profileToJson);
}

function getProfile(id) {
    const db = getDb();
    return profileToJson(db.prepare('SELECT * FROM profiles WHERE id = ?').get(id));
}

function createProfile(data) {
    const db = getDb();
    const id = data.id || genId();
    db.prepare(`
        INSERT INTO profiles (id, name, color, os, browser_version, proxy, fingerprint, timezone, timezone_value, dnt, fonts, number, plugins)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        id,
        data.name || 'Profile',
        data.color || '#9d7cce',
        data.os || 'win11',
        data.browserVersion || 'chrome120',
        JSON.stringify(data.proxy || {}),
        JSON.stringify(data.fingerprint || {}),
        data.timezone || 'auto',
        data.timezoneValue || 'Europe/Kyiv',
        data.dnt ? 1 : 0,
        data.fonts !== false ? 1 : 0,
        data.number != null ? parseInt(data.number) : null,
        JSON.stringify(data.plugins || {}),
    );
    return getProfile(id);
}

function updateProfile(id, data) {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM profiles WHERE id = ?').get(id);
    if (!existing) return null;
    db.prepare(`
        UPDATE profiles SET
            name           = ?,
            color          = ?,
            os             = ?,
            browser_version = ?,
            proxy          = ?,
            fingerprint    = ?,
            timezone       = ?,
            timezone_value = ?,
            dnt            = ?,
            fonts          = ?,
            number         = ?,
            plugins        = ?,
            updated_at     = strftime('%s','now')
        WHERE id = ?
    `).run(
        data.name           ?? existing.name,
        data.color          ?? existing.color,
        data.os             ?? existing.os,
        data.browserVersion ?? existing.browser_version,
        JSON.stringify(data.proxy       ?? JSON.parse(existing.proxy)),
        JSON.stringify(data.fingerprint ?? JSON.parse(existing.fingerprint)),
        data.timezone       ?? existing.timezone,
        data.timezoneValue  ?? existing.timezone_value,
        data.dnt !== undefined ? (data.dnt ? 1 : 0) : existing.dnt,
        data.fonts !== undefined ? (data.fonts !== false ? 1 : 0) : existing.fonts,
        'number' in data ? (data.number != null ? parseInt(data.number) : null) : existing.number,
        JSON.stringify(data.plugins ?? JSON.parse(existing.plugins || '{}')),
        id,
    );
    return getProfile(id);
}

function deleteProfile(id) {
    const db = getDb();
    return db.prepare('DELETE FROM profiles WHERE id = ?').run(id).changes > 0;
}

// ── Cookie helpers ────────────────────────────────────────────────

function getCookies(profileId) {
    const db = getDb();
    const row = db.prepare('SELECT data FROM cookies WHERE profile_id = ?').get(profileId);
    return row ? JSON.parse(row.data) : [];
}

function saveCookies(profileId, data) {
    const db = getDb();
    db.prepare(`
        INSERT INTO cookies (profile_id, data, updated_at)
        VALUES (?, ?, strftime('%s','now'))
        ON CONFLICT(profile_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
    `).run(profileId, JSON.stringify(data));
}

// ── Config helpers ────────────────────────────────────────────────

function getConfig() {
    const db = getDb();
    const rows = db.prepare('SELECT key, value FROM config').all();
    const cfg  = {};
    rows.forEach(r => {
        try { cfg[r.key] = JSON.parse(r.value); } catch { cfg[r.key] = r.value; }
    });
    return cfg;
}

function saveConfig(data) {
    const db = getDb();
    const upsert = db.prepare(`
        INSERT INTO config (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    const upsertAll = db.transaction(entries => {
        for (const [k, v] of entries) upsert.run(k, JSON.stringify(v));
    });
    upsertAll(Object.entries(data));
    return getConfig();
}

// ── History helpers ───────────────────────────────────────────────

function addHistory(profileId, userId, url, title) {
    const db = getDb();
    db.prepare(`
        INSERT INTO history (profile_id, user_id, url, title)
        VALUES (?, ?, ?, ?)
    `).run(profileId, userId, url, title || '');
}

function getHistory(userId, role, limit = 100) {
    const db = getDb();
    if (role === 'admin') {
        return db.prepare('SELECT * FROM history ORDER BY timestamp DESC LIMIT ?').all(limit);
    }
    return db.prepare('SELECT * FROM history WHERE user_id = ? ORDER BY timestamp DESC LIMIT ?').all(userId, limit);
}

function clearHistory(userId) {
    const db = getDb();
    return db.prepare('DELETE FROM history WHERE user_id = ?').run(userId).changes;
}

// ── User helpers ──────────────────────────────────────────────────

function getUsers() {
    const db    = getDb();
    const users = db.prepare('SELECT id, email, name, role, created_at, is_active FROM users ORDER BY created_at ASC').all();
    const stmt  = db.prepare('SELECT profile_id FROM profile_assignments WHERE user_id = ?');
    return users.map(u => ({ ...u, profileIds: stmt.all(u.id).map(r => r.profile_id) }));
}

function getUserByEmail(email) {
    const db = getDb();
    return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}

function createUser(email, password, name, role = 'user') {
    const db   = getDb();
    const hash = bcrypt.hashSync(password, 10);
    const info = db.prepare(`
        INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)
    `).run(email, hash, name || '', role);
    return db.prepare('SELECT id, email, name, role, created_at, is_active FROM users WHERE id = ?').get(info.lastInsertRowid);
}

function deleteUser(id) {
    const db = getDb();
    return db.prepare('DELETE FROM users WHERE id = ?').run(id).changes > 0;
}

function updateUser(id, { role, name, is_active } = {}) {
    const db     = getDb();
    const fields = [];
    const vals   = [];
    if (role      !== undefined) { fields.push('role = ?');      vals.push(role); }
    if (name      !== undefined) { fields.push('name = ?');      vals.push(name); }
    if (is_active !== undefined) { fields.push('is_active = ?'); vals.push(is_active ? 1 : 0); }
    if (!fields.length) return false;
    vals.push(id);
    return db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...vals).changes > 0;
}

function assignProfilesToUser(userId, profileIds) {
    const db = getDb();
    const del    = db.prepare('DELETE FROM profile_assignments WHERE user_id = ?');
    const insert = db.prepare('INSERT OR IGNORE INTO profile_assignments (profile_id, user_id) VALUES (?, ?)');
    db.transaction(() => {
        del.run(userId);
        for (const pid of profileIds) insert.run(pid, userId);
    })();
}

// ── Bookmark helpers ──────────────────────────────────────────────

function getBookmarks(profileId) {
    const db = getDb();
    return db.prepare('SELECT id, url, title, added_at FROM bookmarks WHERE profile_id = ? ORDER BY added_at DESC').all(profileId);
}

function addBookmark(profileId, url, title) {
    const db = getDb();
    db.prepare(`
        INSERT INTO bookmarks (profile_id, url, title)
        VALUES (?, ?, ?)
        ON CONFLICT(profile_id, url) DO UPDATE SET title = excluded.title
    `).run(profileId, url, title || '');
    return db.prepare('SELECT id, url, title, added_at FROM bookmarks WHERE profile_id = ? AND url = ?').get(profileId, url);
}

function removeBookmark(profileId, bmId) {
    const db = getDb();
    return db.prepare('DELETE FROM bookmarks WHERE id = ? AND profile_id = ?').run(bmId, profileId).changes > 0;
}

// ── Note helpers ──────────────────────────────────────────────────

function getNotes(profileId) {
    const db = getDb();
    return db.prepare('SELECT * FROM notes WHERE profile_id = ? ORDER BY updated_at DESC').all(profileId);
}

function saveNote(profileId, note) {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    const id = note.id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 7));
    db.prepare(`
        INSERT INTO notes (id, profile_id, title, content, scope, visibility, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            title      = excluded.title,
            content    = excluded.content,
            scope      = excluded.scope,
            visibility = excluded.visibility,
            updated_at = excluded.updated_at
    `).run(
        id, profileId,
        note.title || '', note.content || '',
        note.scope || 'profile', note.visibility || 'private',
        now, now,
    );
    return db.prepare('SELECT * FROM notes WHERE id = ?').get(id);
}

function deleteNote(id) {
    const db = getDb();
    return db.prepare('DELETE FROM notes WHERE id = ?').run(id).changes > 0;
}

// ── Task helpers ──────────────────────────────────────────────────

const TASK_SELECT = `
    SELECT t.*,
           u.name  AS assignee_name,  u.email AS assignee_email,
           cu.name AS creator_name,   cu.email AS creator_email,
           p.name  AS profile_name,   p.color  AS profile_color,
           (SELECT COUNT(*) FROM task_comments tc WHERE tc.task_id = t.id) AS comment_count
    FROM tasks t
    LEFT JOIN users    u  ON u.id  = t.assigned_to
    LEFT JOIN users    cu ON cu.id = t.created_by
    LEFT JOIN profiles p  ON p.id  = t.profile_id`;

function taskRow(row) {
    if (!row) return null;
    return { ...row, subtasks: JSON.parse(row.subtasks || '[]') };
}

function getTasks(userId, role) {
    const db = getDb();
    const rows = role === 'admin'
        ? db.prepare(TASK_SELECT + ' ORDER BY t.created_at DESC').all()
        : db.prepare(TASK_SELECT + ' WHERE t.assigned_to = ? ORDER BY t.created_at DESC').all(userId);
    return rows.map(taskRow);
}

function getTask(id) {
    const db = getDb();
    return taskRow(db.prepare(TASK_SELECT + ' WHERE t.id = ?').get(id));
}

function createTask(data) {
    const db = getDb();
    const id = genId();
    db.prepare(`
        INSERT INTO tasks (id, title, description, subtasks, created_by, assigned_to, profile_id, status, priority, due_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        id,
        data.title,
        data.description || '',
        JSON.stringify(data.subtasks || []),
        data.createdBy,
        data.assignedTo  || null,
        data.profileId   || null,
        data.status      || 'todo',
        data.priority    || 'medium',
        data.dueDate     || null,
    );
    return getTask(id);
}

function updateTask(id, data) {
    const db = getDb();
    const existing = getTask(id);
    if (!existing) return null;

    const fields = [];
    const values = [];

    if ('title'       in data) { fields.push('title = ?');       values.push(data.title); }
    if ('description' in data) { fields.push('description = ?'); values.push(data.description); }
    if ('subtasks'    in data) { fields.push('subtasks = ?');    values.push(JSON.stringify(data.subtasks)); }
    if ('assignedTo'  in data) { fields.push('assigned_to = ?'); values.push(data.assignedTo || null); }
    if ('profileId'   in data) { fields.push('profile_id = ?');  values.push(data.profileId  || null); }
    if ('status'      in data) { fields.push('status = ?');      values.push(data.status); }
    if ('priority'    in data) { fields.push('priority = ?');    values.push(data.priority); }
    if ('dueDate'     in data) { fields.push('due_date = ?');    values.push(data.dueDate    || null); }

    if (!fields.length) return existing;
    fields.push("updated_at = strftime('%s','now')");
    values.push(id);

    db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return getTask(id);
}

function deleteTask(id) {
    const db = getDb();
    return db.prepare('DELETE FROM tasks WHERE id = ?').run(id).changes > 0;
}

function getTaskComments(taskId) {
    const db = getDb();
    return db.prepare(`
        SELECT tc.*, u.name AS user_name, u.email AS user_email, u.role AS user_role
        FROM task_comments tc
        JOIN users u ON u.id = tc.user_id
        WHERE tc.task_id = ? ORDER BY tc.created_at ASC
    `).all(taskId);
}

function getTaskComment(id) {
    const db = getDb();
    return db.prepare('SELECT * FROM task_comments WHERE id = ?').get(id);
}

function addTaskComment(taskId, userId, content) {
    const db = getDb();
    const id = genId();
    db.prepare('INSERT INTO task_comments (id, task_id, user_id, content) VALUES (?, ?, ?, ?)').run(id, taskId, userId, content);
    return db.prepare(`
        SELECT tc.*, u.name AS user_name, u.email AS user_email, u.role AS user_role
        FROM task_comments tc JOIN users u ON u.id = tc.user_id WHERE tc.id = ?
    `).get(id);
}

function deleteTaskComment(id) {
    const db = getDb();
    return db.prepare('DELETE FROM task_comments WHERE id = ?').run(id).changes > 0;
}

// ── Logs ─────────────────────────────────────────────────────────

function addLog(userId, profileId, action, detail = '') {
    const db = getDb();
    db.prepare(`
        INSERT INTO logs (user_id, profile_id, action, detail) VALUES (?, ?, ?, ?)
    `).run(userId || null, profileId || null, action, detail);
}

function getLogs(limit = 200) {
    const db = getDb();
    return db.prepare(`
        SELECT l.*, u.email as user_email FROM logs l
        LEFT JOIN users u ON u.id = l.user_id
        ORDER BY l.timestamp DESC LIMIT ?
    `).all(limit);
}

module.exports = {
    init, getDb,
    getProfiles, getProfile, createProfile, updateProfile, deleteProfile,
    getCookies, saveCookies,
    getConfig, saveConfig,
    addHistory, getHistory, clearHistory,
    getUsers, getUserByEmail, createUser, updateUser, deleteUser, assignProfilesToUser,
    addLog, getLogs,
    getBookmarks, addBookmark, removeBookmark,
    getNotes, saveNote, deleteNote,
    getTasks, getTask, createTask, updateTask, deleteTask,
    getTaskComments, getTaskComment, addTaskComment, deleteTaskComment,
};
