# Methodology and caveats

Read this before presenting.

This is vendor-authored competitive material, so the method is stated in full and
the code is short enough to audit. A rigged benchmark is worse than no
benchmark: the first thing a customer's DBA does is read `src/queries.js` and
`src/seed-oracle.js`.

---

## Oracle is given a configuration a DBA would recognise

Every one of these is a deliberate choice to avoid winning on Oracle's
misconfiguration rather than on Redis's merits.

- **Bitmap indexes on the low-cardinality screening columns** — `country`,
  `status`, `entity_type`, `sector`, `credit_rating`. That's the right Oracle
  choice for read-heavy filtering on columns with a handful of distinct values.
  Using B-trees there would have been quietly stacking the deck.
- **B-tree indexes on the numeric range columns**, and a function-based index on
  `lower(legal_name)` so case-insensitive prefix work can use an index instead
  of a full scan.
- **A real Oracle Text CONTEXT index** for name search, not `LIKE '%term%'`.
  Fuzzy matching uses `CONTAINS(.., 'fuzzy(term, 60, 10, weight)')`, which is
  Oracle Text's own operator.
- **`SYNC (ON COMMIT)` on that text index.** By default a CONTEXT index only
  updates when someone calls `CTX_DDL.SYNC_INDEX`, which would leave newly
  inserted counterparties invisible to `CONTAINS` indefinitely. `ON COMMIT` is
  the freshest setting Oracle offers, so that's what it gets.
- **A real spatial index**, including the `USER_SDO_GEOM_METADATA` row Oracle
  requires before one can be created.
- **A connection pool with a statement cache** (`stmtCacheSize: 60`) and **bind
  variables everywhere**. Opening a connection per query would measure Oracle's
  session establishment, and string-interpolated SQL would force a hard parse on
  every call. Neither is how anyone runs Oracle.
- **`DBMS_STATS.GATHER_TABLE_STATS` before any timing**, so the optimiser has
  what it needs to choose a sane plan.
- **A warm-up pass** over each query shape after loading, so Oracle isn't paying
  first-execution buffer-cache and cursor-cache costs on a timed query.
- **One round trip per query, on both sides.** Oracle gets the page of rows and
  the full match count from a single statement using `COUNT(*) OVER ()`, rather
  than a separate `SELECT COUNT(*)`.

### What that last point costs Oracle, and why it's still fair

Redis returns the total match count as a by-product of the index walk it is
already doing. Oracle has to evaluate the whole result set to produce
`COUNT(*) OVER ()`. That is a genuine difference in how the two answer the same
question, not an artefact — and the alternative (two statements, two round trips)
would be worse for Oracle. It's part of what the timings are showing.

## How timing works

- Each engine runs the query the configured number of times, **alternating which
  goes first**, so neither systematically benefits from running second.
- The **median** is reported, never the minimum.
- Times are wall clock measured in the application via
  `process.hrtime.bigint()` — sub-millisecond resolution, because Redis
  responses land well under 1 ms.
- **No speed multiplier is displayed unless both engines returned the same
  result count.**

## Where Oracle wins, or comes close

**Primary-key lookup: 0.32 ms against Redis's 0.25 ms — 1.3×.** A B-tree PK
probe against a warm buffer cache is genuinely excellent. Redis's advantage here
is structural rather than large: `HGETALL` reads the record at a known key and
never consults an index at all, while Oracle traverses a B-tree. But 1.3× is not
an argument, and presenting it as one damages everything else you say.

**Aggregation is plain SQL.** `SELECT credit_rating, COUNT(*), SUM(exposure_usd)
… GROUP BY` needs no special index, no aggregation pipeline and no new concept.
Redis wins the timing here (7.7 ms against 21.5 ms) but the Oracle query is the
simpler artefact, and for an audience that already writes SQL that matters.

**Relational composition is Oracle's, not Redis's.** Anything requiring a join
across normalised tables — counterparty to parent to exposure history — is a
single SQL statement in Oracle and requires denormalisation in Redis. This demo
does not include such a scenario, and its absence is not evidence that Redis
handles it.

## What this demo does not support

- **Corpus size.** 100k rows is small. Nothing here says anything about
  behaviour when the working set exceeds memory, where Oracle's buffer-cache and
  storage design are the entire point.
- **Concurrency beyond the throughput tab**, and that tab is single-node.
- **Durability, transactions, recovery.** Oracle's ACID guarantees, redo,
  flashback and backup story are not modelled here at all. This Redis
  configuration has persistence turned off.
- **Anything relational.** No joins, no referential integrity, no constraints
  beyond a primary key.
- **Licensing and cost.** Oracle Free has feature and size limits; a licensed
  Oracle deployment is a different conversation.
- **Cold start.** Both engines are measured warm.

If a customer pushes on any of those, the honest answer is that this demo doesn't
cover it.

## The gvenzl "slim" image strips Oracle Text and Spatial

Worth knowing because it silently removes two of the scenarios.
`gvenzl/oracle-free:23-slim-faststart` (4.81 GB) has no `ctxsys.context`
indextype and no `SDO_GEOMETRY` type — `CREATE TABLE` fails with `ORA-00902:
invalid datatype`, and the text index with `ORA-29833: The indextype does not
exist`. `gvenzl/oracle-free:23-faststart` (5.57 GB) has both, and that's what
`docker-compose.yml` uses. The seeder prints which components it found at
startup rather than letting a scenario fail mid-demo.

## Oracle's HNSW needs a preallocated vector pool

`CREATE VECTOR INDEX … ORGANIZATION INMEMORY NEIGHBOR GRAPH` fails with
`ORA-51962: The vector memory area is out of space` unless `vector_memory_size`
has been set and the database restarted. The seeder falls back to
`ORGANIZATION NEIGHBOR PARTITIONS` (IVF), which needs no pool.

Redis requires no equivalent configuration — `VECTOR HNSW` in `FT.CREATE` works
on a default instance. That's a real operational difference, and it's also a
reason the vector timings aren't strictly like-for-like unless you configure the
pool: IVF and HNSW have different recall and latency characteristics.

## Vector similarity is on the same scale on both sides

Oracle's `VECTOR_DISTANCE(… COSINE)` returns a cosine **distance**, the same
convention as Redis. Both become similarity as `1 − distance`, so the two panes
read on one scale with no rescaling to undo.

## Numbers drift when the generator changes

The corpus is deterministic, but deterministic *for a given generator*. If you
change `src/generate.js`, every count quoted in the README changes with it —
re-run `npm run validate` and re-measure before quoting anything.

The narrative note used for embeddings is drawn from a **separate PRNG stream**
precisely so adding it didn't shift the other fifteen fields, which is what
keeps the counts in this repo comparable to the Solr sibling.
