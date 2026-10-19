# The Live Racing Side Quest

Status: scope, revision 2, 2026-10-20. Builds the demo described in
`gcp-data-platform/docs/strategy/DPE GCP side quest.md`. Companion to
[`docs/specs/telemetry-tiers.md`](../specs/telemetry-tiers.md), which defines
the data this consumes.

## 1. Why we are doing this

Two outcomes, and they pull in the same direction:

1. **A demo worth showing.** A browser racing game that streams real telemetry
   into GCP, a live timing screen that keeps up with the car, an AI race
   engineer talking to the driver, and a post-race console that explains the
   race. The experience the team saw at the Google summit, built with services
   we already pay for and no specialist hardware.
2. **GCP skill across the team.** We are a GCP house; the fastest way to get
   fluent in Pub/Sub, BigQuery, Cloud Run, Firestore, Vertex AI and the IAM and
   Terraform underneath them is to build something with a deadline and an
   audience, where the data is awkward and the screen is in front of people.

This is a side quest, not an assessment. Nobody is being ranked. Teams choose
their own services precisely because choosing — and then defending the choice —
is where the learning is.

## 2. The shape of it

The game is fixed. The two screens are fixed. Everything in between is the
exercise.

```
  Game (this repo)                      Teams build this                 We provide
  ────────────────                      ────────────────                 ──────────
  22 cars, 20 Hz          ──────►   ingest · buffer · process   ──────►  live dashboard
  browser, real physics             store · serve · deploy               post-race dashboard
                                            │
                                            └── optional: AI race engineer
```

| Fixed | Theirs to decide |
| --- | --- |
| The game as the only data producer | How telemetry leaves the browser and lands in GCP |
| The record schema and tiers | Transport, buffering, ordering, replay |
| The two dashboards and the contract they read (§5) | Storage, query engine, serving layer |
| A GCP project per team with a budget cap | How the live screen gets fresh data |
| The dashboards run in their project, not on a laptop | Whether to add the AI layer, and how |

### 2.1 Why we ship the dashboards

Frontend work is not GCP skill. A team that spends a day on React has learned
nothing about streaming, and two teams' demos become impossible to compare.
Shipping the screens keeps everyone on the data path, makes every demo look
like the same product, and lets us instrument latency identically for everyone.

What teams still own, and what is squarely a GCP skill: standing up the serving
layer behind the contract, deploying the dashboards to Cloud Run or Firebase
Hosting in their own project, wiring IAM, and keeping it alive while someone
drives.

## 3. The data the game produces

Measured on a 22-car Monza race (`npm run test:tiers`), extrapolated to 30
minutes, as compact NDJSON:

| Tier | Rate | Bytes/record | Msgs per race | Per 30 min |
| --- | --- | --- | --- | --- |
| `live` — all 22 cars, slim | 5 Hz | ~10.4 KB | 9,000 | 89 MB |
| `engineering` — player car, full detail | 20 Hz | ~2.7 KB | 36,000 | 92 MB |
| `events` — laps, sectors, pits, penalties, classification | as they occur | ~400 B | ~3,400 | 1.3 MB |
| `archive` — all cars, full detail (local only) | 20 Hz | ~52 KB | 36,000 | 1,888 MB |

Sustained upload while racing: **~105 KB/s**, in batches of up to 50 records
every 250 ms. Every record carries `recordId` (`sessionId:sequence`), stable
across retries — the idempotency key any consumer should deduplicate on.

Three ways to feed a pipeline, all provided: the live browser (posts a session
envelope, gets a short-lived token, then posts ordered batches), a headless
producer (`node tools/sim-telemetry.mjs monza 3`) that runs a full 22-car race
and writes NDJSON per tier, and a recorded fixture replayable at wall-clock
speed so nobody has to drive while developing.

## 4. What gets built

### 4.1 Live dashboard — provided

Running order with gaps and intervals, lap and sector progress, tyre compound
and wear, pit and penalty state, session state (green, VSC, chequered), and the
player's own trace: speed, throttle, brake, gear, ERS. It stamps and displays
**glass-to-glass latency** — simulation time to pixel — which is the number the
demo lives or dies on. Target under 2 s; under 1 s is a good demo.

### 4.2 Post-race dashboard — provided

Opens on its own when a session ends (the `session_ended` event is the
trigger): classification, lap and sector times, stint and tyre history, where
time was won and lost, and the AI debrief if the team built one.

### 4.3 The AI race engineer — optional, and the best part of the demo

