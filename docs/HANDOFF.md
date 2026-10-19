# Formula Racing Live hand-off

Updated: 2026-10-19

## Current state

The repository is a history-preserving Apache-2.0 fork of APEX FORMULA 2026 on
branch `codex/telemetry-foundation`. Product-facing identity is Formula Racing
Live. Upstream licensing, copyright, third-party notices, trademark guidance,
fictional teams, tracks, assets, physics, and gameplay remain intact.

The telemetry and GCP-ready vertical slice is implemented:

- editable racer name with a stable opaque UUID;
- a new UUID for every qualifying/race session;
- authoritative 20 Hz telemetry for every participating car;
- transition events for laps, sectors, position, pits, penalties, finishes,
  retirements, and final classification;
- IndexedDB persistence with an in-memory fallback;
- JSON and NDJSON serialization, plus JSON download from Results;
- Node contract tests and real-browser coverage against a 22-car session;
- `sessionType` (`race`/`qualifying`/`time_trial`) on the envelope, every
  record and the ingest API; the real venue name; a `session_ended` event with
  the termination reason and the laps actually completed; documented units;
  IndexedDB retention of the three newest sessions with no in-memory duplicate.
- optional 250 ms browser batching with bounded retries and token renewal;
- a Cloud Run ingest service that publishes session envelopes and records to
  Pub/Sub with stable idempotency attributes;
- Docker and Terraform deployment definitions under `cloud/`.

## Verified commands

```bash
npm run check:opensource
npm run test:telemetry
npm run test:cloud
npm run test:simulation-contract
npm run test:build-script
npm run build
npx playwright test tests/browser/game.spec.mjs \
  --grep "driver profile keeps|live race session records" \
  --project=desktop-chromium
```

Tiering is implemented end to end in code: `js/raceTelemetry.js` projects the
tiers, `js/telemetryUplink.js` streams all but `archive`, `cloud/src` validates
and routes per tier, `cloud/terraform/tiers.tf` creates the topics, BigQuery
dataset, landing tables and subscriptions, and `cloud/bigquery/*.sql` holds the
curated schema, the 5-minute merge queries and the near-live timing view.
Nothing has been applied to a GCP project.

The challenge this platform exists to run is scoped in
`docs/challenge/gcp-racing-challenge.md`: participants pick their own GCP
services, the game and the two dashboards are fixed, and architecture A (the
one implemented here) is the baseline we validate first.

## Next slice: authorized deployment

Follow `cloud/README.md` to build the image, bootstrap the Secret Manager
container, add the signing-secret version outside Terraform state, and apply
the Cloud Run/Pub/Sub resources. Then set the game endpoint and allowed origin
and run the browser-to-Pub/Sub smoke test. The public game must never contain a
static GCP credential or permanent bearer token.

No live GCP resources, pushes, or pull requests have been created.
