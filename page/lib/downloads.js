'use strict';
const { session, app } = require('electron');
const path = require('path');

function setupDownloads(profile, win) {
    const sess = session.fromPartition(`persist:${profile.id}`);
    if (sess._defis_dl) return;
    sess._defis_dl = true;

    sess.on('will-download', (_e, item) => {
        item.setSavePath(path.join(app.getPath('downloads'), item.getFilename()));
        win.webContents.send('download-started', { filename: item.getFilename(), url: item.getURL() });
        item.on('updated', (_e, state) => {
            if (state === 'progressing' && !item.isPaused()) {
                const total = item.getTotalBytes();
                win.webContents.send('download-progress', {
                    filename: item.getFilename(),
                    progress: total > 0 ? Math.round((item.getReceivedBytes() / total) * 100) : -1,
                });
            }
        });
        item.once('done', (_e, state) => {
            win.webContents.send('download-done', { filename: item.getFilename(), state });
        });
    });
}

module.exports = { setupDownloads };
