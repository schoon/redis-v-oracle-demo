# redis-v-oracle-demo

A customer-facing demo comparing Redis Query Engine against Oracle Database for
counterparty search. Node/Express backend, single-file vanilla frontend, both
engines in Docker.

Published at <https://github.com/schoon/redis-v-oracle-demo> (private).

## Stack

- **Backend:** Node.js + Express
- **Redis client:** the `redis` meta-package. Unlike the leaderboard project,
  this one *needs* a module — `FT.*` lives in `@redis/search`, and the peer
  ranges of `@redis/client@1` and a standalone `@redis/search` don't line up.
  The meta-package ships a coherent set, so it wins here.
- **Oracle:** plain HTTP via global `fetch`. No client library.
- **Frontend:** one `public/index.html`. No framework, no build step.

## Commands

```bash
docker compose up -d     # Redis 8 on :6381, Oracle 23ai Free on :1522
npm run seed             # generate + load both engines (~10s)
npm start                # demo on :3020
```

`npm run seed` is safe to re-run; both seeders wipe their engine first.

## The one rule that matters: the comparison must stay fair

This is vendor-authored competitive material. A customer's search architect will
read `src/queries.js`. If the two engines are found to be answering different
questions, the demo is worse than useless — it costs credibility.

So, before changing anything about how a query is built:

**Both engines must answer the same question.** Same corpus, same boolean
semantics, same edit distance, same field boosts. `mm=100%` on the Oracle side is
not optional — it's what makes Oracle's multi-term behaviour match Redis's default
intersection. Without it `kestral capitol` returns 158 documents from Redis and
8,662 from Oracle.

**The UI must keep refusing to show a multiplier when result counts differ.**
`totalsMatch` exists for that. Don't "fix" a totals mismatch by hiding it.

Geo is the single exception, and it is a narrow one. The two engines round geo
distance differently, so documents on the radius boundary can fall either side —
worst observed case 7 documents in 5,215 across all 24 centre/radius pairs. That
scenario accepts a 0.25% tolerance derived from that measurement, and the UI
prints the actual delta and percentage whenever the tolerance is load-bearing.
Don't widen the tolerance, don't apply it to other scenarios, and don't stop
printing the delta — the strict check is what makes the rest of the numbers
trustworthy.

**Oracle must stay warm and keep-alive'd.** The seeder's warm-up pass and Node's
connection reuse are both load-bearing. Timing a cold Oracle, or one paying a TCP
handshake per query, would be a cheap trick.

**Report the median, never the minimum**, and keep alternating which engine runs
first.

**Keep showing Oracle's `QTime` next to its wall clock.** Its internal search is
sub-millisecond; most of its wall time is HTTP and JSON. Hiding that invites the
accusation that the whole demo is a transport-overhead measurement dressed up as
a search comparison. Showing it, and saying so in the README, is what makes the
rest of the numbers trustworthy.

**Don't quietly widen the claim.** What this demo supports is "on this corpus,
the end-to-end cost of asking Redis these questions is lower, and the query is
shorter to express". It does not support anything about corpora larger than
memory, anything transactional or durable, anything relational (no joins), or
anything about Oracle at licensed scale. The METHODOLOGY "What this demo does not
support" section is a feature — keep it current.

**Oracle is within 1.3x of Redis on primary-key lookup, and that stays in.**
0.32 ms against 0.25 ms. A B-tree PK probe against a warm buffer cache is
genuinely excellent. Don't remove the row, bury it, or reconfigure it into a
bigger win — conceding the one scenario where the competitor is nearly equal is
what makes the other five credible.

Aggregation is also worth conceding on form rather than time: Redis is faster
(7.7 ms against 21.5 ms) but `SELECT ... GROUP BY` is the simpler artefact, and
for an audience that writes SQL every day that matters.

## Conventions

**Comment the query construction.** Both engines' queries live together in
`src/queries.js` on purpose. Each clause gets a comment naming the operator and
what it does, so the file doubles as an explanation during a demo.

**Synthetic names only.** The generator invents institution names. Never seed
real firm names — fabricated credit ratings and risk scores attached to a real
institution is a liability in a customer meeting.

**Deterministic data.** `config.js` holds a fixed PRNG seed so reruns produce
identical data. Don't introduce `Math.random()` into the generator.

**Redis is on 6381.** Deliberately not 6379 or 6380, so this demo can't collide
with a local Redis or with the sibling Solr demo. Don't "tidy" it to a
Redis the presenter already has running. Don't "tidy" it back to the default.

**Don't reintroduce a memory comparison.** An earlier README quoted container
memory as a Redis win (245 MB vs 2.3 GB) and it was wrong: `-Xms2g` preallocates,
so Oracle's container reports 2.3 GB regardless of corpus, and its actual on-disk
index is 27 MB against roughly 133 MB resident in Redis. Oracle's index is
*smaller*. Redis trades RAM for latency — that's the honest framing, and it's the
one in the README.

## The throughput benchmark

`src/bench.js`, run via `npm run bench`. Four things about it are load-bearing;
don't undo them.

**It stays a CLI tool.** Driving load from inside the web server would have the
load generator competing with the process being measured. The UI reads the
results file instead.

**worker_threads, not one event loop.** A single-threaded client saturates before
Redis does and you end up benchmarking Node's JSON parsing rather than either
engine.

**Engines are loaded sequentially.** Never add a "run both at once" mode — on one
host they'd compete for cores and both numbers would be meaningless.

**Client CPU is measured in the main thread only.** `process.cpuUsage()` inside a
worker reports the whole process, so summing it per worker inflates it by the
worker count (this bug initially reported 101 CPU-seconds per wall-second on a
14-core box). If the client saturates, the QPS figure is a client limit and the
tool must keep saying so.

## Oracle-specific traps

**The gvenzl "slim" image strips Oracle Text and Spatial.** No `ctxsys.context`
indextype, no `SDO_GEOMETRY`. `docker-compose.yml` pins
`gvenzl/oracle-free:23-faststart` for that reason — don't "optimise" the image
size back to slim. The seeder prints which components it found at startup.

**A spatial index needs a `USER_SDO_GEOM_METADATA` row first,** and dropping the
table doesn't remove it. `dropAll()` deletes it explicitly or recreating the
index fails.

**Oracle's HNSW vector index needs `vector_memory_size` preallocated** or
creation fails with ORA-51962. The seeder falls back to IVF. If you change this,
say which index was actually built — they have different recall.

**Bind variables, always.** Not for injection safety alone: string-interpolated
SQL forces a hard parse per query and would make Oracle look slower than it is.


## Redis data model

One Hash per counterparty at `cp:<LEI>`, one index over the prefix.

- `cp:<LEI>` — Hash. All 15 fields as strings; the NUMERIC index parses the
  numeric ones.
- `cp:idx` — the index. `ON HASH PREFIX 1 cp:`.

`rating_score` (1–22) is the numeric twin of the ordinal `credit_rating`, which
is what turns "BBB- or better" into a single range query. Keep them in sync if
the rating scale changes.

The index is created *before* the data loads in `seed-redis.js`. That's
intentional: it demonstrates that Redis indexes synchronously on write, with no
commit step, which is one of the things the demo is showing.

## Layout

```
docker-compose.yml
src/config.js  generate.js  seed-redis.js  seed-oracle.js  queries.js  server.js
public/index.html
data/                      generated, gitignored
```

Keep the frontend a single self-contained `index.html` — no build step.
