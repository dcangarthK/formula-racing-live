# Telemetry contract

`js/raceTelemetry.js` captures authoritative `RaceSession` state without changing gameplay or making network requests. Records use schema `formula-racing-live.telemetry.v1`.

## Integration

Create one recorder per session, call `begin(raceSession)` when the session is created, then call `step(raceSession, dt)` immediately after each authoritative `RaceSession.update(dt, input)`. Await `flush()` before leaving the results screen.

```js
const recorder = new RaceTelemetryRecorder({ sessionId, userId, userDisplayName });
recorder.begin(raceSession);
// simulation loop, after raceSession.update(dt, input):
recorder.step(raceSession, dt);
```

`dt` drives a deterministic 20 Hz cadence (configurable with `sampleHz`). A slow caller can produce multiple records in one step so scheduled samples are not dropped. Call `end(raceSession, { reason })` when the session is torn down, before the final `flush()`.

IndexedDB is the browser default; environments without it use the in-memory store. Records are written to IndexedDB only; memory is used from the point IndexedDB fails, so a healthy 22-car race keeps no in-memory duplicate, and a read after a failure merges what was already persisted with the memory remainder. Registering a session prunes all but the newest `DEFAULT_SESSION_RETENTION` (3) sessions, since each session can hold hundreds of megabytes. `exportJSON()` returns a session envelope plus records. `exportNDJSON()` returns a session header followed by one record per line.

Every record carries `schemaVersion`, `recordId`, `sessionId`, `userId`, `sequence`, `type`, `sessionType`, `simulationTimeSeconds`, and `raceTimeSeconds`. Telemetry records contain session phase/mode, circuit, conditions, race control, and all cars. Each car contains driver/team identity; classification, lap, sector, pit, penalty and status state; world and track position; controls; speed, gear and powertrain; acceleration and rotation; aero; energy and fuel; tyres; surface state; and per-wheel slip, load, temperature, pressure, suspension and contact.

Event records are transition based: `session_started`, `lap_completed`, `sector_completed`, `position_changed`, `pit_entered`, `pit_exited`, `penalty_changed`, `car_finished`, `car_dnf`, `race_finished`, and `session_ended`. `race_finished` includes the official classification.

`session_ended` terminates every stream, including an abandoned one, and is emitted exactly once when the session is torn down. It carries `reason` (`classified` when the race produced results, otherwise `abandoned`), `completedLaps` (the highest lap count any car completed), `playerCompletedLaps`, `playerBestLapSeconds`, `classified`, and `durationSeconds`.

## Session type

`sessionType` is `race`, `qualifying`, or `time_trial`. The simulation runs a time trial in `quali` mode, so the raw session mode cannot distinguish the two; the game passes the product-level type, which is stored on the envelope and stamped on every record. The envelope's `metadata.configuredLaps` is the planned race distance and is `null` for a time trial, which runs until the driver stops — use `session_ended.completedLaps` for what was actually driven.

## Units

| Suffix or field | Unit |
| --- | --- |
| `*Seconds`, `durationSeconds` | seconds |
| `*M`, `positionM`, `lengthM`, `suspensionDeflectionM` | metres |
| `speedMps` | metres per second |
| `speedKph` | kilometres per hour |
| `*Mps2` | metres per second squared |
| `*Rad`, `headingRad`, `slipAngleRad` | radians |
| `yawRateRadPerSecond` | radians per second |
| `*C`, `surfaceTemperatureC` | degrees Celsius |
| `*N`, `normalLoadN`, `downforceN` | newtons |
| `ersDeployW` | watts |
| `pressure` | kPa (hot tyre pressure, derived from carcass temperature) |
| `*Fraction`, `batteryFraction`, `fuelFraction`, `tyreWearFraction`, `rpmFraction` | 0–1 |
| `throttle`, `brake`, `tyreGrip`, `wetness`, `trackGrip` | 0–1 |
| `steering` | −1 (full left) to 1 (full right) |
| `slipRatio`, `slipAngle` | dimensionless ratio, radians |
| `aeroBalance`, `brakeBias` | 0–1 front share |
| `trackSampleIndex` | circuit centreline sample index, 0 to `circuit.N` − 1 |
| `gear`, `ersMode`, `position`, `lap`, `pitStops`, `trackLimits` | integer counts |

Times are simulation times, not wall-clock. `simulationTimeSeconds` is the recorder's own 20 Hz clock; `raceTimeSeconds` is the session's race clock.

## Live GCP transport

`js/telemetryUplink.js` sends the same records to the optional service in
`cloud/`. It is disabled when no endpoint is configured. A deployment can set
the `formula-racing-telemetry-endpoint` meta value in `index.html`, or define
`FORMULA_RACING_LIVE_CONFIG.telemetryEndpoint` before `main.js` loads.

The client first posts the session envelope to `/v1/sessions`, receives a
short-lived session/user-scoped bearer token, and keeps that token in memory
only. Records are coalesced into ordered batches, retried with bounded backoff,
and retain their stable `recordId` idempotency keys. A 401 triggers one token
renewal for the current batch. IndexedDB remains the durable local copy if the
network or cloud service is unavailable.

No permanent credential or GCP service-account material is included in the
browser build. See `cloud/README.md` for the Cloud Run, Pub/Sub, and Terraform
boundary.
