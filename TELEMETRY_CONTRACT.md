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

`dt` drives a deterministic 20 Hz cadence (configurable with `sampleHz`). A slow caller can produce multiple records in one step so scheduled samples are not dropped. IndexedDB is the browser default; environments without it use the in-memory store. `exportJSON()` returns a session envelope plus records. `exportNDJSON()` returns a session header followed by one record per line.

Every record carries `schemaVersion`, `recordId`, `sessionId`, `userId`, `sequence`, `type`, `simulationTimeSeconds`, and `raceTimeSeconds`. Telemetry records contain session phase/mode, circuit, conditions, race control, and all cars. Each car contains driver/team identity; classification, lap, sector, pit, penalty and status state; world and track position; controls; speed, gear and powertrain; acceleration and rotation; aero; energy and fuel; tyres; surface state; and per-wheel slip, load, temperature, pressure, suspension and contact.

Event records are transition based: `session_started`, `lap_completed`, `sector_completed`, `position_changed`, `pit_entered`, `pit_exited`, `penalty_changed`, `car_finished`, `car_dnf`, and `race_finished`. `race_finished` includes the official classification.

No GCP credentials, endpoints, authentication tokens, or network transport are included. Persisted records are the hand-off boundary for a later authenticated uploader.
