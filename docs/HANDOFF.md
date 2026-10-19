# Formula Racing Live hand-off

Updated: 2026-10-19

## Current state

The repository is a history-preserving Apache-2.0 fork of APEX FORMULA 2026 on
branch `codex/telemetry-foundation`. Product-facing identity is Formula Racing
Live. Upstream licensing, copyright, third-party notices, trademark guidance,
fictional teams, tracks, assets, physics, and gameplay remain intact.

The first telemetry vertical slice is implemented:

- editable racer name with a stable opaque UUID;
- a new UUID for every qualifying/race session;
- authoritative 20 Hz telemetry for every participating car;
- transition events for laps, sectors, position, pits, penalties, finishes,
  retirements, and final classification;
- IndexedDB persistence with an in-memory fallback;
- JSON and NDJSON serialization, plus JSON download from Results;
- Node contract tests and real-browser coverage against a 22-car session.

## Verified commands

```bash
npm run check:opensource
npm run test:telemetry
npm run test:simulation-contract
npm run test:build-script
npm run build
npx playwright test tests/browser/game.spec.mjs \
  --grep "driver profile keeps|live race session records" \
  --project=desktop-chromium
```

## Next slice: secure GCP transport

Use `formula-racing-live.telemetry.v1` from `TELEMETRY_CONTRACT.md` as the
browser-to-cloud contract. Add a backend endpoint that creates short-lived,
session-scoped ingest credentials. The public game must never contain a static
GCP credential or permanent bearer token. Upload should batch records, preserve
`recordId` for idempotency, retry safely with backoff, and retain IndexedDB data
until the backend acknowledges it.

No live GCP resources, pushes, or pull requests have been created.
