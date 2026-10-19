// A complete local stand-in for the cloud: it accepts the game's telemetry
// uplink, keeps the session in memory, and serves the dashboard contract.
// It exists so the dashboards can be built and demonstrated with no GCP
// project, and so a team has a working reference to compare their own serving
// layer against. Nothing here is meant for production — there is no auth, no
// durability, and one process holds every session.
//
//   node tools/contract-server.mjs                 # live ingest + dashboards
//   node tools/sim-telemetry.mjs monza 3           # produce a fixture, then
//   node tools/contract-server.mjs                 # replay it alongside
//
// Ingest (the game's existing uplink contract):
//   POST /v1/sessions              → { token, ingestUrl, expiresAt, limits }
//   POST /v1/telemetry/batches     → { accepted, firstSequence, lastSequence }
//
// Dashboards (contract v1):
//   GET /api/v1/sessions
//   GET /api/v1/live/:sessionId    text/event-stream
//   GET /api/v1/race/:sessionId
//   GET /api/v1/health

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRaceReport, createLiveState, applyRecord } from '../dashboards/src/contract.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = path.resolve(process.env.FIXTURE_DIR || path.join(root, 'tools/telemetry-fixture'));
const port = Number(process.env.PORT || 8365);

// ---- fixture replay (optional) ----
function readTier(tier) {
  const file = path.join(fixtureDir, `${tier}.ndjson`);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}
const fixture = [...readTier('live'), ...readTier('engineering'), ...readTier('events')]
  .sort((a, b) => a.sequence - b.sequence);
const fixtureId = fixture[0]?.sessionId || null;

// ---- live sessions ----
const sessions = new Map();

function session(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      sessionId,
      envelope: null,
      records: [],
      events: [],
      state: createLiveState(sessionId),
      subscribers: new Set(),
      seen: new Set(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }
  return sessions.get(sessionId);
}

function publish(entry) {
  const payload = `data: ${JSON.stringify({ ...entry.state, servedAt: Date.now() })}\n\n`;
  for (const subscriber of entry.subscribers) subscriber.write(payload);
}

function ingest(entry, records) {
  let accepted = 0;
  for (const record of records) {
    // Pub/Sub and a retrying client both deliver twice; recordId is the
    // idempotency key the producer guarantees.
    if (entry.seen.has(record.recordId)) continue;
    entry.seen.add(record.recordId);
    entry.records.push(record);
    if (record.tier === 'events') entry.events.push(record);
    applyRecord(entry.state, record);
    accepted += 1;
  }
  if (accepted) {
    entry.updatedAt = Date.now();
    publish(entry);
  }
  return accepted;
}

// ---- http ----
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type,authorization',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
};
const json = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS });
  response.end(JSON.stringify(body));
};

