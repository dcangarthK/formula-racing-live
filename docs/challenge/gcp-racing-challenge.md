# The Live Racing Challenge on GCP

Status: scope, 2026-10-20. Companion to
[`docs/specs/telemetry-tiers.md`](../specs/telemetry-tiers.md), which defines
the data this challenge consumes.

## 1. The challenge in one paragraph

Each team is given a racing game that emits real telemetry and a GCP project
with a budget. They must stand up a pipeline that ends in two working screens:
a **live dashboard** that moves while someone is driving, and a **post-race
analysis dashboard** that explains the race once it is over. Nothing dictates
which GCP services they use. The game, the data contract and the two
destinations are fixed; everything between them is the challenge.

The point is not to follow a recipe. It is to make engineers meet a real
constraint — 20 Hz of multi-car telemetry from a browser, with a human watching
a dashboard — and defend the trade-offs they chose.

## 2. What is fixed, and what is theirs

| Fixed | Theirs to decide |
| --- | --- |
| The game (this repository) as the only data producer | Ingest: how telemetry leaves the browser and lands in GCP |
| The record schema and tiers (`formula-racing-live.telemetry.v1`) | Transport, buffering, ordering and replay |
| Two deliverable screens: live and post-race | Storage and query engine |
| One GCP project per team, with a budget cap | How the live screen gets its data (push, poll, stream) |
| A time box (see §8) | Whether to add AI commentary, coaching or TTS |
| No telemetry may be invented client-side or replayed as a fake stream during judging | Hosting, IaC, CI, auth, dashboards |

### 2.1 Why the producer is fixed

Participants who build their own producer will build one that suits their
pipeline. Fixing it means every team faces the same awkward facts: a browser
with a flaky connection, 20 Hz samples, 22 cars per sample, bursty events, and
a session that ends abruptly when someone quits.

## 3. The data the game produces

Measured on a 22-car Monza race (`npm run test:tiers`), extrapolated to a
30-minute race, as compact NDJSON:

| Tier | Rate | Bytes/record | Msgs per race | Rows per race | Per 30 min |
| --- | --- | --- | --- | --- | --- |
| `live` — all 22 cars, slim | 5 Hz | ~10.4 KB | 9,000 | 198,000 car-rows | 89 MB |
| `engineering` — player car, full detail | 20 Hz | ~2.7 KB | 36,000 | 36,000 | 92 MB |
| `events` — laps, sectors, pits, penalties, classification | as they occur | ~400 B | ~3,400 | ~3,400 | 1.3 MB |
| `archive` — all cars, full detail (local only) | 20 Hz | ~52 KB | 36,000 | — | 1,888 MB |

Sustained upload while racing: **~105 KB/s (0.8 Mbit/s)**, in batches of up to
50 records every 250 ms. Every record carries `recordId` (`sessionId:sequence`),
which is stable across retries and is the idempotency key any consumer should
deduplicate on.

Three ways to feed a pipeline, all provided:

1. **Live browser** — set the telemetry endpoint and race. The client posts the
   session envelope to `POST /v1/sessions`, gets a short-lived bearer token,
   then posts ordered batches to `POST /v1/telemetry/batches`. Teams may keep
   this contract and reimplement the service, or replace the client transport
   entirely.
2. **Headless producer** — `node tools/sim-telemetry.mjs monza 3` runs a full
   22-car race with no browser and writes one NDJSON file per tier. Useful for
   load tests and for CI.
3. **Fixture replay** — a recorded race as NDJSON, replayable at wall-clock
   speed, so a team can develop without driving.

## 4. The two deliverables

### 4.1 Live dashboard

Must update while a race is running, showing at least: running order with gaps
and intervals, lap and sector progress, tyre compound and wear, pit and penalty
state, and session state (green, VSC, chequered). Judged on **glass-to-glass
latency**: the time between the simulation producing a sample and the screen
showing it. Target under 2 s; under 1 s is excellent.

