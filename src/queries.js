'use strict';

// Query construction for both engines, kept side by side in one file so the two
// are easy to compare — and so it's obvious neither is being handed an easier
// question than the other.
//
// This is the file the demo is really about. Redis expresses each scenario as a
// single index query; Oracle expresses it as SQL over a table with the right
// index behind it. Both are shown on screen.
//
//   scenario    Redis                          Oracle
//   ---------   ----------------------------   --------------------------------
//   fuzzy       @f:(%term%)                    CONTAINS(.., 'fuzzy(term,60,10,weight)')
//   prefix      @f:(term*)                     CONTAINS(.., 'term%')
//   filtered    TAG / NUMERIC clauses          WHERE .. IN / >= (bitmap + B-tree)
//   geo         @location:[lon lat r km]       SDO_WITHIN_DISTANCE(..)
//   breakdown   FT.AGGREGATE GROUPBY REDUCE    SELECT .. GROUP BY  (SQL's home turf)
//   lei         HGETALL cp:<lei>               SELECT .. WHERE lei = :lei  (PK)
//   semantic    KNN on a VECTOR field          ORDER BY VECTOR_DISTANCE .. FETCH APPROX

const { REDIS_INDEX, ORACLE_TABLE } = require('./config');
const { solrFloats } = require('./vectors');

// User input reaches two different query languages. Rather than escape for
// each, reduce it to letters, digits and spaces — enough for counterparty names
// and impossible to inject through. Oracle also gets bind variables on top.
function sanitize(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8);
}

// ---------------------------------------------------------------- Redis

function redisQuery(scenario, terms, filters) {
  let namePart;

  if (terms.length === 0) {
    namePart = '*';
  } else if (scenario === 'fuzzy') {
    // %term% is Levenshtein distance 1. Terms of 1-2 characters are left exact:
    // fuzzing them matches almost everything and tells you nothing.
    namePart = `@legal_name|aliases:(${terms.map((t) => (t.length > 2 ? `%${t}%` : t)).join(' ')})`;
  } else {
    const head = terms.slice(0, -1);
    const last = terms[terms.length - 1];
    namePart = `@legal_name|aliases:(${[...head, `${last}*`].join(' ')})`;
  }

  // '*' means "everything" and cannot be combined with other clauses.
  const clauses = namePart === '*' ? [] : [namePart];

  if (scenario === 'filtered' || scenario === 'geo') {
    if (filters.countries?.length) clauses.push(`@country:{${filters.countries.join('|')}}`);
    if (filters.status) clauses.push(`@status:{${filters.status}}`);
    if (filters.entityTypes?.length) clauses.push(`@entity_type:{${filters.entityTypes.join('|')}}`);
    if (filters.sectors?.length) clauses.push(`@sector:{${filters.sectors.map(escapeTag).join('|')}}`);
    if (Number.isFinite(filters.minRating)) clauses.push(`@rating_score:[${filters.minRating} +inf]`);
    if (Number.isFinite(filters.maxRisk)) clauses.push(`@risk_score:[-inf ${filters.maxRisk}]`);
    if (Number.isFinite(filters.minExposure)) clauses.push(`@exposure_usd:[${filters.minExposure} +inf]`);
    if (Number.isFinite(filters.onboardedSince)) clauses.push(`@onboarded_at:[${filters.onboardedSince} +inf]`);
  }

  if (scenario === 'geo' && filters.geo) {
    const { lon, lat, radiusKm } = filters.geo;
    clauses.push(`@location:[${lon} ${lat} ${radiusKm} km]`);
  }

  return clauses.length ? clauses.join(' ') : '*';
}

function escapeTag(value) {
  return String(value).replace(/([ \-.,{}|])/g, '\\$1');
}

const REDIS_RETURN = [
  'id', 'legal_name', 'aliases', 'country', 'entity_type',
  'credit_rating', 'rating_score', 'risk_score', 'status',
];

function redisSearchArgs(scenario, terms, filters, limit, order = 'name') {
  const options = { LIMIT: { from: 0, size: limit }, RETURN: REDIS_RETURN };
  if (order === 'name') options.SORTBY = { BY: 'legal_name', DIRECTION: 'ASC' };
  return { index: REDIS_INDEX, query: redisQuery(scenario, terms, filters), options };
}

