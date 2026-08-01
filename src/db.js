'use strict';

// Single shared Prisma client for the whole process.
//
// Two rules this module exists to enforce:
//
//  1. One connection pool. A second PrismaClient would open a second pool, and
//     Railway's Hobby Postgres has a modest connection limit. Everything —
//     scheduler, sweeper, webhooks, and the Phase 3 API — imports this.
//
//  2. Requiring this file must never throw. Through Stage 1 nothing in the call
//     path reads the database, and a missing or unreachable DATABASE_URL must
//     not stop the app from booting and placing calls. The client is therefore
//     built lazily on first use, not at require time.

const config = require('./config');
const logger = require('./logger');

let _client = null;

function isConfigured() {
  return Boolean(config.databaseUrl);
}

// Builds the client on first call. Throws if DATABASE_URL is unset — callers
// that can run without a database should check isConfigured() first.
function getClient() {
  if (_client) return _client;

  if (!isConfigured()) {
    throw new Error('DATABASE_URL is not set — cannot reach the database');
  }

  const { PrismaClient } = require('./generated/prisma');
  const { PrismaPg }     = require('@prisma/adapter-pg');

  // Prisma 7 connects through a driver adapter rather than its own engine, so
  // the pool is plain node-postgres and its settings are ours to tune.
  const adapter = new PrismaPg({ connectionString: config.databaseUrl });

  _client = new PrismaClient({
    adapter,
    // Warnings and errors go to our structured logger; queries stay off so a
    // reminder call's payload never lands in Railway's logs.
    log: [
      { emit: 'event', level: 'warn'  },
      { emit: 'event', level: 'error' },
    ],
  });

  _client.$on('warn',  (e) => logger.warn('prisma', { message: e.message }));
  _client.$on('error', (e) => logger.error('prisma', { message: e.message }));

  logger.info('Database client initialised');
  return _client;
}

// Cheap liveness probe for /health. Never throws: it reports rather than
// crashes, because /health is Railway's healthcheck target and a database blip
// must not get a container killed while it is still able to place calls.
async function ping(timeoutMs = 2000) {
  if (!isConfigured()) return { ok: false, reason: 'DATABASE_URL not set' };

  // Bounded on purpose: an unreachable host makes the driver sit in connect
  // retries, and /health hanging is worse than /health reporting "down".
  const timeout = new Promise((resolve) =>
    setTimeout(() => resolve({ ok: false, reason: `timed out after ${timeoutMs}ms` }), timeoutMs).unref()
  );

  const probe = getClient().$queryRaw`SELECT 1`
    .then(() => ({ ok: true }))
    .catch((err) => ({ ok: false, reason: err.message }));

  return Promise.race([probe, timeout]);
}

async function disconnect() {
  if (!_client) return;
  try {
    await _client.$disconnect();
    logger.info('Database client disconnected');
  } catch (err) {
    logger.warn('Failed to disconnect database client', { error: err.message });
  } finally {
    _client = null;
  }
}

module.exports = { getClient, isConfigured, ping, disconnect };