Not every team will get here, and the demo is still good without it. For the
teams that do, the rule from the strategy doc holds: **never send 20 Hz
telemetry to a model.** The processor detects meaningful moments — a completed
corner, a lap, a lock-up, a pit exit — and sends a compact summary. Gemini Flash
returns a short structured instruction, the dashboard shows it, and Cloud
Text-to-Speech can speak it into the driver's headphones between corners.

```json
{"severity":"medium","observation":"Braking 14 m earlier than your best lap into Turn 6.","recommendation":"Carry braking ten metres deeper and release more progressively.","speak":true}
```

Post-race, a larger model gets lap, sector and stint summaries — never raw
samples — and writes the debrief the second screen renders.

## 5. The dashboard contract

The dashboards read through a pluggable source, so fixing the screens does not
fix the architecture behind them. Two supported ways to satisfy it.

### 5.1 Serving contract (default)

The team stands up an HTTPS service — anything, anywhere in their project — and
the dashboards point at it:

| Endpoint | Returns |
| --- | --- |
| `GET /api/v1/sessions` | Sessions with id, driver, track, type, status, start and end times |
| `GET /api/v1/live/:sessionId` | A stream (SSE or WebSocket) of race state: cars with position, lap, gaps, tyres, pit and penalty state, plus session flags and the player's trace |
| `GET /api/v1/race/:sessionId` | A finished race: classification, laps, sectors, stints, events, and the AI debrief if present |
| `GET /api/v1/health` | Liveness, and the ingest lag the service believes it has |

Backed by whatever they choose: BigQuery, Firestore, Bigtable, Memorystore, or
an in-process cache in the ingest service itself.

### 5.2 Adapter module

For designs with no serving layer — Firestore listeners, the Firebase SDK
straight to the page — teams drop in a JavaScript module implementing
`subscribeLive(sessionId, onState)` and `getRace(sessionId)`. The dashboards
load it instead of the default HTTP source.

Both paths are first class. The contract is versioned; breaking it is our job
to avoid, not theirs to absorb mid-quest.

## 6. The option space

We publish options, never the mapping from problem to service. That mapping is
the exercise.

**Ingest** — Cloud Run HTTP; Cloud Run with WebSockets; Cloud Functions (2nd
gen); API Gateway or a load balancer in front; direct Pub/Sub REST publish from
the browser with short-lived scoped credentials; the Firebase SDK straight from
the page; Kafka or GKE if they want to argue for it.

**Buffer and transport** — Pub/Sub, with or without ordering keys; Cloud Tasks;
Redis Streams on Memorystore; Managed Service for Apache Kafka; or no buffer,
writing straight to a sink, which is a defensible choice they must defend.

**Live fan-out** — Firestore realtime listeners; Cloud Run WebSockets; server-
sent events; Memorystore pub/sub behind a socket; Bigtable with a polling API;
BigQuery polled on a timer.

**Storage and analysis** — BigQuery via a Pub/Sub BigQuery subscription (no
consumer code at all), via the Storage Write API, or via scheduled queries and
Dataform for curation; Dataflow streaming; GCS with BigLake; Bigtable; Cloud SQL
or AlloyDB.

**Processing and AI** — Cloud Run services or jobs; Dataflow; Eventarc and
Workflows for the post-race trigger; Vertex AI with Gemini Flash for coaching
and the debrief; Cloud Text-to-Speech (Chirp) for the spoken feed; Vertex AI
Search if they want track knowledge grounding.

**Platform** — Terraform, Cloud Build, Artifact Registry, Secret Manager, IAM
and service accounts, Cloud Logging and Monitoring, budget alerts. This layer is
not optional: every team deploys from code and ships a dashboard URL.

## 7. Candidate architectures

We build and measure these ourselves before the quest starts, so we know it is
winnable and know what good looks like. Teams do not get the diagrams.

| | Path | What it proves | Where it hurts |
| --- | --- | --- | --- |
| **A** | Cloud Run → Pub/Sub → BigQuery subscription → curation SQL | The managed minimum: almost no consumer code. Already built in `cloud/` | Live latency in seconds, not sub-second |
| **B** | Cloud Run → Firestore race-state doc (5 Hz) + Pub/Sub → BigQuery | Sub-second live screen with no socket code | Document granularity: one doc per sample is fine, one per car per sample is 20× the cost |
| **C** | Cloud Run ingest and WebSocket hub, min instances 1 | Lowest latency, full control of the wire | Reconnects, backpressure, instance affinity — all yours |
| **D** | Cloud Run → Pub/Sub → Dataflow → Bigtable + BigQuery | Scales to a grid of real drivers | Eats a whole day if the team has not used Dataflow |
| **E** | Firebase SDK → Firestore → Function → Pub/Sub → BigQuery | Fastest route to a moving screen | Weakest on schema control, cost and abuse |
| **F** | Session NDJSON to GCS at race end → BigQuery load | Cheapest, simplest | Fails the live requirement; included so the line is clear: **the live screen must be fed by cloud data, not by the game page** |