// Redis aggregation. Returned as raw command arguments so the exact command is
// displayable — this is the scenario where the two models differ most, and it's
// worth showing FT.AGGREGATE's pipeline next to a plain GROUP BY.
function redisAggregateArgs(field, limit = 25) {
  return [
    'FT.AGGREGATE', REDIS_INDEX, '*',
    'GROUPBY', '1', `@${field}`,
    'REDUCE', 'COUNT', '0', 'AS', 'cnt',
    'REDUCE', 'SUM', '1', '@exposure_usd', 'AS', 'exposure',
    'SORTBY', '2', '@cnt', 'DESC',
    'LIMIT', '0', String(limit),
  ];
}

// ---------------------------------------------------------------- Oracle

const ORACLE_COLS = `lei, legal_name, aliases, country, entity_type,
  credit_rating, rating_score, risk_score, status`;

// Oracle Text query expression for the name search.
//
//   fuzzy:  fuzzy(kestral, 60, 10, weight)
//           similarity 60 of 80, up to 10 expansions, score-weighted — the
//           closest Oracle Text gets to Redis's single-edit %term%.
//   prefix: kes%
//
// Terms are ANDed, matching Redis's default intersection of multiple terms.
function oracleTextExpr(scenario, terms) {
  if (terms.length === 0) return null;
  if (scenario === 'fuzzy') {
    return terms
      .map((t) => (t.length > 2 ? `fuzzy(${t}, 60, 10, weight)` : t))
      .join(' and ');
  }
  const head = terms.slice(0, -1);
  const last = terms[terms.length - 1];
  return [...head, `${last}%`].join(' and ');
}

// Builds the SQL and its binds for the search scenarios.
//
// `count(*) over ()` gives the full match count in the SAME statement as the
// page of rows, so Oracle pays one round trip like Redis does rather than two.
// Worth understanding what it costs: Redis gets the total from the index walk it
// is already doing, while Oracle has to evaluate the whole result set to count
// it. That difference is part of what the timings show.
function oracleSearchSql(scenario, terms, filters, limit, order = 'name') {
  const where = [];
  const binds = { lim: limit };

  const textExpr = oracleTextExpr(scenario, terms);
  if (textExpr) {
    where.push('contains(search_text, :textq, 1) > 0');
    binds.textq = textExpr;
  }

  if (scenario === 'filtered' || scenario === 'geo') {
    if (filters.countries?.length) {
      const ks = filters.countries.map((c, i) => {
        binds[`c${i}`] = c;
        return `:c${i}`;
      });
      where.push(`country in (${ks.join(', ')})`);
    }
    if (filters.status) {
      where.push('status = :status');
      binds.status = filters.status;
    }
    if (filters.entityTypes?.length) {
      const ks = filters.entityTypes.map((v, i) => {
        binds[`et${i}`] = v;
        return `:et${i}`;
      });
      where.push(`entity_type in (${ks.join(', ')})`);
    }
    if (filters.sectors?.length) {
      const ks = filters.sectors.map((v, i) => {
        binds[`sc${i}`] = v;
        return `:sc${i}`;
      });
      where.push(`sector in (${ks.join(', ')})`);
    }
    if (Number.isFinite(filters.minRating)) {
      where.push('rating_score >= :minRating');
      binds.minRating = filters.minRating;
    }
    if (Number.isFinite(filters.maxRisk)) {
      where.push('risk_score <= :maxRisk');
      binds.maxRisk = filters.maxRisk;
    }
    if (Number.isFinite(filters.minExposure)) {
      where.push('exposure_usd >= :minExposure');
      binds.minExposure = filters.minExposure;
    }
    if (Number.isFinite(filters.onboardedSince)) {
      where.push('onboarded_at >= :onboardedSince');
      binds.onboardedSince = filters.onboardedSince;
    }
  }

  if (scenario === 'geo' && filters.geo) {
    // SDO_WITHIN_DISTANCE takes the radius as a parameter string, so the
    // distance is concatenated rather than bound. It's a number from a clamped
    // dropdown, not user text.
    where.push(`sdo_within_distance(geo,
      sdo_geometry(2001, 4326, sdo_point_type(:glon, :glat, null), null, null),
      'distance=${Number(filters.geo.radiusKm)} unit=km') = 'TRUE'`);
    binds.glon = filters.geo.lon;
    binds.glat = filters.geo.lat;
  }

  const whereSql = where.length ? `where ${where.join('\n    and ')}` : '';
  // Ordering by lower(legal_name) matches Redis's SORTABLE copy, which is
  // normalised to lowercase — otherwise the two panes disagree on case-mixed
  // suffixes like "plc" against "Pty Ltd".
  const orderSql = order === 'name' ? 'order by lower(legal_name)' : '';

  return {
    sql: `select ${ORACLE_COLS}, count(*) over () as total
  from ${ORACLE_TABLE}
  ${whereSql}
  ${orderSql}
  fetch first :lim rows only`,
    binds,
  };
}

