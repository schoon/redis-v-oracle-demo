'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const { createClient } = require('redis');
const { REDIS_URL, PORT, REDIS_INDEX, ORACLE_TABLE } = require('./config');
const {
  sanitize, redisQuery, redisSearchArgs, redisAggregateArgs, redisLeiKey,
  redisVectorArgs, hybridFilters,
  oracleSearchSql, oracleFacetSql, oracleLeiSql, oracleVectorSql,
} = require('./queries');
const oracle = require('./oracle');
// Not client.ft.info() — its positional parser is shifted against Redis 8's
// reply. See src/ft-info.js.
const { ftInfo, toCreateCommand } = require('./ft-info');
const { MODEL, vectorsAvailable, embedQuery, warmEmbedder } = require('./vectors');

// Financial centres offered by the geo scenario. Coordinates are [lat, lon];
// each engine's query builder reorders as needed.
const CENTRES = {
  london: { label: 'London', lat: 51.5072, lon: -0.1276 },
  'new-york': { label: 'New York', lat: 40.7128, lon: -74.006 },
  singapore: { label: 'Singapore', lat: 1.3521, lon: 103.8198 },
  frankfurt: { label: 'Frankfurt', lat: 50.1109, lon: 8.6821 },
  tokyo: { label: 'Tokyo', lat: 35.6762, lon: 139.6503 },
  zurich: { label: 'Zurich', lat: 47.3769, lon: 8.5417 },
};

const FACET_FIELDS = ['credit_rating', 'country', 'entity_type', 'sector', 'status'];

const app = express();
app.use(express.json());
// no-store across the demo. This is a single HTML file that gets edited while
// presenting, and a browser holding a cached copy is a real trap: a label fix
// landed on the server while the page on screen kept showing the old text,
// which read as "the fix didn't work". What's on screen being correct matters
// more here than saving a 60 KB re-fetch.
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, must-revalidate');
  next();
});
app.use(express.static(path.join(__dirname, '..', 'public'), {
  etag: false,
  lastModified: false,
}));

const redis = createClient({ url: REDIS_URL });
redis.on('error', (err) => console.error('Redis error:', err.message || err.code || err));

// Wall-clock timing in milliseconds, to microsecond resolution. Redis queries
// land well under a millisecond, so Date.now() would quantise them to 0 or 1.
function nowMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function runRedis(scenario, terms, filters, limit, order) {
  const { index, query, options } = redisSearchArgs(scenario, terms, filters, limit, order);
  const t0 = nowMs();
  // FT.SEARCH cp:idx <query> LIMIT 0 <limit> RETURN ...
  // Redis parses the query, walks the inverted index and returns matching
  // Hash fields in one round trip. No commit, no searcher reopen — whatever
  // has been written is already visible.
  const res = await redis.ft.search(index, query, options);
  const ms = nowMs() - t0;
  return { ms, total: res.total, docs: res.documents };
}

async function runOracle(scenario, terms, filters, limit, order) {
  const { sql, binds } = oracleSearchSql(scenario, terms, filters, limit, order);
  const t0 = nowMs();
  // One statement returns both the page of rows and the full match count via
  // count(*) over (), so Oracle pays one round trip like Redis does. Bind
  // variables throughout, so the statement cache reuses the plan.
  const rows = await oracle.query(sql, binds);
  const ms = nowMs() - t0;
  return {
    ms,
    total: rows.length ? Number(rows[0].TOTAL) : 0,
    docs: rows.map((r) => ({ id: r.LEI, value: r })),
    sql: sql.replace(/\s+/g, ' ').trim(),
  };
}

// ---- facets / aggregation -------------------------------------------------

async function runRedisFacet(field, limit) {
  const args = redisAggregateArgs(field, limit);
  const t0 = nowMs();
  // FT.AGGREGATE groups server-side in a single pass over the index.
  const reply = await redis.sendCommand(args);
  const ms = nowMs() - t0;

  // RESP2 shape: [numGroups, [k, v, k, v, ...], [k, v, ...], ...]
  const buckets = reply.slice(1).map((row) => {
    const obj = {};
    for (let i = 0; i < row.length; i += 2) obj[String(row[i])] = String(row[i + 1]);
    return {
      value: obj[field],
      count: Number(obj.cnt),
      exposure: Number(obj.exposure),
    };
  });
  return { ms, buckets, command: args.join(' ') };
}

