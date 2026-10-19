# Tiered telemetry feed and BigQuery schema

Status: design, 2026-10-19. Supersedes the single full-fidelity stream in
`TELEMETRY_CONTRACT.md` for anything that leaves the browser.

## Problem

The recorder publishes one record per 20 Hz sample containing every car at full
fidelity. A measured 9-minute single-car time trial produced 10,777 samples and
51 MB of formatted JSON. The same recorder in a 22-car race produces roughly
900 MB for 9 minutes and about 3 GB for a 30-minute race, because every sample
carries 22 cars with per-wheel slip, load, temperature, pressure and suspension.

That volume is wrong for the destination, not just large. A spectator dashboard
needs position, gap and tyre state for 22 cars; it never reads rear-left
carcass temperature. An engineering trace needs all of it, but only for one car.
Sending both at the same rate to the same place pays the worst price for both.

## Tiers

| Tier | Scope | Rate | Purpose | Destination |
| --- | --- | --- | --- | --- |
| `live` | all cars, slim | 5 Hz (configurable 5–10) | spectator dashboard, timing tower | Pub/Sub → BigQuery |
| `engineering` | player car, full detail | 20 Hz | driver trace, tyre and energy analysis | Pub/Sub → BigQuery |
| `events` | transitions | as they occur | laps, sectors, pits, penalties, classification | Pub/Sub → BigQuery |
| `archive` | all cars, full detail | 20 Hz | replay, physics regression, future ML | IndexedDB, uploaded to GCS at session end, opt-in |

The authoritative simulation still produces one 20 Hz all-car snapshot. Tiering
is a projection of that snapshot, so no tier can disagree with another.

### Rate and field budget

Per 30-minute race, formatted JSON, before Pub/Sub batching:

| Tier | Rows | Bytes/row | Total |
| --- | --- | --- | --- |
| `live` | 22 cars × 5 Hz × 1800 s = 198,000 | ~260 | ~51 MB |
| `engineering` | 20 Hz × 1800 s = 36,000 | ~1,400 | ~50 MB |
| `events` | ~1,500 | ~300 | ~0.5 MB |
| archive (not streamed) | 36,000 snapshots | ~25,000 | ~900 MB |

About 100 MB reaches GCP for a full race, against roughly 3 GB today. The
archive stays local unless the driver opts in, and uploads once, compressed,
after the session rather than during it.

`live` at 10 Hz doubles its tier to about 100 MB. 5 Hz is the default because a
timing tower updates visibly at 5 Hz and gap interpolation covers the rest.

### `live` fields

Per sample: `sessionId`, `sequence`, `simulationTimeSeconds`, `raceTimeSeconds`,
`phase`, `raceControl.state`, `conditions.wetness`, `conditions.trackGrip`.

Per car: `driverId`, `teamId`, `isPlayer`, `position`, `lap`,
`trackSampleIndex`, `positionM.x`, `positionM.z`, `speedKph`, `gapToLeaderSeconds`,
`intervalSeconds`, `lastLapSeconds`, `bestLapSeconds`, `tyreCompound`,
`tyreWearFraction`, `pitState`, `pitStops`, `penaltySeconds`, `finished`, `dnf`.

No wheels, no suspension, no acceleration, no energy. A dashboard that needs one
car's detail reads `engineering` or the archive.

### `engineering` fields

The existing full car payload for the player only: controls, speed, gear, rpm,
longitudinal and lateral acceleration, yaw rate, slip angle, downforce, aero
balance, brake bias and temperature, battery, ERS mode and deployment, fuel,
tyre compound, wear, grip, temperature, surface wetness, and the four wheels
with slip ratio, slip angle, normal load, surface and carcass temperature,
pressure, suspension deflection and contact.

### `events`

Unchanged from `TELEMETRY_CONTRACT.md`, including `session_ended`. Events are
the only tier that must never be sampled, dropped or down-rated: they are the
transitions a dashboard and a classification are built from.

## Transport

One topic per tier (`…-live`, `…-engineering`, `…-events`) rather than one
topic with a filter, so a slow analytical consumer on one tier cannot delay the
live feed, and each tier can carry its own retention and subscription.

