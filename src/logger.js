'use strict';

// Logs go to stdout/stderr only — no files.
//
// Railway's filesystem is ephemeral: anything written to logs/ is lost on every
// deploy and restart, and appendFileSync blocked the event loop on each line.
// Railway captures stdout/stderr and makes it searchable, so structured JSON
// lines there are strictly better. Durable per-call records land in the
// call_history table in phase 2.

const config = require('./config');

// JSON in production so Railway can parse the fields; human-readable locally.
const asJson = config.nodeEnv === 'production' || process.env.LOG_FORMAT === 'json';

function write(level, message, data) {
  const entry  = { ts: new Date().toISOString(), level, message, ...data };
  const stream = level === 'error' ? process.stderr : process.stdout;

  if (asJson) {
    stream.write(JSON.stringify(entry) + '\n');
    return;
  }

  const extras = Object.keys(data).length ? '  ' + JSON.stringify(data) : '';
  const tag    = `[${level.toUpperCase().padEnd(5)}]`;
  stream.write(`[${entry.ts}] ${tag} ${message}${extras}\n`);
}

module.exports = {
  info:  (msg, data = {}) => write('info',  msg, data),
  warn:  (msg, data = {}) => write('warn',  msg, data),
  error: (msg, data = {}) => write('error', msg, data),
  call:  (msg, data = {}) => write('call',  msg, data),
};
