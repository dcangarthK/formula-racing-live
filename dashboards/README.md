# Dashboards

Two screens, provided so a team's work is the data path rather than the
frontend: a **live timing** screen that keeps up with a race in progress, and a
**post-race analysis** screen that explains it once it is over. Both read
through a pluggable source, so fixing the screens does not fix the
architecture behind them.

Scope and rationale: [`../docs/challenge/gcp-racing-challenge.md`](../docs/challenge/gcp-racing-challenge.md).

## Run it locally, with no cloud project

```bash
node tools/sim-telemetry.mjs monza 3   # optional: a recorded race to replay
node tools/contract-server.mjs         # ingest + contract + dashboards on :8365
npm run build && python3 tools/devserver.py 8366 dist
open "http://127.0.0.1:8366/?telemetry=http://127.0.0.1:8365"   # drive
open "http://127.0.0.1:8365/"                                    # watch
```

`tools/contract-server.mjs` is a complete local stand-in for the cloud: it
accepts the game's telemetry uplink, holds the session in memory, and serves
the contract below. It has no auth and no durability — it is a reference, not a
deployment.

The game's `?telemetry=` parameter points one build at any ingest service, which
is how a driver aims it at their own pipeline.

## The contract

A serving layer satisfies the dashboards by exposing four endpoints:

| Endpoint | Returns |
| --- | --- |
| `GET /api/v1/sessions` | Sessions: id, driver, circuit, type, status, laps |
| `GET /api/v1/live/:sessionId` | `text/event-stream` of `LiveState`, one frame per update |
| `GET /api/v1/race/:sessionId` | A `RaceReport` for a finished session |
| `GET /api/v1/health` | Liveness, and the ingest lag the service believes it has |

`LiveState` and `RaceReport` are defined — and, more usefully, *built* — in
[`src/contract.js`](src/contract.js). `applyRecord()` folds telemetry records
into a `LiveState`; `buildRaceReport()` assembles the post-race report from the
event stream alone. Import them, port them, or ignore them: only the shapes on
the wire matter.

Two details worth copying rather than rediscovering:

- **Deduplicate on `recordId`.** Every record carries `sessionId:sequence`, and
  it survives retries. At-least-once delivery is otherwise visible on screen.
- **Ignore stale samples.** A retried batch can arrive after a newer one;
  `applyRecord` drops anything older than the state it already holds, so the
  timing tower never rewinds.

## Adapters: when there is no serving layer

An architecture that pushes straight to the browser — Firestore listeners, the
Firebase SDK in the page — supplies a module instead:

```
?adapter=/dashboards/adapters/example-static.js
```

The module default-exports a factory returning `listSessions()`,
`subscribeLive(sessionId, onState)` (returning an unsubscribe) and
`getRace(sessionId)`. [`adapters/example-static.js`](adapters/example-static.js)
is a working one, replaying a recorded race from
`adapters/example-race.json` — a real 22-car Monza race, thinned to keep the
file small. A Firestore adapter is the same three methods with `onSnapshot`
driving `onState`.

## Latency

The live screen shows glass-to-glass latency, from the `servedAt` stamp the
serving layer puts on each frame to the moment the page renders it. A serving
layer that omits `servedAt` shows `—` and loses the one number the demo is
judged on.

## What the screens deliberately do not do

No authentication, no session management, no writes. They are read-only views
over someone else's pipeline, which is what makes them comparable between
teams.
