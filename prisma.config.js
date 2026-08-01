'use strict';

// Prisma 7 no longer reads the connection URL from schema.prisma, and no longer
// auto-loads .env — both move here. This file configures the Prisma *CLI*
// (migrate, studio, db). The running app builds its own connection in
// src/db.js; the two deliberately read the same DATABASE_URL.
require('dotenv').config();

const { defineConfig } = require('prisma/config');

module.exports = defineConfig({
  schema: 'prisma/schema.prisma',

  datasource: {
    url: process.env.DATABASE_URL,
  },

  migrations: {
    path: 'prisma/migrations',
    seed: 'node prisma/seed.js',
  },
});