### 4.2 Post-race analysis dashboard

Must appear automatically once a session ends — the `session_ended` event is
the trigger — and must explain the race rather than dump it: classification,
lap and sector times, stint and tyre history, where time was won and lost, and
at least one derived insight the raw feed does not contain (consistency,
degradation curve, traffic loss, an AI-written summary).

## 5. Architecture options

These are the solution spaces we expect teams to land in. We publish the
*options*, not the answer; the mapping from problem to service is the exercise.

### 5.1 Ingest

| Option | Notes |
| --- | --- |
| Cloud Run HTTP service | The obvious one. Scales to zero, CORS and token issuing are yours to write. |
| Cloud Run + WebSocket | One connection per driver; mind the request timeout and reconnects. |
| Cloud Functions (2nd gen) | Same engine as Cloud Run; simplest for a single handler. |
| API Gateway or Load Balancer in front | Adds auth, quota and WAF; more moving parts than a one-day build needs. |
| Direct Pub/Sub REST publish from the browser | Removes a hop, but needs short-lived scoped credentials; easy to get wrong. |
| Firebase SDK straight from the page | Fastest to a moving dashboard; least control over schema and cost. |
| GKE / Managed Service for Apache Kafka | Defensible at scale, hard to justify for one driver. |

### 5.2 Transport and buffering

Pub/Sub (optionally with ordering keys), Cloud Tasks for retry-heavy work,
Redis Streams on Memorystore, Kafka, or no buffer at all — writing straight to
storage from the ingest service. A team that skips the buffer should be able to
say what happens when the sink is slow or down mid-race.

### 5.3 Getting data onto the live screen

This is where the architectures genuinely diverge, and where most teams will
spend their difficulty budget.

| Pattern | Typical latency | Cost shape at our rates | Watch out for |
| --- | --- | --- | --- |
| Firestore realtime listeners | 100–500 ms | ~$0.016/race if one doc per 200 ms sample; ~$0.36/race if one doc per car per sample | The per-document write limit: a single "race state" doc updated 5×/s is fine, 110 car docs/s is not |
| Cloud Run WebSocket fan-out | 50–300 ms | Compute only | Request timeouts, reconnect logic, no state across instances unless you add one |
| Server-sent events from Cloud Run | 100–400 ms | Compute only | Simpler than WebSockets, one-way only — which is all a dashboard needs |
| Memorystore Redis pub/sub behind a WebSocket | 50–200 ms | Instance billed hourly | A VPC connector and a minimum instance; the only always-on cost here |
| BigQuery polled by the dashboard | 2–10 s | ~$0.004/race ingest | Streaming buffer visibility and per-query latency; acceptable for "near-live", weak for a timing tower |
| Bigtable with a polling API | 10–100 ms | Node-hour billing | Overkill for 110 rows/s, excellent if the story is "this scales to a full grid of telemetry" |
| Pub/Sub straight to the browser | — | — | Not a thing; a team heading here has misread the product |

### 5.4 Storage and analysis

| Option | Fits |
| --- | --- |
| BigQuery via Pub/Sub BigQuery subscription | Least code: no consumer to run, raw JSON lands in a table, shape it with SQL later |
| BigQuery via Storage Write API | Typed rows at ingest, more code, better tables |
| BigQuery + scheduled queries or Dataform | Curating raw landing tables into analysis tables on a timer |
| Dataflow streaming | The "proper" answer at scale; heavy for a one-day build, strong if they know it |
| GCS + BigLake external tables | Cheap archive, good for the full-fidelity tier |
| Bigtable | Time-series reads by car and lap |
| Cloud SQL / AlloyDB | Familiar, fine at this volume, hard to defend for append-only telemetry |

### 5.5 Post-race trigger and narrative