async function runOracleFacet(field, limit) {
  const { sql, binds } = oracleFacetSql(field, limit);
  const t0 = nowMs();
  // Plain GROUP BY. No special index type, no aggregation pipeline — this is
  // the query SQL was built for, and the simplest statement in the demo.
  const rows = await oracle.query(sql, binds);
  const ms = nowMs() - t0;
  return {
    ms,
    buckets: rows.map((r) => ({
      value: r.VALUE, count: Number(r.CNT), exposure: Number(r.EXPOSURE),
    })),
    command: sql.replace(/\s+/g, ' ').trim(),
  };
}

// ---- exact LEI lookup ----------------------------------------------------

async function runRedisLei(lei) {
  const key = redisLeiKey(lei);
  const t0 = nowMs();
  // HGETALL cp:<LEI> — a direct key read. The search index is not involved at
  // all, which is the point of this scenario: for known-item retrieval Redis
  // doesn't need to search, it already knows where the record is. O(1).
  const hash = await redis.hGetAll(key);
  const ms = nowMs() - t0;
  const found = Object.keys(hash).length > 0;
  return { ms, found, doc: found ? hash : null, command: `HGETALL ${key}` };
}

async function runOracleLei(lei) {
  const { sql } = oracleLeiSql();
  const clean = String(lei).replace(/[^A-Z0-9]/gi, '').toUpperCase();
  const t0 = nowMs();
  // Primary-key lookup — the cheapest thing a relational database does.
  const rows = await oracle.query(sql, { lei: clean });
  const ms = nowMs() - t0;
  return {
    ms,
    found: rows.length > 0,
    doc: rows[0] || null,
    command: sql.replace(/\s+/g, ' ').trim(),
  };
}

// Redis returns lowercase Hash field names; Oracle returns uppercase column
// names. Both are normalised here so the UI renders one shape.
function normalise(docs) {
  return docs.map((d) => {
    const v = d.value || {};
    const pick = (a, b) => (v[a] !== undefined ? v[a] : v[b]);
    return {
      id: pick('id', 'LEI') ?? d.id,
      legal_name: pick('legal_name', 'LEGAL_NAME'),
      aliases: pick('aliases', 'ALIASES'),
      country: pick('country', 'COUNTRY'),
      entity_type: pick('entity_type', 'ENTITY_TYPE'),
      credit_rating: pick('credit_rating', 'CREDIT_RATING'),
      risk_score: Number(pick('risk_score', 'RISK_SCORE')),
      status: pick('status', 'STATUS'),
    };
  });
}

