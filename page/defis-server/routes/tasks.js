'use strict';

const express = require('express');
const db      = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();
router.use(requireAuth);

// ── GET /api/tasks ────────────────────────────────────────────────
router.get('/', (req, res) => {
    res.json(db.getTasks(req.user.id, req.user.role));
});

// ── POST /api/tasks — admin only ──────────────────────────────────
router.post('/', (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    const { title, description, assignedTo, profileId, priority, dueDate } = req.body || {};
    if (!title?.trim()) return res.status(400).json({ error: 'title required' });
    const task = db.createTask({
        title: title.trim(),
        description: description || '',
        assignedTo:  assignedTo  || null,
        profileId:   profileId   || null,
        priority:    priority    || 'medium',
        dueDate:     dueDate     || null,
        createdBy:   req.user.id,
    });
    res.status(201).json(task);
});

// ── PUT /api/tasks/:id ────────────────────────────────────────────
router.put('/:id', (req, res) => {
    const task = db.getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'Not found' });
    if (req.user.role !== 'admin' && task.assigned_to !== req.user.id)
        return res.status(403).json({ error: 'Forbidden' });

    // Non-admins can only change status + subtasks
    let data = { ...req.body };
    if (req.user.role !== 'admin') {
        data = {};
        if ('status'   in req.body) data.status   = req.body.status;
        if ('subtasks' in req.body) data.subtasks  = req.body.subtasks;
    }

    const updated = db.updateTask(req.params.id, data);
    res.json(updated);
});

// ── DELETE /api/tasks/:id — admin only ───────────────────────────
router.delete('/:id', (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    const ok = db.deleteTask(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
});

// ── GET /api/tasks/:id/comments ───────────────────────────────────
router.get('/:id/comments', (req, res) => {
    const task = db.getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'Not found' });
    if (req.user.role !== 'admin' && task.assigned_to !== req.user.id)
        return res.status(403).json({ error: 'Forbidden' });
    res.json(db.getTaskComments(req.params.id));
});

// ── POST /api/tasks/:id/comments ─────────────────────────────────
router.post('/:id/comments', (req, res) => {
    const task = db.getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'Not found' });
    if (req.user.role !== 'admin' && task.assigned_to !== req.user.id)
        return res.status(403).json({ error: 'Forbidden' });
    const { content } = req.body || {};
    if (!content?.trim()) return res.status(400).json({ error: 'content required' });
    const comment = db.addTaskComment(req.params.id, req.user.id, content.trim());
    res.status(201).json(comment);
});

// ── DELETE /api/tasks/:id/comments/:cid ──────────────────────────
router.delete('/:id/comments/:cid', (req, res) => {
    const comment = db.getTaskComment(req.params.cid);
    if (!comment) return res.status(404).json({ error: 'Not found' });
    if (req.user.role !== 'admin' && comment.user_id !== req.user.id)
        return res.status(403).json({ error: 'Forbidden' });
    db.deleteTaskComment(req.params.cid);
    res.json({ ok: true });
});

module.exports = router;
