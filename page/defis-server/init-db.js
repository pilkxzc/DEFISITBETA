'use strict';

/**
 * DEFIS Database Initialization Script
 * Runs migrations and creates the initial admin user.
 */

const db = require('./db');

console.log('Initializing DEFIS database...');

try {
    const database = db.init();
    console.log('✔ Database initialized successfully.');
    process.exit(0);
} catch (error) {
    console.error('✘ Failed to initialize database:', error.message);
    process.exit(1);
}
