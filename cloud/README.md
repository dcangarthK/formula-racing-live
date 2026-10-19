# Formula Racing Live telemetry ingest

Status: backend implemented; 11 local tests pass, dependency audit reports zero vulnerabilities, and Terraform validates. It has not been deployed. The browser uploader is intentionally a separate integration step.

This directory is the GCP boundary for `formula-racing-live.telemetry.v1`. It contains a dependency-light Node HTTP service for Cloud Run, a Pub/Sub publisher, tests with an in-memory publisher, and an optional Terraform deployment template. No GCP credential or permanent signing secret is sent to the game.

## Request flow

1. The game creates its existing telemetry session envelope.
2. `POST /v1/sessions` validates and publishes the full envelope (including display name and metadata), then returns a 15-minute HMAC-signed bearer token scoped to exactly one `sessionId` and `userId`.
3. The game sends ordered batches to `POST /v1/telemetry/batches` with that bearer token.
4. The service validates schema, token binding, record IDs, sequence order, record count, and request size, then publishes one Pub/Sub message per record.
5. Pub/Sub consumers deduplicate records by the `idempotencyKey`/`recordId` attribute and session envelopes by `session:<sessionId>`. Pub/Sub delivery remains at-least-once.

The session endpoint is browser-facing and therefore does not accept a permanent API key. CORS is an additional browser boundary, not authentication. For a public launch, put Cloud Armor/API Gateway rate controls or an application attestation check in front of the service. Tokens have narrow scope and short lifetime to limit abuse.

The current game `userId` is an anonymous, client-generated profile identifier, not an authenticated account claim. If team accounts are added later, the session endpoint should verify the platform login token and derive `userId` server-side rather than trusting the envelope value.

## Endpoints

- `GET /healthz`
- `POST /v1/sessions` — body is the session envelope from `createSessionEnvelope()`; the envelope is published before a token is issued, so telemetry always has durable identity/session context downstream.
- `POST /v1/telemetry/batches` — bearer token plus `{ schemaVersion, sessionId, userId, records }`; returns `202` after Pub/Sub accepts the messages.

Default limits are 100 records and 1 MiB per batch. They are configurable within guarded ranges; see `.env.example`.
`schemaVersion` is required both on the batch wrapper and every record. A client may renew its 15-minute token by calling the session endpoint again; on an ingest `401` with `expired_token`, renew once and retry the unchanged batch. Stable record and session idempotency keys make those retries safe for a deduplicating consumer.

## Local development

```sh
npm ci
npm test
cp .env.example .env
set -a; . ./.env; set +a
npm start
```

For local Pub/Sub, set `PUBSUB_EMULATOR_HOST=127.0.0.1:8085`. Application Default Credentials are used when no emulator is configured.

Example session request:

```sh
curl -sS http://localhost:8080/v1/sessions \
  -H 'content-type: application/json' \
  -H 'origin: http://localhost:8000' \
  --data '{"schemaVersion":"formula-racing-live.telemetry.v1","sessionId":"83af3bca-4ac3-4ccf-a5b6-a63c3e825196","user":{"id":"0c469c68-aea2-45c1-9f6f-a545a058d918","displayName":"Driver"},"game":"Formula Racing Live","createdAt":"2026-10-19T12:00:00.000Z","metadata":{}}'
```

## Container and deployment

Build from this directory:

```sh
docker build -t REGION-docker.pkg.dev/PROJECT/REPOSITORY/formula-racing-live-ingest:TAG .
```

The Terraform module provisions the Pub/Sub topic, least-privilege runtime service account, Secret Manager secret container, and Cloud Run service. It does not create a secret version, so the signing key never enters Terraform state:

```sh
cd terraform
terraform init
terraform apply -target=google_secret_manager_secret.token_secret \
  -var='project_id=PROJECT' \
  -var='image=REGION-docker.pkg.dev/PROJECT/REPOSITORY/formula-racing-live-ingest:TAG' \
  -var='allowed_origins=https://game.example.com'
openssl rand -base64 48 | gcloud secrets versions add formula-racing-live-token-secret --data-file=- --project PROJECT
terraform apply -var='project_id=PROJECT' \
  -var='image=REGION-docker.pkg.dev/PROJECT/REPOSITORY/formula-racing-live-ingest:TAG' \
  -var='allowed_origins=https://game.example.com'
```

The targeted first apply creates only the Secret Manager container and its required API; adding the secret version before the full apply allows Cloud Run to create a healthy revision without putting the signing key in Terraform state. Set `allow_public_invocation=false` if an authenticated API gateway is the public entrypoint. No deployment, project mutation, or secret creation has been performed by this repository work.
