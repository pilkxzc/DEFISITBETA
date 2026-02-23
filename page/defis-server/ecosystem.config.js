'use strict';

module.exports = {
    apps: [
        {
            name:        'defis-server',
            script:      'server.js',
            cwd:         '/opt/defis-server',
            instances:   1,
            autorestart: true,
            watch:       false,
            max_memory_restart: '256M',
            env: {
                NODE_ENV:         'production',
                DEFIS_PORT:       '3717',
                DEFIS_HOST:       '0.0.0.0',
                // Load secrets from .env — set real values in /opt/defis-server/.env
            },
        },
    ],
};
