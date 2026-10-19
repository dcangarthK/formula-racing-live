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
- [x] Verified the telemetry contract with 13 Node tests and live Chromium coverage
  using a real 22-car `RaceSession`.
- [ ] Add the secure GCP transport after the local telemetry contract is verified.
- [ ] Add optional organisation/team customisation as a later, additive feature.

## Current hand-off

- Working branch: `codex/telemetry-foundation`
- Branding baseline commit: `3fbf70b`
- The local telemetry vertical slice follows that baseline on the working branch.
- No GCP credentials or permanent ingest tokens belong in this public client.
- Next build slice: authenticated short-lived ingest session, buffered upload,
  retry/idempotency, and a GCP receiver for `formula-racing-live.telemetry.v1`.

Implementation scope and attribution are recorded in [`../MODIFICATIONS.md`](../MODIFICATIONS.md).