## 8. Cost and rate reference (30-minute race, one driver)

| Item | Quantity | Approximate cost |
| --- | --- | --- |
| Telemetry published, three streamed tiers | 182 MB | Pub/Sub ~$0.007 |
| BigQuery ingest (Storage Write) | 182 MB | ~$0.004 |
| Firestore, one race-state doc at 5 Hz | 9,000 writes | ~$0.016 |
| Firestore, one doc per car per sample | 198,000 writes | ~$0.36 |
| Cloud Run ingest | ~1 vCPU-min per race-min | cents |
| Gemini Flash coaching, one call per corner | ~60–200 calls | cents |
| Gemini post-race debrief | 1–5 calls | cents |

The data is small and cheap. A large bill means per-row writes, an always-on
instance, or a dashboard re-querying BigQuery on a timer — all worth surfacing
at the demo, none of them a failure.

## 9. Format

Four sprints, mirroring the strategy document's stages, each independently
demonstrable:

| Sprint | Everyone ships | GCP skill it builds |
| --- | --- | --- |
| 1 — Ingest | Telemetry from a real race landing in their project, durably | Cloud Run, IAM, service accounts, Terraform, Artifact Registry |
| 2 — Movement | The live dashboard moving from their data, with latency measured | Pub/Sub, Firestore or sockets, serving-layer design, Cloud Monitoring |
| 3 — Analysis | The post-race dashboard, assembled from their own tables | BigQuery modelling, partitioning and clustering, scheduled queries, Dataform |
| 4 — The engineer | AI coaching live, a written debrief after | Vertex AI, Gemini prompting and structured output, Cloud TTS, Eventarc |

Teams of two to four, one GCP project each with a budget alert and a hard cap,
common APIs pre-enabled. A facilitator answers questions about the game and the
data, and declines questions about which service to use. Each sprint ends with a
ten-minute demo: drive a live lap with their dashboard on screen, then show a
finished race.

## 10. What a good demo looks like

Not a score, a checklist the team can hold themselves to:

- The live screen keeps up while someone drives, and says how far behind it is.
- Lap and sector times on the dashboard match the game's own timing exactly.
- The post-race screen appears without anyone pressing anything.
- Pulling the network for thirty seconds mid-race loses nothing the design
  claims to keep — and the team can say which part that is.
- They can explain why this architecture, what it costs, and where it breaks.
- It is deployed from code, and someone else could stand it up.

## 11. What we do before it starts

1. **A end to end** — deploy it, drive a real race, confirm both dashboards
   work. Zero dropped records; curated tables match the game's classification.
2. **The dashboards and the contract** — build them, instrument latency, and
   prove both the HTTP source and the adapter module against A.
3. **B's latency and cost** — median glass-to-glass under 1 s, under $0.05 per
   race.
4. **C's socket stability** — a 30-minute race with no silent disconnects.
5. **The AI layer on A** — corner events to Gemini Flash, a spoken instruction
   back, a post-race debrief written into the second screen.
6. **Induced failures** — kill the ingest mid-race, drop the network, close the
   tab without finishing. Confirm each architecture degrades the way it claims.
7. **D and E, time-boxed** — enough to know they are winnable, not traps.

Items 1 and part of 3 are close: the tiering, ingest service, per-tier topics,
BigQuery landing tables and curation SQL exist and are tested. Nothing is
deployed to a live project yet, and the dashboards do not exist.

## 12. Risks

- **The dashboards become a bottleneck for us.** They are now a product we
  maintain and version. Mitigated by keeping the contract small and the screens
  boring.
- **Everyone builds the same architecture.** Fine, and likely. Seeding teams
  with different constraints — "sub-second", "under $1", "survives a
  60-second outage" — produces variety without naming services.
- **Cost runaway.** Budget caps per project and the table in §8 in the brief.
- **The AI layer eats the quest.** It is sprint four for a reason; the demo is
  complete without it.
- **It becomes a competition.** It is a side quest. The outcome is skill and a
  demo, and the facilitator should say so when the scoreboard talk starts.

## 13. Open questions

- One project per team, or shared project with per-team datasets? Per team is
  cleaner and costs nothing extra.
- Do teams get the game's source, or a hosted instance plus the contract?
- Is the AI layer in scope for the first run, or the follow-up?
- Who hosts the game during the demos — each team, or us?
- Does this demo need to survive as a reusable asset after the quest, and if so
  who owns it?
