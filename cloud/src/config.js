const integer = (value, fallback, minimum, maximum) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
};

export function loadConfig(env = process.env) {
  return {
    port: integer(env.PORT, 8080, 1, 65535),
    projectId: env.GCP_PROJECT_ID || env.GOOGLE_CLOUD_PROJECT || '',
    topic: env.PUBSUB_TOPIC || 'formula-racing-live-telemetry',
    tokenSecret: env.TELEMETRY_TOKEN_SECRET || '',
    tokenTtlSeconds: integer(env.TELEMETRY_TOKEN_TTL_SECONDS, 900, 60, 3600),
    allowedOrigins: new Set((env.TELEMETRY_ALLOWED_ORIGINS || '')
      .split(',').map(value => value.trim()).filter(Boolean)),
    maxBatchRecords: integer(env.TELEMETRY_MAX_BATCH_RECORDS, 100, 1, 500),
    maxBodyBytes: integer(env.TELEMETRY_MAX_BODY_BYTES, 1_048_576, 16_384, 5_242_880),
    tokenIssuer: 'formula-racing-live-ingest',
    tokenAudience: 'formula-racing-live-telemetry',
  };
}

export function assertProductionConfig(config) {
  if (Buffer.byteLength(config.tokenSecret, 'utf8') < 32) {
    throw new Error('TELEMETRY_TOKEN_SECRET must contain at least 32 bytes');
  }
  if (!config.allowedOrigins.size) {
    throw new Error('TELEMETRY_ALLOWED_ORIGINS must contain at least one browser origin');
  }
}