The ingest service keeps its current contract: the client posts the session
envelope to `/v1/sessions`, receives a short-lived session-scoped token, and
posts ordered batches to `/v1/telemetry/batches`. Each record carries `tier`,
and the service routes on it. `recordId` stays `sessionId:sequence` across all
tiers from the single recorder sequence, so ordering and idempotency are
unchanged and a consumer can interleave tiers deterministically.

Pub/Sub ordering key stays `sessionId`. Ordering is per topic, so a tier is
ordered within itself, which is what each consumer needs.

## BigQuery

### Landing

Each tier has a Pub/Sub BigQuery subscription writing to a raw table with the
subscription's standard columns plus the message as JSON:

```
raw_live(subscription_name, message_id, publish_time, data JSON, attributes JSON)
raw_engineering(…)
raw_events(…)
```

No transform code runs at ingest. The subscription is managed by Google, which
removes a Cloud Run consumer from the critical path and from the failure
surface. Raw tables are partitioned on `publish_time` with a 30-day expiry.

### Curated tables

Scheduled queries (or materialized views where the shape allows) flatten the
raw tables into typed, deduplicated tables, keyed on `record_id`:

```
sessions(session_id, user_id, display_name, game_version, session_type,
         track_id, circuit_name, seed, configured_laps, created_at,
         ended_at, end_reason, completed_laps, classified)
car_samples(record_id, session_id, sequence, sim_time_s, race_time_s, phase,
            race_control_state, wetness, track_grip, driver_id, team_id,
            is_player, position, lap, track_sample_index, pos_x, pos_z,
            speed_kph, gap_to_leader_s, interval_s, last_lap_s, best_lap_s,
            tyre_compound, tyre_wear, pit_state, pit_stops, penalty_s,
            finished, dnf)
player_engineering(record_id, session_id, sequence, sim_time_s, …,
                   wheels ARRAY<STRUCT<key, slip_ratio, slip_angle,
                   normal_load_n, surface_temp_c, carcass_temp_c, pressure_kpa,
                   suspension_deflection_m, contact>>)
race_events(record_id, session_id, sequence, sim_time_s, race_time_s, event,
            driver_id, lap, payload JSON)
laps(session_id, driver_id, lap_number, lap_time_s, sector1_s, sector2_s,
     sector3_s, compound, tyre_age_laps, is_personal_best)
results(session_id, position, driver_id, team_id, status, laps, best_lap_s,
        penalty_s, points, failure_cause)
```

`laps` and `results` are derived from `race_events` (`lap_completed`,
`sector_completed`, `race_finished`) rather than captured separately, so the
event stream stays the single source of truth for timing.

All curated tables are partitioned by `DATE(sim_date)` — the session's
`created_at` date — and clustered by `session_id`, then `driver_id` where the
table has one. A dashboard filters by session, which the clustering serves
directly; cross-session analysis filters by date, which the partitioning serves.

Deduplication is a `MERGE` on `record_id`, since Pub/Sub is at-least-once and
`recordId` is the idempotency key the publisher already sets as an attribute.

### Freshness

Scheduled queries at 5-minute intervals are enough for post-session analysis.
A live dashboard reads a view over the raw `live` table directly, where rows
appear within seconds of publication, and falls back to the curated table for
anything older than the current session. No streaming job is required for the
demo.

## Client behaviour

- The recorder keeps one 20 Hz all-car snapshot and projects tiers from it.
- `live` is emitted every 4th snapshot at 5 Hz (every 2nd at 10 Hz); the divisor
  is derived from the sample rate so the tiers stay phase-locked.
- `engineering` is emitted every snapshot, player only.
- `events` are emitted as detected, never sampled.
- The uplink sends all tiers on one connection in sequence order.
- The archive tier is what IndexedDB already stores. With the retention added
  in `fix(telemetry)`, three sessions are kept locally; an opt-in upload at
  session end is a later slice.

## What this does not decide

- GCS archive upload (signed URL, compression, resumability) is a later slice.
- A live dashboard UI and its hosting are a later slice.
- Firestore or another low-latency store for sub-second live state is not
  needed while the dashboard reads BigQuery at a few seconds of latency.
