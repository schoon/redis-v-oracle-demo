'use strict';

const path = require('path');

// One place for anything the seeders, the server and the docs need to agree on.
//
// Ports are deliberately clear of the redis-v-solr-demo and of a default local
// Redis, so all of them can run at once:
//   6379  a local Redis you may already have
//   6380  redis-v-solr-demo
//   6381  this demo
//   3000  leaderboard      3010  solr demo      3020  this demo
//   8983  Solr             1522  this Oracle (rather than the 1521 default)
module.exports = {
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6381',
  PORT: process.env.PORT || 3020,

  ORACLE: {
    user: process.env.ORACLE_USER || 'counterparty',
    password: process.env.ORACLE_PASSWORD || 'demopassword',
    connectString: process.env.ORACLE_CONNECT || 'localhost:1522/FREEPDB1',
  },
  ORACLE_TABLE: 'counterparties',

  // Redis key layout: one Hash per counterparty at cp:<id>, indexed by prefix.
  REDIS_PREFIX: 'cp:',
  REDIS_INDEX: 'cp:idx',

  COUNT: Number(process.env.COUNT || 100000),
  DATA_FILE: path.join(__dirname, '..', 'data', 'counterparties.jsonl'),

  // Fixed seed so every run produces byte-identical data. Both engines index
  // the same file, which is what makes the latency comparison meaningful.
  SEED: 20260825,
};
