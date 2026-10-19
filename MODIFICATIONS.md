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
- Retained `LICENSE`, the upstream copyright in `NOTICE`, third-party notices,
  asset provenance and the upstream trademark disclaimer.

Future team customisation will be an additive organisation/team configuration
layer. It will not silently replace the upstream fictional championship.
