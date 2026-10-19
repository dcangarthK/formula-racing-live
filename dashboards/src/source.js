// Where the dashboards get their data. The default source speaks the HTTP
// serving contract; an architecture with no serving layer — Firestore
// listeners, the Firebase SDK in the page — supplies an adapter module
// instead. Both are first class, and the screens cannot tell them apart.
//
//   ?api=https://my-service.run.app      use that serving layer
//   ?adapter=/adapters/firestore.js      load a custom adapter module
//
// An adapter module default-exports a factory returning:
//   { listSessions(), subscribeLive(sessionId, onState) -> unsubscribe, getRace(sessionId) }

export function sourceConfig(search = globalThis.location?.search || '') {
  const params = new URLSearchParams(search);
  return {
    api: params.get('api') || '',
    adapter: params.get('adapter') || '',
    sessionId: params.get('session') || '',
    speed: params.get('speed') || '',
    from: params.get('from') || '',
  };
}

export function createHttpSource({ api = '', speed = '', from = '' } = {}) {
  const base = api.replace(/\/$/, '');
  const url = path => `${base}/api/v1${path}`;

  return {
    kind: 'http',
    describe: () => base || 'same origin',
    async listSessions() {
      const response = await fetch(url('/sessions'));
      if (!response.ok) throw new Error(`sessions ${response.status}`);
      return (await response.json()).sessions || [];
    },
    async getRace(sessionId) {
      const response = await fetch(url(`/race/${encodeURIComponent(sessionId)}`));
      if (!response.ok) throw new Error(`race ${response.status}`);
      return response.json();
    },
    subscribeLive(sessionId, onState, onError) {
      const query = new URLSearchParams();
      if (speed) query.set('speed', speed);
      if (from) query.set('from', from);
      const suffix = query.toString() ? `?${query}` : '';
      const stream = new EventSource(url(`/live/${encodeURIComponent(sessionId)}${suffix}`));
      stream.onmessage = (message) => {
        try { onState(JSON.parse(message.data)); } catch (error) { onError?.(error); }
      };
      // A finished replay closes the stream; that is the end of the race, not
      // a failure, so it must not be reported as one.
      stream.addEventListener('end', () => stream.close());
      stream.onerror = () => {
        if (stream.readyState === EventSource.CLOSED) return;
        onError?.(new Error('live stream interrupted'));
      };
      return () => stream.close();
    },
  };
}

export async function createSource(config = sourceConfig()) {
  if (config.adapter) {
    const module = await import(config.adapter);
    const factory = module.default || module.createSource;
    if (typeof factory !== 'function') throw new Error('adapter must export a factory');
    const source = await factory(config);
    return { kind: 'adapter', describe: () => config.adapter, ...source };
  }
  return createHttpSource(config);
}
