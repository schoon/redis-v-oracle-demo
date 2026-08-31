'use strict';

// Loads the same generated counterparties into Oracle and builds the indexes an
// Oracle DBA would actually build for this workload.
//
// Fairness matters more here than anywhere else in the demo. Oracle gets:
//   - bitmap indexes on the low-cardinality screening columns, which is the
//     right Oracle choice for read-heavy filtering, not B-trees
//   - B-tree indexes on the numeric range columns
//   - a real Oracle Text CONTEXT index for name search, with SYNC (ON COMMIT)
//     so new rows are searchable at commit rather than at a manual sync
//   - a proper spatial index, including the USER_SDO_GEOM_METADATA row Oracle
//     requires before one can be created
//   - a vector index for semantic search
//   - a statement cache and bind variables throughout, so nothing pays a hard
//     parse per query
//   - statistics gathered before any timing is taken, so the optimiser has what
//     it needs to pick a sane plan
//
// A hobbled Oracle would make the demo useless: the first thing a customer's
// DBA does is read this file.

const fs = require('fs');
const readline = require('readline');
const { DATA_FILE, ORACLE_TABLE } = require('./config');
const oracle = require('./oracle');
const { DIM, vectorsAvailable, loadVectors, readMeta } = require('./vectors');

const BATCH = 5000;

async function dropAll() {
  // Text and spatial indexes have to go before the table, and the metadata row
  // has to go too or recreating the spatial index later fails.
  await oracle.tryExec(`drop index ${ORACLE_TABLE}_txt_ix`);
  await oracle.tryExec(`drop index ${ORACLE_TABLE}_geo_ix`);
  await oracle.tryExec(`drop index ${ORACLE_TABLE}_vec_ix`);
  await oracle.tryExec(`drop table ${ORACLE_TABLE} purge`);
  await oracle.tryExec(`delete from user_sdo_geom_metadata where table_name = upper('${ORACLE_TABLE}')`);
}

async function createTable(hasVectors) {
  await oracle.exec(`
    create table ${ORACLE_TABLE} (
      lei            varchar2(20)  not null,
      legal_name     varchar2(200) not null,
      aliases        varchar2(400),
      parent_name    varchar2(200),
      city           varchar2(60),
      country        varchar2(2),
      jurisdiction   varchar2(2),
      entity_type    varchar2(24),
      sector         varchar2(30),
      credit_rating  varchar2(4),
      rating_score   number(3),
      risk_score     number(5,1),
      exposure_usd   number(15),
      status         varchar2(12),
      onboarded_at   number(12),
      lat            number(9,5),
      lon            number(9,5),
      geo            sdo_geometry,
      -- legal_name and aliases concatenated. Oracle Text indexes a column, not
      -- a set of columns, so searching both at once means either one CONTEXT
      -- index over a combined column or a MULTI_COLUMN_DATASTORE. The combined
      -- column is the simpler equivalent of Redis's "@legal_name|aliases".
      search_text    varchar2(620),
      profile        varchar2(1400)
      ${hasVectors ? `, embedding vector(${DIM}, float32)` : ''},
      constraint ${ORACLE_TABLE}_pk primary key (lei)
    )
  `);
}

