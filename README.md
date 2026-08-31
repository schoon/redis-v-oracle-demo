# redis-v-oracle-demo

Side-by-side counterparty search: **Redis Query Engine** vs **Oracle Database
23ai Free**, on the same laptop, over an identical 100,000-record corpus, with
per-query latency shown live.

The point isn't only the numbers — it's **how each query is expressed**. Redis
answers each scenario with one index query; Oracle answers it with SQL over a
table plus the right index behind it. Both are printed on screen, side by side,
for every scenario.

> **Method and caveats live in [docs/METHODOLOGY.md](docs/METHODOLOGY.md).**
> Read it before presenting: it covers how Oracle is given a fair configuration,
> where Oracle wins, and what this demo does not support.

## Quick start

```bash
npm install
npm run demo
```

Then open **<http://localhost:3020>**.

`npm run demo` starts both containers, waits for them, generates 100,000
counterparties, loads Redis and Oracle, and starts the web server.

**The first run pulls the Oracle image, which is 5.6 GB** — allow ten minutes or
more on a slow connection. After that, Oracle reaches healthy in about **11
seconds** and the whole seed-and-start cycle takes well under a minute.

### Before you start

| Need | Why |
| ---- | --- |
| **Docker** with Compose v2 | runs both engines |
| **≥ 4 GB** available to Docker | Oracle Free wants ~2 GB; Redis uses ~250 MB at 100k |
| **~7 GB free disk** | the Oracle image is 5.6 GB |
| **Node.js 18+** | the app uses global `fetch` |
| Ports **3020**, **6381**, **1522** free | app, Redis, Oracle |

No Oracle Instant Client to install: `node-oracledb` runs in **thin mode**, pure
JavaScript. Ports are deliberately clear of the sibling `redis-v-solr-demo`
(3010 / 6380 / 8983) and of a default local Redis on 6379, so both demos can run
at once.

### Running the steps individually

```bash
docker compose up -d          # Redis 8 on :6381, Oracle 23ai Free on :1522
npm run seed                  # generate 100k records, load both engines
npm start                     # http://localhost:3020
```

### Stopping

```bash
docker compose down
```

No volumes are declared, so this discards the data. `npm run demo` is idempotent
— both seeders wipe their engine first.

## The scenarios, and how each engine expresses them

| Scenario | Redis | Oracle |
| -------- | ----- | ------ |
| **Typo-tolerant name** | `@legal_name\|aliases:(%kestral%)` | `CONTAINS(search_text, 'fuzzy(kestral,60,10,weight)')` — Oracle Text |
| **Prefix / autocomplete** | `@legal_name\|aliases:(kes*)` | `CONTAINS(search_text, 'kes%')` |
| **Filtered screening** | `@country:{GB\|US} @rating_score:[13 +inf]` | `WHERE country IN (:c0,:c1) AND rating_score >= :minRating` — bitmap + B-tree indexes |
| **Geo proximity** | `@location:[lon lat 50 km]` | `SDO_WITHIN_DISTANCE(geo, …, 'distance=50 unit=km')` — Oracle Spatial |
| **Portfolio breakdown** | `FT.AGGREGATE … GROUPBY … REDUCE SUM` | `SELECT credit_rating, COUNT(*), SUM(exposure_usd) … GROUP BY` |
| **Exact LEI lookup** | `HGETALL cp:<lei>` — no index involved | `SELECT … WHERE lei = :lei` — primary key |
| **Semantic & hybrid** | `KNN 10 @vector $BLOB` | `ORDER BY VECTOR_DISTANCE(embedding, :qv, COSINE) FETCH APPROX FIRST 10` |
| **Concurrent throughput** | `npm run bench` | `npm run bench` |
| **Index & schema** | one `FT.CREATE` | `CREATE TABLE` + 11 indexes + a spatial metadata row + `GATHER_TABLE_STATS` |

That last row is the setup story in one line, and the **Index & schema** tab
shows both sides in full.

## Observed on one laptop

**Measured 2026-08-31.** 100,000 counterparties, Redis 8 and Oracle AI Database
26ai Free (23.26.3) both in Docker on a 14-core Apple-silicon MacBook. Median of
11 runs per sample, median of 3 samples. **Indicative, not a benchmark.**

