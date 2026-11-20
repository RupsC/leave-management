'use strict';

const { createApp } = require('./app');
const { config } = require('./lib/env');

const { app, db } = createApp();

const server = app.listen(config.port, config.host, () => {
  const users = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  console.log('');
  console.log('  Leave Management System');
  console.log(`  Open http://${config.host}:${config.port}`);
  console.log(`  Database: ${config.dbPath}`);
  console.log(`  Supporting documents: ${config.uploadDir}`);
  if (users === 0) {
    console.log('  No accounts yet. Run "npm run seed" to load the demo data.');
  } else {
    console.log(`  ${users} account(s) in the database. Demo logins are in the README.`);
  }
  console.log('');
});

function shutdown(signal) {
  console.log(`\n${signal} received, closing down.`);
  server.close(() => {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
