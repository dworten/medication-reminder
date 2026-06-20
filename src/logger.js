'use strict';

const fs   = require('fs');
const path = require('path');

const LOG_DIR  = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'calls.log');

if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function write(level, message, data) {
  const entry = { ts: new Date().toISOString(), level, message, ...data };
  fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');

  const extras = Object.keys(data).length ? '  ' + JSON.stringify(data) : '';
  const tag    = `[${level.toUpperCase().padEnd(5)}]`;
  console.log(`[${entry.ts}] ${tag} ${message}${extras}`);
}

module.exports = {
  info:  (msg, data = {}) => write('info',  msg, data),
  warn:  (msg, data = {}) => write('warn',  msg, data),
  error: (msg, data = {}) => write('error', msg, data),
  call:  (msg, data = {}) => write('call',  msg, data),
};
