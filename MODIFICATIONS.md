# Formula Racing Live modifications

This repository is a modified distribution of APEX FORMULA 2026, originally
published at <https://github.com/ahacker-1/apex-formula-2026> under Apache-2.0.
The upstream Git history and the `upstream` remote are retained.

## 2026-10-19 — fork baseline

- Changed the public product identity to **Formula Racing Live**.
- Preserved the upstream fictional teams, drivers, circuits, assets, physics,
  gameplay and simulation behaviour.
- Reserved the fork's implementation scope for player identity, local telemetry
  recording, real-time telemetry transport and the GCP data platform.
- Added an opaque persistent user ID, editable racing name, per-session IDs and
  an IndexedDB-backed 20 Hz all-car telemetry/event recorder with JSON export.
- Added an optional short-lived-token browser uplink and a separately deployable
  Cloud Run/Pub/Sub ingest service; no permanent cloud credential ships to users.
- Retained `LICENSE`, the upstream copyright in `NOTICE`, third-party notices,
  asset provenance and the upstream trademark disclaimer.

Future team customisation will be an additive organisation/team configuration
layer. It will not silently replace the upstream fictional championship.

## 2026-10-19 — telemetry contract corrections

- Declared `sessionType` (`race`, `qualifying`, `time_trial`) on the session
  envelope, on every record and on the ingest API, so a time trial is no longer
  indistinguishable from qualifying.
- Reported the venue name, which the circuit exposes as a non-enumerable
  property, instead of an empty `circuit.name`.
- Added a `session_ended` event carrying the termination reason and the laps
  actually completed; `metadata.configuredLaps` is now `null` for a time trial.
- Documented record units and the simulation clocks in `TELEMETRY_CONTRACT.md`.
- Bounded local storage: IndexedDB is written without an in-memory duplicate,
  and registering a session prunes all but the three newest sessions.

## 2026-10-19 — tiered telemetry feed

- Projected the 20 Hz all-car snapshot into `live` (all cars, slim, 5 Hz),
  `engineering` (player car, full detail, 20 Hz), `events` and a local-only
  `archive` tier, cutting the streamed volume for a 30-minute race from roughly
  1.9 GB to about 180 MB, measured with `tools/sim-telemetry.mjs`.
- Routed each tier to its own Pub/Sub topic, with BigQuery landing tables,
  curated tables, merge queries and a near-live timing view.
