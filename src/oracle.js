'use strict';

// Oracle access, in one place.
//
// Uses node-oracledb in **thin mode** — pure JavaScript, no Oracle Instant
// Client to install. That matters for a laptop demo: the alternative is a
// platform-specific native client download before anything runs at all.
//
// A connection pool rather than one connection: Oracle connections are
// expensive to establish (a dedicated server process per session by default),
// and opening one per query would measure connection setup rather than query
// execution. Redis multiplexes one connection, so this keeps both sides fair.

const oracledb = require('oracledb');
const { ORACLE, ORACLE_TABLE } = require('./config');

oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
// Vectors come back as Float32Array by default; plain arrays are easier to
// hand to JSON without a conversion step at every call site.
oracledb.fetchTypeHandler = function handler(metaData) {
  if (metaData.dbType === oracledb.DB_TYPE_VECTOR) {
    return { converter: (v) => (v ? Array.from(v) : v) };
  }
  return undefined;
};

let pool = null;

async function init({ min = 2, max = 16 } = {}) {
  if (pool) return pool;
  pool = await oracledb.createPool({
    ...ORACLE,
    poolMin: min,
    poolMax: max,
    poolIncrement: 1,
    // Statement cache: Oracle parses SQL once and reuses the plan. Leaving this
    // at zero would have every query pay a hard parse, which is not how anyone
    // runs Oracle and would flatter Redis for the wrong reason.
    stmtCacheSize: 60,
  });
  return pool;
}

async function close() {
  if (pool) {
    await pool.close(5);
    pool = null;
  }
}

// Runs a query and returns its rows. `binds` are always used rather than string
// interpolation: it's how Oracle is meant to be driven, it lets the statement
// cache reuse a plan across calls, and it removes any question of injection.
async function query(sql, binds = {}, opts = {}) {
  const conn = await pool.getConnection();
  try {
    const res = await conn.execute(sql, binds, opts);
    return res.rows || [];
  } finally {
    await conn.close();
  }
}

async function exec(sql, binds = {}) {
  const conn = await pool.getConnection();
  try {
    const res = await conn.execute(sql, binds, { autoCommit: true });
    return res;
  } finally {
    await conn.close();
  }
}

// DDL that may legitimately fail (dropping something absent), wrapped so the
// seeders can be re-run from any state.
async function tryExec(sql) {
  try {
    await exec(sql);
    return true;
  } catch {
    return false;
  }
}

async function tableCount() {
  const rows = await query(`select count(*) as n from ${ORACLE_TABLE}`);
  return Number(rows[0].N);
}

// Which optional Oracle components this container actually has. The gvenzl
// "slim" images strip Oracle Text and Spatial, and finding that out by having a
// scenario fail mid-demo is worse than checking at startup.
async function capabilities() {
  const has = async (sql) => {
    try { await query(sql); return true; } catch { return false; }
  };
  return {
    text: await has("select count(*) as n from all_indextypes where indextype_name = 'CONTEXT'"),
    spatial: await has('select sdo_geometry(2001, 4326, sdo_point_type(0,0,null), null, null) as g from dual'),
    vector: await has("select vector_distance(to_vector('[1,0]'), to_vector('[0,1]'), COSINE) as d from dual"),
  };
}

module.exports = {
  oracledb, init, close, query, exec, tryExec, tableCount, capabilities,
  getPool: () => pool,
};
