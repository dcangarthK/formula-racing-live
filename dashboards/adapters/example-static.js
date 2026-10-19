// Example adapter: the second way to feed the dashboards, for architectures
// with no serving layer of their own. The dashboards call this instead of the
// HTTP contract when the page is opened with
// `?adapter=/dashboards/adapters/example-static.js`.
//
// This one replays a static JSON file, which is the least interesting possible
// source — the point is the shape. A Firestore adapter is the same three
// methods: `listSessions`, `subscribeLive` and `getRace`, with
// `onSnapshot` driving `onState` instead of a timer.

import { applyRecord, buildRaceReport, createLiveState } from '../src/contract.js';

const DEFAULT_RECORDS = '/dashboards/adapters/example-race.json';

export default function createExampleAdapter(config = {}) {
  const url = config.records || DEFAULT_RECORDS;
  let cache = null;

  async function records() {
    if (!cache) cache = await (await fetch(url)).json();
    return cache;
  }

  return {
    async listSessions() {
      const all = await records();
      const started = all.find(record => record.event === 'session_started');
      return [{
        sessionId: all[0]?.sessionId || 'example',
        sessionType: started?.sessionType || 'race',
        circuit: started?.circuit || null,
        status: 'finished',
        configuredLaps: started?.configuredLaps ?? null,
        recordCount: all.length,
      }];
    },

    // A real adapter subscribes to a change feed. This one walks the recorded
    // stream on a timer so the live screen has something to render.
    subscribeLive(sessionId, onState) {
      let index = 0;
      const state = createLiveState(sessionId);
      const all = records();
      const timer = setInterval(async () => {
        const list = await all;
        if (index >= list.length) return clearInterval(timer);
        const until = Math.min(list.length, index + 20);
        while (index < until) applyRecord(state, list[index++]);
        onState({ ...state, servedAt: Date.now() });
      }, 200);
      return () => clearInterval(timer);
    },

    async getRace(sessionId) {
      const all = await records();
      return buildRaceReport(all.filter(record => record.tier === 'events'), { sessionId });
    },
  };
}