| Scenario | Redis | Oracle | Ratio |
| -------- | ----- | ------ | ----- |
| Exact LEI (primary key) | 0.25 ms | 0.32 ms | **1.3×** |
| Geo, 50 km radius | 2.72 ms | 4.85 ms | **1.8×** |
| Portfolio breakdown | 7.69 ms | 21.51 ms | **2.8×** |
| Typo-tolerant name | 0.62 ms | 2.07 ms | **3.4×** |
| Prefix | 1.26 ms | 5.10 ms | **4.0×** |
| Filtered screening | 1.44 ms | 8.18 ms | **5.7×** |

Every scenario returned **identical result counts** on both engines, verified
against brute force — see [Validating the results](#validating-the-results).

**Read the LEI row before you present.** Oracle is within 1.3× of Redis on a
primary-key lookup — 0.32 ms against 0.25 ms. A B-tree PK probe with a warm
buffer cache is genuinely excellent, and this is the row a DBA will look for. Do
not claim Redis is an order of magnitude faster at everything; it isn't, and
conceding this one makes the rest credible.

The gap is widest where Oracle has to combine a text index with several
predicates (filtered screening, 5.7×) and narrowest where a single index gives
the answer directly (PK, geo).

Loading the same 100,000 records:

| | Redis | Oracle |
| --- | ----- | ------ |
| Load rate | ~60,000 rows/sec | ~45,000 rows/sec |
| Index build | included in the write | 2.3 s for 11 indexes, then 1.0 s for statistics |
| Searchable after write | immediately | after `COMMIT`; the text index needs a sync — configured here as `SYNC (ON COMMIT)` |

## Validating the results

```bash
npm run validate
```

Every expected answer is computed **independently** from
`data/counterparties.jsonl` in plain JavaScript — no help from either engine —
then compared against what the API returns. Two engines agreeing proves nothing
if both are wrong.

Verified totals against brute force: prefix 2,238 · typo-tolerant 152 ·
filtered 82 · geo/London-50km 1,543, with counts and exposure sums checked
bucket by bucket for the breakdown.

## Semantic search

Each counterparty carries a narrative credit-review note, embedded locally with
**all-MiniLM-L6-v2** (384 dimensions, transformers.js — no API key, no network at
query time). Both engines index the vectors: Redis as a `VECTOR` field with
HNSW/COSINE, Oracle as a `VECTOR(384, FLOAT32)` column with a vector index.

**Oracle 23ai does vector search.** `VECTOR_DISTANCE(… COSINE)` with
`FETCH APPROX FIRST n ROWS ONLY` to use the index. One difference worth knowing:
Oracle's HNSW index lives in a **preallocated vector memory pool** and index
creation fails with `ORA-51962` if that pool isn't sized; the seeder falls back
to an IVF index, which needs no pool. Redis requires no equivalent
configuration.

Enabling it takes about 11 minutes to embed 100,000 notes, so it's opt-in:

```bash
npm run seed:vectors
```

## Configuration

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `COUNT` | `100000` | Corpus size |
| `REDIS_URL` | `redis://localhost:6381` | Redis connection |
| `ORACLE_CONNECT` | `localhost:1522/FREEPDB1` | Oracle connect string |
| `ORACLE_USER` / `ORACLE_PASSWORD` | `counterparty` / `demopassword` | Oracle credentials |
| `PORT` | `3020` | Demo web server |

## Troubleshooting

| Symptom | Fix |
| ------- | --- |
| `table counterparties not found — run: npm run seed` | Oracle was recreated. Re-run `npm run seed`. |
| `ORA-12541` / connection refused on 1522 | Oracle isn't up yet. `docker compose ps`; first boot takes ~11 s, longer while the image is still being pulled. |
| Seeder prints `Oracle Text: NO` or `Spatial: NO` | You're on a `slim` Oracle image — those components are stripped. Use `gvenzl/oracle-free:23-faststart`, which is what `docker-compose.yml` specifies. |
| `ORA-51962` during vector index creation | Expected on a default configuration; the seeder falls back to IVF. To get HNSW, set `vector_memory_size` and restart the database. |
| `Port 3020 is in use` | `PORT=3021 npm start` |
| Docker out of memory | Oracle Free wants ~2 GB. Give Docker at least 4 GB. |

## Not safe to expose

No authentication, no rate limiting, and the Oracle password is in
`docker-compose.yml`. It's a local demo — keep it on localhost.

---

Derived from [`redis-v-solr-demo`](https://github.com/schoon/redis-v-solr-demo),
which runs the same scenarios against Apache Solr.