async function createIndexes(caps, hasVectors) {
  const t = ORACLE_TABLE;
  const started = Date.now();

  // Bitmap indexes on the low-cardinality screening columns. This is what an
  // Oracle DBA would choose for read-heavy filtering on columns with a handful
  // of distinct values — a B-tree here would be the weaker choice, and using
  // one would be quietly stacking the comparison.
  for (const col of ['country', 'status', 'entity_type', 'sector', 'credit_rating']) {
    await oracle.exec(`create bitmap index ${t}_${col}_ix on ${t} (${col})`);
  }
  // B-trees for the numeric ranges.
  for (const col of ['rating_score', 'risk_score', 'exposure_usd', 'onboarded_at']) {
    await oracle.exec(`create index ${t}_${col}_ix on ${t} (${col})`);
  }
  // Function-based index so a case-insensitive prefix scan can use an index
  // rather than a full table scan.
  await oracle.exec(`create index ${t}_lname_ix on ${t} (lower(legal_name))`);
  console.log(`  relational indexes: ${((Date.now() - started) / 1000).toFixed(1)}s`);

  if (caps.text) {
    const t0 = Date.now();
    // SYNC (ON COMMIT) is the important part. By default a CONTEXT index is
    // only updated when someone calls CTX_DDL.SYNC_INDEX, which means a newly
    // inserted counterparty is invisible to CONTAINS until that happens. ON
    // COMMIT makes it as fresh as Oracle can be, which is the fair setting —
    // and the write-to-visible scenario measures what it still costs.
    await oracle.exec(`
      create index ${t}_txt_ix on ${t} (search_text)
      indextype is ctxsys.context
      parameters ('sync (on commit)')
    `);
    console.log(`  Oracle Text CONTEXT index: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  if (caps.spatial) {
    const t0 = Date.now();
    // Oracle refuses to create a spatial index without a metadata row
    // describing the dimensions and SRID. There is no equivalent step in Redis,
    // where GEO is just a field type.
    await oracle.exec(`
      insert into user_sdo_geom_metadata (table_name, column_name, diminfo, srid)
      values ('${t.toUpperCase()}', 'GEO',
        sdo_dim_array(
          sdo_dim_element('Longitude', -180, 180, 0.5),
          sdo_dim_element('Latitude',   -90,  90, 0.5)
        ), 4326)
    `);
    await oracle.exec(`create index ${t}_geo_ix on ${t} (geo) indextype is mdsys.spatial_index_v2`);
    console.log(`  spatial index: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  if (hasVectors && caps.vector) {
    const t0 = Date.now();
    // HNSW is the like-for-like match to Redis, but it lives in a preallocated
    // vector memory pool — if that pool isn't sized, index creation fails with
    // ORA-51962. Fall back to IVF (neighbor partitions), which needs no pool.
    // Redis requires no equivalent configuration either way.
    let built = 'none';
    if (await oracle.tryExec(
      `create vector index ${t}_vec_ix on ${t} (embedding)
       organization inmemory neighbor graph distance COSINE`
    )) {
      built = 'HNSW (in-memory neighbor graph)';
    } else if (await oracle.tryExec(
      `create vector index ${t}_vec_ix on ${t} (embedding)
       organization neighbor partitions distance COSINE`
    )) {
      built = 'IVF (neighbor partitions) — HNSW needs vector_memory_size set';
    }
    console.log(`  vector index: ${built} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
}

async function main() {
  await oracle.init({ min: 1, max: 4 });
  console.log('Connected to Oracle (thin mode)');

  const caps = await oracle.capabilities();
  console.log(`  Oracle Text: ${caps.text ? 'yes' : 'NO'} · Spatial: ${caps.spatial ? 'yes' : 'NO'} · Vector: ${caps.vector ? 'yes' : 'NO'}`);
  if (!caps.text || !caps.spatial) {
    console.log('  (a "slim" Oracle image strips these — see the README)');
  }

  const hasVectors = vectorsAvailable();
  let allVectors = null;
  if (hasVectors) {
    const meta = readMeta();
    allVectors = loadVectors();
    console.log(`  vectors found: ${meta.count.toLocaleString()} × ${meta.dim}d (${meta.model})`);
  } else {
    console.log('  no vectors — run `npm run seed:vectors` to enable the semantic tab');
  }

  await dropAll();
  await createTable(hasVectors);
  console.log(`Created table ${ORACLE_TABLE}`);

  const loadStarted = Date.now();
  let count = 0;
  let rows = [];
  let insertMs = 0;

  const cols = ['lei', 'legal_name', 'aliases', 'parent_name', 'city', 'country',
    'jurisdiction', 'entity_type', 'sector', 'credit_rating', 'rating_score',
    'risk_score', 'exposure_usd', 'status', 'onboarded_at', 'lat', 'lon',
    'search_text', 'profile'];

  const sql = `
    insert into ${ORACLE_TABLE} (${cols.join(', ')}, geo${hasVectors ? ', embedding' : ''})
    values (${cols.map((c) => `:${c}`).join(', ')},
      sdo_geometry(2001, 4326, sdo_point_type(:lon2, :lat2, null), null, null)
      ${hasVectors ? ', :embedding' : ''})
  `;

  const bindDefs = {
    lei: { type: oracle.oracledb.STRING, maxSize: 20 },
    legal_name: { type: oracle.oracledb.STRING, maxSize: 200 },
    aliases: { type: oracle.oracledb.STRING, maxSize: 400 },
    parent_name: { type: oracle.oracledb.STRING, maxSize: 200 },
    city: { type: oracle.oracledb.STRING, maxSize: 60 },
    country: { type: oracle.oracledb.STRING, maxSize: 2 },
    jurisdiction: { type: oracle.oracledb.STRING, maxSize: 2 },
    entity_type: { type: oracle.oracledb.STRING, maxSize: 24 },
    sector: { type: oracle.oracledb.STRING, maxSize: 30 },
    credit_rating: { type: oracle.oracledb.STRING, maxSize: 4 },
    rating_score: { type: oracle.oracledb.NUMBER },
    risk_score: { type: oracle.oracledb.NUMBER },
    exposure_usd: { type: oracle.oracledb.NUMBER },
    status: { type: oracle.oracledb.STRING, maxSize: 12 },
    onboarded_at: { type: oracle.oracledb.NUMBER },
    lat: { type: oracle.oracledb.NUMBER },
    lon: { type: oracle.oracledb.NUMBER },
    search_text: { type: oracle.oracledb.STRING, maxSize: 620 },
    profile: { type: oracle.oracledb.STRING, maxSize: 1400 },
    lat2: { type: oracle.oracledb.NUMBER },
    lon2: { type: oracle.oracledb.NUMBER },
    ...(hasVectors ? { embedding: { type: oracle.oracledb.DB_TYPE_VECTOR } } : {}),
  };

  const flush = async () => {
    const conn = await oracle.getPool().getConnection();
    try {
      const t0 = Date.now();
      // executeMany is the bulk path — one round trip per batch with array
      // binds, rather than 5,000 individual statements.
      await conn.executeMany(sql, rows, { autoCommit: true, bindDefs });
      insertMs += Date.now() - t0;
    } finally {
      await conn.close();
    }
    rows = [];
  };

  const stream = readline.createInterface({
    input: fs.createReadStream(DATA_FILE),
    crlfDelay: Infinity,
  });

  for await (const line of stream) {
    if (!line) continue;
    const rec = JSON.parse(line);
    rows.push({
      lei: rec.id,
      legal_name: rec.legal_name,
      aliases: rec.aliases,
      parent_name: rec.parent_name || null,
      city: rec.city,
      country: rec.country,
      jurisdiction: rec.jurisdiction,
      entity_type: rec.entity_type,
      sector: rec.sector,
      credit_rating: rec.credit_rating,
      rating_score: rec.rating_score,
      risk_score: rec.risk_score,
      exposure_usd: rec.exposure_usd,
      status: rec.status,
      onboarded_at: rec.onboarded_at,
      lat: rec.lat,
      lon: rec.lon,
      search_text: `${rec.legal_name} ${rec.aliases}`.slice(0, 620),
      profile: (rec.profile || '').slice(0, 1400),
      lat2: rec.lat,
      lon2: rec.lon,
      ...(hasVectors ? {
        embedding: new Float32Array(allVectors.subarray(count * DIM, (count + 1) * DIM)),
      } : {}),
    });

    count += 1;
    if (rows.length >= BATCH) {
      await flush();
      if (count % 20000 === 0) console.log(`  ${count.toLocaleString()} inserted...`);
    }
  }
  if (rows.length) await flush();

  const loadMs = Date.now() - loadStarted;
  console.log(`\nInserted ${count.toLocaleString()} rows in ${loadMs} ms`);
  console.log(`  insert time: ${insertMs} ms`);
  console.log(`  rate:        ${Math.round(count / (loadMs / 1000)).toLocaleString()} rows/sec`);

  console.log('\nBuilding indexes...');
  await createIndexes(caps, hasVectors);

  // The optimiser needs statistics to choose a plan. Skipping this would leave
  // Oracle guessing and produce times that say more about missing stats than
  // about Oracle.
  const statsStart = Date.now();
  await oracle.exec(`
    begin
      dbms_stats.gather_table_stats(user, '${ORACLE_TABLE.toUpperCase()}',
        method_opt => 'for all columns size auto', cascade => true);
    end;
  `);
  console.log(`  statistics gathered: ${((Date.now() - statsStart) / 1000).toFixed(1)}s`);

  const total = await oracle.tableCount();
  console.log(`\n  rows in table: ${total.toLocaleString()}`);
  if (total !== count) {
    console.error(`  MISMATCH: inserted ${count} but table holds ${total}`);
    process.exitCode = 1;
  }

  // Warm-up. Oracle's buffer cache and the optimiser's cursor cache both matter
  // on first execution, and timing a cold Oracle against a warm Redis would be
  // a cheap trick.
  console.log('\nWarming Oracle (buffer cache, cursor cache)...');
  const warm = [
    `select count(*) as n from ${ORACLE_TABLE} where country in ('GB','US')`,
    `select count(*) as n from ${ORACLE_TABLE} where lower(legal_name) like 'kes%'`,
    ...(caps.text ? [`select count(*) as n from ${ORACLE_TABLE} where contains(search_text, 'kes%', 1) > 0`] : []),
    ...(caps.spatial ? [`select count(*) as n from ${ORACLE_TABLE} where sdo_within_distance(geo, sdo_geometry(2001,4326,sdo_point_type(-0.1276,51.5072,null),null,null), 'distance=50 unit=km') = 'TRUE'`] : []),
    `select credit_rating, count(*) as n from ${ORACLE_TABLE} group by credit_rating`,
  ];
  for (let pass = 0; pass < 3; pass += 1) {
    for (const q of warm) await oracle.query(q);
  }
  console.log('Warm-up complete');

  await oracle.close();
}

main().catch(async (err) => {
  console.error('Seeding Oracle failed:', err.message);
  await oracle.close().catch(() => {});
  process.exit(1);
});