// GET /api/search
//   ?scenario=fuzzy|prefix|filtered
//   &q=<name>
//   &runs=<1-25>       how many times to run each engine (median is reported)
//   &countries=GB,US   filtered scenario only
//   &status=ACTIVE
//   &minRating=13
//   &maxRisk=80
app.get('/api/search', async (req, res) => {
  const scenario = ['fuzzy', 'prefix', 'filtered', 'geo'].includes(req.query.scenario)
    ? req.query.scenario
    : 'fuzzy';
  const terms = sanitize(req.query.q);
  const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);
  const runs = Math.min(Math.max(Number(req.query.runs) || 1, 1), 25);
  const order = req.query.order === 'relevance' ? 'relevance' : 'name';

  const num = (v) => (v === '' || v === undefined ? NaN : Number(v));
  const list = (v, re) => String(v || '').split(',').map((s) => s.trim()).filter((s) => re.test(s));

  const centre = CENTRES[req.query.centre] || CENTRES.london;
  const radiusKm = Math.min(Math.max(Number(req.query.radiusKm) || 50, 1), 5000);

  const filters = {
    countries: list(req.query.countries, /^[A-Z]{2}$/i).map((c) => c.toUpperCase()),
    status: /^[A-Z_]{3,12}$/.test(req.query.status || '') ? req.query.status : '',
    entityTypes: list(req.query.entityTypes, /^[A-Z_]{3,20}$/i).map((s) => s.toUpperCase()),
    // Sector names contain spaces, so only letters and spaces are allowed here.
    sectors: list(req.query.sectors, /^[A-Za-z ]{3,30}$/),
    minRating: num(req.query.minRating),
    maxRisk: num(req.query.maxRisk),
    minExposure: num(req.query.minExposure),
    // "onboarded in the last N months" becomes a lower bound on the epoch
    // timestamp — a plain numeric range on both engines, no date type needed.
    onboardedSince: Number.isFinite(num(req.query.onboardedMonths))
      ? Math.floor(Date.now() / 1000) - num(req.query.onboardedMonths) * 30 * 24 * 3600
      : NaN,
    geo: scenario === 'geo' ? { lat: centre.lat, lon: centre.lon, radiusKm } : null,
  };

  try {
    const redisTimes = [];
    const oracleTimes = [];
    let redisResult;
    let oracleResult;

    // Both engines run the same number of times, alternating which goes first
    // so neither systematically benefits from being second (warmer caches,
    // scheduler luck). The median of the runs is reported, not the best case.
    for (let i = 0; i < runs; i += 1) {
      if (i % 2 === 0) {
        redisResult = await runRedis(scenario, terms, filters, limit, order);
        oracleResult = await runOracle(scenario, terms, filters, limit, order);
      } else {
        oracleResult = await runOracle(scenario, terms, filters, limit, order);
        redisResult = await runRedis(scenario, terms, filters, limit, order);
      }
      redisTimes.push(redisResult.ms);
      oracleTimes.push(oracleResult.ms);
    }

    const redisMs = median(redisTimes);
    const oracleMs = median(oracleTimes);

    res.json({
      scenario,
      runs,
      order,
      terms,
      redis: {
        ms: Number(redisMs.toFixed(3)),
        total: redisResult.total,
        hits: normalise(redisResult.docs),
        query: redisQuery(scenario, terms, filters),
      },
      oracle: {
        ms: Number(oracleMs.toFixed(3)),
        total: oracleResult.total,
        hits: normalise(oracleResult.docs),
        query: oracleResult.sql,
      },
      // Only meaningful when both engines found the same number of documents —
      // the UI greys the multiplier out when the totals disagree, because a
      // speed comparison between two different questions is meaningless.
      speedup: oracleMs > 0 && redisMs > 0 ? Number((oracleMs / redisMs).toFixed(1)) : null,
      totalsMatch: redisResult.total === oracleResult.total,
      totalsDelta: Math.abs(redisResult.total - oracleResult.total),
      // Geo is the one scenario where an exact match isn't the right bar.
      // Redis GEO and Solr's LatLonPointSpatialField use different earth models
      // and coordinate quantisation, so a document sitting essentially on the
      // radius boundary can fall inside for one engine and outside for the
      // other. Rounding at the edge, not a disagreement about the question.
      //
      // 0.25% is measured, not guessed: across all 24 centre/radius pairs the
      // demo can pick, the largest divergence was 7 documents in 5,215 at
      // Frankfurt/200km, or 0.134%. 0.25% clears the observed worst case with
      // room to spare while still catching a genuine mismatch, which would be
      // orders of magnitude larger. The UI prints the actual document count and
      // percentage whenever this tolerance is what's carrying the comparison,
      // so the discrepancy is disclosed rather than absorbed. Every other
      // scenario stays on the strict equality check.
      totalsClose:
        Math.abs(redisResult.total - oracleResult.total) <=
        Math.max(1, Math.max(redisResult.total, oracleResult.total) * 0.0025),
    });
  } catch (err) {
    console.error('search failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/facet?field=credit_rating&runs=5
// Portfolio breakdown: count and total exposure per bucket.
app.get('/api/facet', async (req, res) => {
  const field = FACET_FIELDS.includes(req.query.field) ? req.query.field : 'credit_rating';
  const runs = Math.min(Math.max(Number(req.query.runs) || 1, 1), 25);
  const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 50);

  try {
    const rTimes = [];
    const sTimes = [];
    let r;
    let s;
    for (let i = 0; i < runs; i += 1) {
      if (i % 2 === 0) {
        r = await runRedisFacet(field, limit);
        s = await runOracleFacet(field, limit);
      } else {
        s = await runOracleFacet(field, limit);
        r = await runRedisFacet(field, limit);
      }
      rTimes.push(r.ms);
      sTimes.push(s.ms);
    }
    const rMs = median(rTimes);
    const sMs = median(sTimes);

    // Buckets are compared, not just timed: if the two engines disagree on a
    // count or a sum, the numbers on screen are not describing the same thing.
    //
    // Compared case-insensitively on purpose. A SORTABLE TAG field in Redis
    // keeps a normalised (lowercased) copy, and that is what GROUPBY returns —
    // "a+" where Solr says "A+". The grouping is identical; only the label
    // casing differs, so the labels are shown as each engine returns them
    // rather than being quietly rewritten. Grouping on the original casing
    // needs LOAD, which costs roughly 3x — noted in the README.
    const key = (v) => String(v).toLowerCase();
    const byValue = new Map(s.buckets.map((b) => [key(b.value), b]));
    const bucketsAgree =
      r.buckets.length === s.buckets.length &&
      r.buckets.every((b) => {
        const o = byValue.get(key(b.value));
        return o && o.count === b.count && Math.abs(o.exposure - b.exposure) < 1;
      });

    res.json({
      field,
      runs,
      redis: { ms: Number(rMs.toFixed(3)), buckets: r.buckets, query: r.command },
      oracle: { ms: Number(sMs.toFixed(3)), buckets: s.buckets, query: s.command },
      speedup: rMs > 0 && sMs > 0 ? Number((sMs / rMs).toFixed(1)) : null,
      bucketsAgree,
    });
  } catch (err) {
    console.error('facet failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/lei?lei=<20 chars>&runs=5
app.get('/api/lei', async (req, res) => {
  const lei = String(req.query.lei || '');
  const runs = Math.min(Math.max(Number(req.query.runs) || 1, 1), 25);

  try {
    const rTimes = [];
    const sTimes = [];
    let r;
    let s;
    for (let i = 0; i < runs; i += 1) {
      if (i % 2 === 0) {
        r = await runRedisLei(lei);
        s = await runOracleLei(lei);
      } else {
        s = await runOracleLei(lei);
        r = await runRedisLei(lei);
      }
      rTimes.push(r.ms);
      sTimes.push(s.ms);
    }
    const rMs = median(rTimes);
    const sMs = median(sTimes);

    res.json({
      lei,
      runs,
      redis: {
        ms: Number(rMs.toFixed(3)),
        found: r.found,
        name: r.doc?.legal_name || null,
        query: r.command,
      },
      oracle: {
        ms: Number(sMs.toFixed(3)),
        found: s.found,
        name: s.doc?.LEGAL_NAME || null,
        query: s.command,
      },
      speedup: rMs > 0 && sMs > 0 ? Number((sMs / rMs).toFixed(1)) : null,
      agree: r.found === s.found && (r.doc?.legal_name || null) === (s.doc?.LEGAL_NAME || null),
    });
  } catch (err) {
    console.error('lei failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sample-lei — a real identifier from the corpus, so the LEI scenario
// has something valid to look up without the presenter copying one by hand.
app.get('/api/sample-lei', async (req, res) => {
  try {
    const r = await redis.ft.search(REDIS_INDEX, '*', { LIMIT: { from: Math.floor(Math.random() * 1000), size: 1 }, RETURN: ['id', 'legal_name'] });
    const doc = r.documents[0];
    res.json({ lei: doc?.value?.id || null, legal_name: doc?.value?.legal_name || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/semantic?q=<english question>&mode=vector|hybrid&runs=N
//   plus the usual filters when mode=hybrid, and &keyword= for a term the
//   narrative text must also contain.
//
// The question is embedded once, then the same vector goes to both engines, so
// neither is charged for the embedding and neither gets a different query.
app.get('/api/semantic', async (req, res) => {
  if (!vectorsAvailable()) {
    return res.status(404).json({ error: 'no embeddings — run: npm run seed:vectors' });
  }

  const question = String(req.query.q || '').slice(0, 400);
  if (!question.trim()) return res.status(400).json({ error: 'q is required' });

  const mode = req.query.mode === 'hybrid' ? 'hybrid' : 'vector';
  const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);
  const runs = Math.min(Math.max(Number(req.query.runs) || 1, 1), 25);
  const num = (v) => (v === '' || v === undefined ? NaN : Number(v));

  const filters = mode === 'hybrid' ? {
    countries: String(req.query.countries || '').split(',')
      .map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c)),
    status: /^[A-Z_]{3,12}$/.test(req.query.status || '') ? req.query.status : '',
    minRating: num(req.query.minRating),
    maxRisk: num(req.query.maxRisk),
    // Same sanitising as the lexical scenarios: letters, digits and spaces.
    keyword: String(req.query.keyword || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim(),
  } : {};

  try {
    // Embedded once, outside the timed section. The embedding cost is real but
    // it's identical for both engines, so including it would just add a
    // constant to each and muddy the comparison. It's reported separately.
    const embedStart = nowMs();
    const vector = await embedQuery(question);
    const embedMs = nowMs() - embedStart;
    const buf = Buffer.from(new Float32Array(vector).buffer);

    const built = hybridFilters(filters);
    const redisFilter = mode === 'hybrid' ? built.redis : '*';
    const oracleWhere = mode === 'hybrid' ? built.oracleWhere : '';
    const oracleBinds = mode === 'hybrid' ? built.oracleBinds : {};

    const rTimes = [];
    const sTimes = [];
    let rRes;
    let sRes;

    for (let i = 0; i < runs; i += 1) {
      const doRedis = async () => {
        const args = redisVectorArgs(buf, limit, redisFilter);
        const t0 = nowMs();
        const reply = await redis.sendCommand(args);
        const ms = nowMs() - t0;
        // RESP2: [total, key, [f, v, ...], key, [f, v, ...], ...]
        const docs = [];
        for (let j = 1; j < reply.length; j += 2) {
          const fields = {};
          const arr = reply[j + 1] || [];
          for (let k = 0; k < arr.length; k += 2) fields[String(arr[k])] = String(arr[k + 1]);
          docs.push(fields);
        }
        return { ms, total: Number(reply[0]), docs };
      };
      const doOracle = async () => {
        const { sql, binds } = oracleVectorSql(limit, oracleWhere, oracleBinds);
        const t0 = nowMs();
        // The query vector binds as a VECTOR. FETCH APPROX FIRST is what lets
        // Oracle use the vector index instead of scoring every row.
        const rows = await oracle.query(sql, {
          ...binds,
          qv: { val: new Float32Array(vector), type: oracle.oracledb.DB_TYPE_VECTOR },
        });
        const ms = nowMs() - t0;
        return { ms, total: rows.length, docs: rows, sql: sql.replace(/\s+/g, ' ').trim() };
      };

      if (i % 2 === 0) { rRes = await doRedis(); sRes = await doOracle(); } else { sRes = await doOracle(); rRes = await doRedis(); }
      rTimes.push(rRes.ms);
      sTimes.push(sRes.ms);
    }

    const redisMs = median(rTimes);
    const oracleMs = median(sTimes);

    // Redis COSINE returns a distance (0 = identical); Solr returns cosine
    // similarity. Both are normalised to similarity here so the two panes are
    // reading the same scale.
    const redisHits = rRes.docs.map((d) => ({
      id: d.id,
      legal_name: d.legal_name,
      country: d.country,
      credit_rating: d.credit_rating,
      risk_score: Number(d.risk_score),
      status: d.status,
      profile: d.profile,
      similarity: Number((1 - Number(d.vscore)).toFixed(4)),
    }));
    const oracleHits = sRes.docs.map((d) => ({
      id: d.LEI,
      legal_name: d.LEGAL_NAME,
      country: d.COUNTRY,
      credit_rating: d.CREDIT_RATING,
      risk_score: Number(d.RISK_SCORE),
      status: d.STATUS,
      profile: d.PROFILE,
      // Oracle returns a cosine DISTANCE from VECTOR_DISTANCE, same convention
      // as Redis, so both become similarity the same way. No Lucene-style
      // (1+cos)/2 rescaling to undo here.
      similarity: Number((1 - Number(d.DIST)).toFixed(4)),
    }));

    const overlap = redisHits.filter((h) => oracleHits.some((s) => s.id === h.id)).length;

    res.json({
      question,
      mode,
      runs,
      embedMs: Number(embedMs.toFixed(1)),
      model: MODEL,
      redis: {
        ms: Number(redisMs.toFixed(3)),
        total: rRes.total,
        hits: redisHits,
        query: `${redisFilter}=>[KNN ${limit} @vector $BLOB AS vscore]  DIALECT 2`,
      },
      oracle: {
        ms: Number(oracleMs.toFixed(3)),
        total: sRes.total,
        hits: oracleHits,
        query: sRes.sql,
      },
      // Both engines run HNSW, which is approximate — identical result sets
      // aren't guaranteed even on identical vectors. Overlap is reported
      // instead of demanding an exact match.
      overlap,
      limit,
    });
  } catch (err) {
    console.error('semantic failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/index-info — what actually got built on each side.
//
// Shows the Redis index definition and its cost next to the Solr schema. It's
// also the clearest view of the setup difference: one FT.CREATE against a core
// plus a schema declaration per field.
app.get('/api/index-info', async (req, res) => {
  try {
    const info = await ftInfo(redis, REDIS_INDEX);

    // Oracle's equivalent of "what got built": the columns and the indexes
    // behind them. Redis needs one FT.CREATE; Oracle needs a CREATE TABLE plus
    // an index per access path, and a metadata row before the spatial one.
    const cols = await oracle.query(`
      select column_name, data_type, data_length, data_precision, data_scale
        from user_tab_columns where table_name = upper(:t) order by column_id`,
      { t: ORACLE_TABLE });
    const idx = await oracle.query(`
      select i.index_name, i.index_type, i.uniqueness, i.ityp_name,
             listagg(c.column_name, ', ') within group (order by c.column_position) as cols
        from user_indexes i
        left join user_ind_columns c on c.index_name = i.index_name
       where i.table_name = upper(:t)
       group by i.index_name, i.index_type, i.uniqueness, i.ityp_name
       order by i.index_name`,
      { t: ORACLE_TABLE });
    const rowCount = await oracle.tableCount();
    const caps = await oracle.capabilities();

    const oracleFields = cols.map((c) => {
      const t = c.DATA_TYPE;
      const size = c.DATA_PRECISION
        ? `(${c.DATA_PRECISION}${c.DATA_SCALE ? `,${c.DATA_SCALE}` : ''})`
        : (t === 'VARCHAR2' ? `(${c.DATA_LENGTH})` : '');
      const on = idx.filter((i) => (i.COLS || '').split(', ').includes(c.COLUMN_NAME));
      return {
        field: c.COLUMN_NAME.toLowerCase(),
        type: `${t}${size}`,
        options: on.map((i) => (i.ITYP_NAME ? i.ITYP_NAME.toLowerCase() : i.INDEX_TYPE.toLowerCase())),
      };
    });

    res.json({
      redis: {
        indexName: info.indexName,
        keyType: info.keyType,
        prefixes: info.prefixes,
        fields: info.attributes,
        createCommand: toCreateCommand(info),
        stats: info.stats,
      },
      oracle: {
        core: ORACLE_TABLE,
        fields: oracleFields,
        docs: rowCount,
        indexes: idx.map((i) => ({
          name: i.INDEX_NAME.toLowerCase(),
          kind: i.ITYP_NAME ? i.ITYP_NAME.toLowerCase() : i.INDEX_TYPE.toLowerCase(),
          cols: (i.COLS || '').toLowerCase(),
        })),
        capabilities: caps,
        // There is no single statement that reproduces this side.
        setup: `CREATE TABLE + ${idx.length} indexes`
          + (caps.spatial ? ' + USER_SDO_GEOM_METADATA row' : '')
          + ' + DBMS_STATS.GATHER_TABLE_STATS',
      },
    });
  } catch (err) {
    console.error('index-info failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/bench-results — the last `npm run bench` run.
//
// Read from a file rather than generated on demand: driving a load test from
// inside this process would have the load generator competing with the server
// being measured. See src/bench.js.
app.get('/api/bench-results', (req, res) => {
  const file = path.join(__dirname, '..', 'data', 'bench-results.json');
  try {
    if (!fs.existsSync(file)) {
      return res.status(404).json({ error: 'no benchmark results yet — run: npm run bench' });
    }
    res.json(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/meta — filter vocabularies and geo centres, so the UI doesn't
// hardcode lists that could drift from the data.
app.get('/api/meta', (req, res) => {
  res.json({
    centres: Object.entries(CENTRES).map(([k, v]) => ({ key: k, label: v.label })),
    facetFields: FACET_FIELDS,
  });
});

// GET /api/stats — corpus size on both sides, so the UI can prove they match.
app.get('/api/stats', async (req, res) => {
  try {
    const info = await ftInfo(redis, REDIS_INDEX);
    const oracleRows = await oracle.tableCount();
    res.json({
      redis: {
        docs: info.stats.numDocs,
        indexName: REDIS_INDEX,
        // Reported so nobody has to take "Redis has no commit lag" on trust.
        indexing: info.stats.indexing,
      },
      oracle: {
        docs: oracleRows,
        core: ORACLE_TABLE,
      },
    });
  } catch (err) {
    console.error('stats failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

async function start() {
  await redis.connect();
  console.log(`Connected to Redis at ${REDIS_URL}`);

  // Fail early with a clear message rather than serving a broken demo.
  const info = await ftInfo(redis, REDIS_INDEX).catch(() => null);
  if (!info) {
    throw new Error(`index ${REDIS_INDEX} not found — run: npm run seed`);
  }
  await oracle.init();
  const caps = await oracle.capabilities();
  const oracleRows = await oracle.tableCount().catch(() => {
    throw new Error(`table ${ORACLE_TABLE} not found — run: npm run seed`);
  });
  console.log(`Connected to Oracle (thin mode) · Text ${caps.text ? 'yes' : 'NO'}`
    + ` · Spatial ${caps.spatial ? 'yes' : 'NO'} · Vector ${caps.vector ? 'yes' : 'NO'}`);

  console.log(`Redis index ${REDIS_INDEX}: ${info.stats.numDocs.toLocaleString()} docs`);
  console.log(`Oracle table ${ORACLE_TABLE}: ${oracleRows.toLocaleString()} rows`);
  if (info.stats.numDocs !== oracleRows) {
    console.warn('WARNING: document counts differ — re-run `npm run seed` for a fair comparison');
  }

  if (vectorsAvailable()) {
    process.stdout.write('Warming the embedding model...');
    await warmEmbedder();
    console.log(` ready (${MODEL})`);
  } else {
    console.log('No embeddings — the Semantic tab will ask for `npm run seed:vectors`');
  }

  const server = app.listen(PORT, () => {
    console.log(`\nDemo running at http://localhost:${PORT}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is in use. Try: PORT=${Number(PORT) + 1} npm start`);
    } else {
      console.error(`Could not listen on ${PORT}: ${err.message || err.code || err}`);
    }
    process.exit(1);
  });
}

start().catch((err) => {
  console.error('Failed to start:', err.message || err.code || err);
  process.exit(1);
});
