# Formula Racing Live progress

## Fork baseline — 2026-10-19

- [x] Forked from `ahacker-1/apex-formula-2026` with complete Git history.
- [x] Retained upstream as the read-only `upstream` remote.
- [x] Adopted the working product name **Formula Racing Live**.
- [x] Preserved Apache-2.0, upstream `NOTICE`, third-party notices, trademark
  disclaimer and asset provenance.
- [x] Preserved simulation behaviour, fictional teams, drivers, circuits and assets.
- [x] Added persistent human identity and a distinct session ID per race launch.
- [x] Added a durable 20 Hz all-car telemetry stream plus lap, sector, position,
  pit, penalty, finish, DNF and final-classification events.
- [x] Added JSON export from the Results screen and IndexedDB persistence while racing.
- [x] Verified identity, capture, and uplink with 23 Node tests plus live Chromium
  coverage using a real 22-car `RaceSession`.
- [x] Added a configurable browser uplink with 250 ms batching, bounded retry,
  token renewal, idempotent record IDs, and safe local fallback.
- [x] Added a tested Cloud Run ingest service, Pub/Sub publisher, Docker image,
  and Terraform template (11 tests) without deploying or embedding GCP credentials.
- [ ] Deploy the GCP stack, create the signing-secret version, configure the game
  endpoint/origin, and run the live smoke test in the chosen GCP project.
- [ ] Add optional organisation/team customisation as a later, additive feature.

## Current hand-off

- Working branch: `codex/telemetry-foundation`
- Branding baseline commit: `3fbf70b`
- The local telemetry vertical slice follows that baseline on the working branch.
- No GCP credentials or permanent ingest tokens belong in this public client.
- Next operational slice: authorized GCP deployment and end-to-end live smoke test.

Implementation scope and attribution are recorded in [`../MODIFICATIONS.md`](../MODIFICATIONS.md).