async function readJson(request, limit = 8 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('payload too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function sessionList() {
  const live = [...sessions.values()].map(entry => ({
    sessionId: entry.sessionId,
    sessionType: entry.state.sessionType,
    driver: entry.envelope?.user || null,
    circuit: entry.state.circuit,
    status: entry.state.status,
    configuredLaps: entry.state.configuredLaps,
    durationSeconds: entry.state.simulationTimeSeconds,
    recordCount: entry.records.length,
    updatedAt: new Date(entry.updatedAt).toISOString(),
  }));
  if (fixtureId && !sessions.has(fixtureId)) {
    const started = fixture.find(record => record.event === 'session_started');
    live.push({
      sessionId: fixtureId,
      sessionType: started?.sessionType || 'race',
      driver: null,
      circuit: started?.circuit || null,
      status: 'finished',
      configuredLaps: started?.configuredLaps ?? null,
      durationSeconds: fixture.at(-1)?.simulationTimeSeconds || 0,
      recordCount: fixture.length,
      fixture: true,
    });
  }
  // Most recently active first: a dashboard opened mid-race wants this one.
  return live.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

function streamFixture(request, response, id) {
  const url = new URL(request.url, 'http://localhost');
  const speed = Math.max(0.1, Math.min(50, Number(url.searchParams.get('speed') || 1)));
  const from = Math.max(0, Number(url.searchParams.get('from') || 0));
  const records = fixture.filter(record => record.sessionId === id);
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', ...CORS });

  const state = createLiveState(id);
  let index = 0;
  while (index < records.length && (records[index].simulationTimeSeconds || 0) < from) applyRecord(state, records[index++]);
  response.write(`data: ${JSON.stringify({ ...state, servedAt: Date.now() })}\n\n`);

  const startedAt = Date.now();
  const timer = setInterval(() => {
    const simNow = from + ((Date.now() - startedAt) / 1000) * speed;
    let changed = false;
    while (index < records.length && (records[index].simulationTimeSeconds || 0) <= simNow) {
      applyRecord(state, records[index++]);
      changed = true;
    }
    if (changed) response.write(`data: ${JSON.stringify({ ...state, servedAt: Date.now() })}\n\n`);
    if (index >= records.length) {
      clearInterval(timer);
      response.write('event: end\ndata: {}\n\n');
      response.end();
    }
  }, 100);
  request.on('close', () => clearInterval(timer));
}

function streamLive(request, response, entry) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', ...CORS });
  response.write(`data: ${JSON.stringify({ ...entry.state, servedAt: Date.now() })}\n\n`);
  entry.subscribers.add(response);
  // Browsers and proxies drop an idle event stream; a comment keeps it warm
  // between samples without reaching the dashboard's parser.
  const keepAlive = setInterval(() => response.write(': keep-alive\n\n'), 15000);
  request.on('close', () => {
    clearInterval(keepAlive);
    entry.subscribers.delete(response);
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const route = url.pathname;

  if (request.method === 'OPTIONS') {
    response.writeHead(204, CORS);
    return response.end();
  }

  // ---- ingest ----
  if (request.method === 'POST' && route === '/v1/sessions') {
    try {
      const envelope = await readJson(request);
      const entry = session(envelope.sessionId);
      entry.envelope = envelope;
      entry.state.sessionType = envelope.sessionType || entry.state.sessionType;
      console.log(`[contract] session ${envelope.sessionId} (${envelope.sessionType}) from ${envelope.user?.displayName || 'driver'}`);
      return json(response, 201, {
        sessionId: envelope.sessionId,
        userId: envelope.user?.id,
        token: `local.${envelope.sessionId}`,
        ingestUrl: `/v1/telemetry/batches`,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        limits: { maxBatchRecords: 500, maxBodyBytes: 8 * 1024 * 1024 },
      });
    } catch (error) {
      return json(response, 400, { error: 'bad_envelope', detail: error.message });
    }
  }

  if (request.method === 'POST' && route === '/v1/telemetry/batches') {
    try {
      const batch = await readJson(request);
      const entry = session(batch.sessionId);
      const accepted = ingest(entry, batch.records || []);
      return json(response, 202, {
        accepted,
        firstSequence: batch.records?.[0]?.sequence ?? null,
        lastSequence: batch.records?.at(-1)?.sequence ?? null,
      });
    } catch (error) {
      return json(response, 400, { error: 'bad_batch', detail: error.message });
    }
  }

  // ---- dashboard contract ----
  if (route === '/api/v1/health') {
    return json(response, 200, {
      status: 'ok',
      contract: 'v1',
      sessions: sessions.size + (fixtureId ? 1 : 0),
      ingestLagSeconds: 0,
    });
  }
  if (route === '/api/v1/sessions') return json(response, 200, { sessions: sessionList() });

  const liveMatch = route.match(/^\/api\/v1\/live\/(.+)$/);
  if (liveMatch) {
    const id = decodeURIComponent(liveMatch[1]);
    if (sessions.has(id)) return streamLive(request, response, sessions.get(id));
    if (id === fixtureId) return streamFixture(request, response, id);
    // A dashboard can legitimately open before the first record arrives.
    return streamLive(request, response, session(id));
  }

  const raceMatch = route.match(/^\/api\/v1\/race\/(.+)$/);
  if (raceMatch) {
    const id = decodeURIComponent(raceMatch[1]);
    const events = sessions.has(id)
      ? sessions.get(id).events
      : fixture.filter(record => record.sessionId === id && record.tier === 'events');
    if (!events.length) return json(response, 404, { error: 'unknown_session' });
    return json(response, 200, buildRaceReport(events, { sessionId: id }));
  }

  // ---- static dashboards ----
  // The dashboards reference their assets relatively, so the root redirects
  // rather than serving index.html from a path its assets do not sit under.
  if (route === '/' || route === '/dashboards' || route === '/dashboards/') {
    response.writeHead(302, { location: `/dashboards/index.html${url.search}` });
    return response.end();
  }
  const filePath = path.join(root, route);
  if (!filePath.startsWith(root) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return json(response, 404, { error: 'not_found' });
  }
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
  response.writeHead(200, {
    'content-type': types[path.extname(filePath)] || 'application/octet-stream',
    'cache-control': 'no-store',
    ...CORS,
  });
  fs.createReadStream(filePath).pipe(response);
});

server.listen(port, () => {
  // PORT=0 asks the OS for a free port, so report the bound one.
  const bound = server.address().port;
  console.log(`[contract] dashboards   http://127.0.0.1:${bound}/`);
  console.log(`[contract] post-race    http://127.0.0.1:${bound}/dashboards/post-race.html`);
  console.log(`[contract] game ingest  http://127.0.0.1:${bound}  (point the game at this with ?telemetry=)`);
  if (fixtureId) console.log(`[contract] fixture      ${fixtureId} — ${fixture.length} records`);
});