// Aggregation. This is SQL's home turf and the query is the plainest in the
// whole demo — no special index type, no aggregation pipeline, just GROUP BY.
function oracleFacetSql(field, limit) {
  return {
    sql: `select ${field} as value, count(*) as cnt, sum(exposure_usd) as exposure
  from ${ORACLE_TABLE}
  group by ${field}
  order by cnt desc
  fetch first :lim rows only`,
    binds: { lim: limit },
  };
}

// Known-item retrieval by primary key.
function oracleLeiSql() {
  return {
    sql: `select ${ORACLE_COLS} from ${ORACLE_TABLE} where lei = :lei`,
    binds: {},
  };
}

// Vector search. FETCH APPROX FIRST tells Oracle it may use the vector index
// rather than scoring every row; without APPROX it does an exact scan.
function oracleVectorSql(limit, filterSql = '', filterBinds = {}) {
  const where = filterSql ? `where ${filterSql}` : '';
  return {
    sql: `select ${ORACLE_COLS}, profile,
       vector_distance(embedding, :qv, COSINE) as dist
  from ${ORACLE_TABLE}
  ${where}
  order by dist
  fetch approx first :lim rows only`,
    binds: { ...filterBinds, lim: limit },
  };
}

// Hybrid filters, expressed for each engine from the same inputs.
function hybridFilters(filters) {
  const redisClauses = [];
  const oracleWhere = [];
  const oracleBinds = {};

  if (filters.countries?.length) {
    redisClauses.push(`@country:{${filters.countries.join('|')}}`);
    const ks = filters.countries.map((c, i) => {
      oracleBinds[`hc${i}`] = c;
      return `:hc${i}`;
    });
    oracleWhere.push(`country in (${ks.join(', ')})`);
  }
  if (filters.status) {
    redisClauses.push(`@status:{${filters.status}}`);
    oracleWhere.push('status = :hstatus');
    oracleBinds.hstatus = filters.status;
  }
  if (Number.isFinite(filters.minRating)) {
    redisClauses.push(`@rating_score:[${filters.minRating} +inf]`);
    oracleWhere.push('rating_score >= :hminRating');
    oracleBinds.hminRating = filters.minRating;
  }
  if (Number.isFinite(filters.maxRisk)) {
    redisClauses.push(`@risk_score:[-inf ${filters.maxRisk}]`);
    oracleWhere.push('risk_score <= :hmaxRisk');
    oracleBinds.hmaxRisk = filters.maxRisk;
  }
  if (filters.keyword) {
    // The lexical half of hybrid: the narrative note must also contain a term.
    redisClauses.push(`@profile:(${filters.keyword})`);
    oracleWhere.push('contains(search_text, :hkw, 2) > 0 or lower(profile) like :hkwlike');
    oracleBinds.hkw = filters.keyword;
    oracleBinds.hkwlike = `%${filters.keyword}%`;
  }

  return {
    redis: redisClauses.length ? `(${redisClauses.join(' ')})` : '*',
    oracleWhere: oracleWhere.join('\n    and '),
    oracleBinds,
  };
}

// Redis KNN. Runtime attributes go in a trailing =>{...} block; putting
// EF_RUNTIME inside the KNN clause is a syntax error. 100 matches the search
// effort Oracle's vector index does by default.
function redisVectorArgs(vectorBuf, limit, filterExpr = '*') {
  const query = `${filterExpr}=>[KNN ${limit} @vector $BLOB AS vscore]=>{$EF_RUNTIME: 100}`;
  return [
    'FT.SEARCH', REDIS_INDEX, query,
    'PARAMS', '2', 'BLOB', vectorBuf,
    'SORTBY', 'vscore',
    'LIMIT', '0', String(limit),
    'RETURN', '8', 'id', 'legal_name', 'country', 'credit_rating',
    'risk_score', 'status', 'profile', 'vscore',
    'DIALECT', '2',
  ];
}

function redisLeiKey(lei) {
  return `cp:${String(lei).replace(/[^A-Z0-9]/gi, '').toUpperCase()}`;
}

module.exports = {
  sanitize,
  redisQuery,
  redisSearchArgs,
  redisAggregateArgs,
  redisVectorArgs,
  redisLeiKey,
  oracleTextExpr,
  oracleSearchSql,
  oracleFacetSql,
  oracleLeiSql,
  oracleVectorSql,
  hybridFilters,
  solrFloats,
  REDIS_RETURN,
};
