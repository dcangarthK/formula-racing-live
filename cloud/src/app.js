import { createServer } from 'node:http';
import { issueSessionToken, verifySessionToken } from './token.js';
import { ValidationError, SCHEMA_VERSION, validateBatch, validateSessionEnvelope } from './validation.js';

function writeJson(response, status, body, extraHeaders = {}) {
  const data = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  response.end(data);
}

function applyCors(request, response, config) {
  const origin = request.headers.origin;
  if (!origin) return true;
  if (!config.allowedOrigins.has(origin)) return false;
  response.setHeader('access-control-allow-origin', origin);
  response.setHeader('vary', 'Origin');
  response.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  response.setHeader('access-control-allow-headers', 'Authorization,Content-Type');
  response.setHeader('access-control-max-age', '600');
  return true;
}

async function readJson(request, maxBytes) {
  const contentType = request.headers['content-type'] || '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    const error = new Error('content_type'); error.status = 415; throw error;
  }
  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    const error = new Error('body_too_large'); error.status = 413; throw error;
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maxBytes) {
      const error = new Error('body_too_large'); error.status = 413; throw error;
    }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { const error = new Error('invalid_json'); error.status = 400; throw error; }
}

function bearerToken(request) {
  const authorization = request.headers.authorization || '';
  const match = /^Bearer ([A-Za-z0-9._-]+)$/.exec(authorization);
  return match?.[1] || null;
}

export function createApp({ config, publisher, now = () => Math.floor(Date.now() / 1000), logger = console }) {
  return async function handler(request, response) {
    try {
      const url = new URL(request.url, 'http://service.local');
      if (!applyCors(request, response, config)) {
        writeJson(response, 403, { error: 'origin_not_allowed' }); return;
      }
      if (request.method === 'OPTIONS') {
        response.writeHead(204, { 'content-length': '0' }); response.end(); return;
      }
      if (request.method === 'GET' && url.pathname === '/healthz') {
        writeJson(response, 200, { status: 'ok', schemaVersion: SCHEMA_VERSION }); return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/sessions') {
        const envelope = validateSessionEnvelope(await readJson(request, config.maxBodyBytes));
        // Reissuing a token may republish this envelope. Consumers deduplicate
        // using the stable session:<sessionId> Pub/Sub attribute.
        await publisher.publishSession(envelope);
        const { token, payload } = issueSessionToken({ sessionId: envelope.sessionId, userId: envelope.user.id }, config, now());
        writeJson(response, 201, {
          schemaVersion: SCHEMA_VERSION,
          sessionId: envelope.sessionId,
          userId: envelope.user.id,
          token,
          tokenType: 'Bearer',
          expiresAt: new Date(payload.exp * 1000).toISOString(),
          ingestUrl: '/v1/telemetry/batches',
          limits: { maxBatchRecords: config.maxBatchRecords, maxBodyBytes: config.maxBodyBytes },
        });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/telemetry/batches') {
        let claims;
        try { claims = verifySessionToken(bearerToken(request), config, now()); }
        catch (error) {
          const code = error.message === 'expired_token' ? 'expired_token' : 'invalid_token';
          writeJson(response, 401, { error: code }, { 'www-authenticate': 'Bearer' }); return;
        }
        const body = await readJson(request, config.maxBodyBytes);
        const records = validateBatch(body, claims, config.maxBatchRecords);
        const messageIds = await publisher.publish(records);
        writeJson(response, 202, {
          accepted: records.length,
          firstSequence: records[0].sequence,
          lastSequence: records.at(-1).sequence,
          publishRequestId: messageIds[0] || null,
        });
        return;
      }
      writeJson(response, 404, { error: 'not_found' });
    } catch (error) {
      if (error instanceof ValidationError) {
        writeJson(response, 400, { error: 'validation_failed', message: error.message, field: error.field }); return;
      }
      if (error.status) {
        writeJson(response, error.status, { error: error.message }); return;
      }
      logger.error?.('telemetry request failed', { message: error.message, stack: error.stack });
      writeJson(response, 503, { error: 'publish_unavailable' });
    }
  };
}

export function createHttpServer(options) {
  return createServer(createApp(options));
}