Eventarc on a Pub/Sub message, a Cloud Run job, Workflows, Cloud Scheduler
polling for finished sessions, or a BigQuery scheduled query. For narrative:
Gemini Flash over a lap and sector summary — never over raw 20 Hz telemetry —
optionally with Cloud Text-to-Speech for a spoken debrief, and Vertex AI Search
if they want track knowledge grounding.

### 5.6 Presentation

Looker Studio over BigQuery (minutes to build, weak for live), Grafana on Cloud
Run, a React or Svelte app on Cloud Run or Firebase Hosting, Streamlit on Cloud
Run, or Looker if the org already has it. A live screen and a post-race screen
may legitimately use different tools.

## 6. Candidate reference architectures

We will build and measure these ourselves before the challenge runs. They are
not handed to participants; they exist so we know the challenge is winnable and
so judges know what "good" looks like.

### A. Managed minimum — the baseline we already have

```
Browser → Cloud Run ingest → Pub/Sub (per-tier topics) → BigQuery subscription
                                                              ├→ live view (polled)
                                                              └→ scheduled SQL → post-race dashboard
```

Already implemented in `cloud/` and `cloud/bigquery/`. Almost no consumer code.
Live latency is seconds, not sub-second, which is its honest weakness.
**Validates: the whole chain works end to end at measured volumes.**

### B. Realtime-first

```
Browser → Cloud Run ingest ─┬→ Firestore "race state" doc (5 Hz, one doc)  → live dashboard listeners
                            └→ Pub/Sub → BigQuery → post-race dashboard
```

Sub-second live screen with no socket code, because the client SDK does the
fan-out. The design trap is document granularity: one doc per sample works, one
doc per car per sample hits the per-document write ceiling and costs 20× more.
**Validates: a genuinely live timing tower, and the Firestore cost model.**

### C. Socket fan-out

```
Browser → Cloud Run (ingest + WebSocket hub, min instances 1) → live dashboard
                     └→ Pub/Sub → BigQuery → post-race dashboard
```

Lowest latency, full control of the wire format, and the most code: reconnects,
backpressure and instance affinity are all yours. **Validates: whether Cloud Run
WebSockets survive a 30-minute race without a dropped client.**

### D. Streaming analytics

```
Browser → Cloud Run → Pub/Sub → Dataflow (windowed aggregates)
                                   ├→ Bigtable / Firestore → live dashboard
                                   └→ BigQuery → post-race dashboard
```

The architecture that keeps working at a hundred drivers, and the one most
likely to eat a team's whole day. **Validates: that a heavyweight path is
possible inside the time box, for judging fairness.**

### E. Thin client, no custom ingest

```
Browser (Firebase SDK) → Firestore → Cloud Function → Pub/Sub → BigQuery
                              └→ live dashboard
```

Fastest route to a moving screen; weakest story on schema control, cost and
abuse. **Validates: the "no backend" claim, and what it really costs.**

### F. Batch-only, archive-led

```
Browser → GCS (session NDJSON at session end) → BigLake / BigQuery load
                                                     └→ post-race dashboard
Live screen served from the game's own in-page state
```

Cheapest and simplest, and it fails the live requirement unless the live screen
is genuinely fed from GCP. Included because some team will try it, and judges
need a clear line: **the live dashboard must be fed by cloud data, not by the
game page.**

## 7. Cost and rate reference (per 30-minute race, one driver)

| Item | Quantity | Approximate cost |
| --- | --- | --- |
| Telemetry published (3 streamed tiers) | 182 MB | Pub/Sub ~$0.007 |
| BigQuery ingest (Storage Write) | 182 MB | ~$0.004 |
| BigQuery storage | 182 MB/race | negligible at challenge scale |
| Firestore, one race-state doc at 5 Hz | 9,000 writes | ~$0.016 |
| Firestore, one doc per car per sample | 198,000 writes | ~$0.36 |
| Cloud Run ingest | ~1 vCPU-minute per race-minute | cents |
| Gemini Flash post-race summary | 1–5 calls | cents |

The headline: **the data is small and cheap**. A team that reports a large bill
has usually chosen per-row writes, an always-on instance, or a dashboard that
re-queries BigQuery on a timer. That is a finding worth surfacing in judging,
not a failure.

## 8. Running the challenge

- **Team size** 2–4. Mixed experience; at least one person who has deployed on
  GCP before.
- **Duration** one working day, or two half-days. Teams that need more than a
  day are being asked the wrong question.
- **Projects** one GCP project per team, with a budget alert and a hard cap.
  Pre-enable the common APIs so nobody loses an hour to enablement.
- **Starter kit** the game (this repo, runnable locally), the telemetry
  contract, a recorded NDJSON fixture, the record schema, and a one-page brief.
  No architecture diagram and no Terraform.
- **Support** one facilitator who answers questions about the game and the data,
  and refuses to answer questions about which service to use.
- **Demo** 10 minutes per team: drive a live lap with their dashboard on screen,
  then show the post-race screen for a race that already finished.

## 9. Judging

| Dimension | Weight | What earns it |
| --- | --- | --- |
| Live dashboard works | 25% | It moves while someone drives, and keeps up |
| Post-race dashboard works | 25% | It appears on its own and explains the race |
| Data correctness | 15% | Lap and sector times match the game's own; no duplicates, no gaps |
| Resilience | 15% | A dropped connection, a restarted tab or a slow sink does not lose or corrupt the race |
| Trade-off defence | 15% | They can say why this architecture, what it costs, and where it breaks |
| Polish and reproducibility | 5% | IaC, a README, something another team could stand up |

Deliberately *not* scored: which services they chose, how closely they match our
reference build, and how pretty the dashboard is.

## 10. What we validate before this runs

In order, each with a pass mark:

1. **A end to end** — drive a real race, confirm records reach BigQuery, both
   dashboards work. Pass: zero dropped records; curated tables match the game's
   own classification.
2. **B's live latency and cost** — measure glass-to-glass and count Firestore
   writes. Pass: median under 1 s, under $0.05 per race.
3. **C's socket stability** — a 30-minute race with the dashboard open. Pass: no
   silent disconnects, or reconnects that recover within 5 s.
4. **Volume honesty** — confirm §3 and §7 against a real race rather than the
   fixture. Pass: within 20% of the published figures.
5. **The failure modes we will induce during judging** — kill the ingest
   service mid-race, drop the network for 30 s, close the tab without finishing.
   Pass: the pipeline loses nothing it claims to keep, and says so.
6. **D and E, time-boxed to a day each** — to confirm both are winnable rather
   than traps.

Items 1 and 4 are mostly done: the tiering, the ingest service, the Pub/Sub
topics, the BigQuery landing tables and the curation SQL exist and are tested;
nothing has been deployed to a live project yet.

## 11. Risks

- **Nobody finishes.** Mitigated by the fixture replay, pre-enabled APIs and a
  facilitator who unblocks the game, not the architecture.
- **Everyone builds the same thing.** Likely, and fine — the defence of the
  trade-offs is the scored part. Seeding each team with a different constraint
  ("sub-second", "under $1", "survives a 60-second outage") produces variety
  without naming services.
- **Cost runaway.** Budget caps per project, plus a review of the cost table in
  the brief so nobody discovers per-row Firestore writes at the invoice.
- **The game becomes the bottleneck.** It runs locally in a browser with no
  build step; the headless producer covers machines that cannot run it.
- **Judging the wrong thing.** The rubric deliberately excludes service choice
  and visual polish.

## 12. Open questions

- One shared project with per-team datasets, or a project per team? A project
  per team is cleaner and costs nothing extra.
- Do participants get the game's source, or only a hosted instance plus the
  contract? Source invites them to change the producer, which weakens the
  comparison.
- Is the AI layer (coaching, TTS, narrative) in scope for the first run, or a
  stretch goal? It is the most demo-friendly part and the least architectural.
- Who hosts the game during judging — each team, or us?
