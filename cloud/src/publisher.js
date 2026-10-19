export class PubSubPublisher {
  // One topic per tier, so an analytical consumer on the engineering feed can
  // never delay the live feed, and each tier carries its own retention.
  constructor({ projectId, topic, topics = {} }) {
    this.projectId = projectId;
    this.topicNames = {
      live: topics.live || topic,
      engineering: topics.engineering || topic,
      events: topics.events || topic,
    };
    this.client = null;
    this.topics = new Map();
  }

  async _topic(tier = 'events') {
    const name = this.topicNames[tier] || this.topicNames.events;
    const existing = this.topics.get(name);
    if (existing) return existing;
    if (!this.client) {
      const { PubSub } = await import('@google-cloud/pubsub');
      this.client = new PubSub(this.projectId ? { projectId: this.projectId } : {});
    }
    const topic = this.client.topic(name, {
      batching: { maxMessages: 100, maxMilliseconds: 25 },
      messageOrdering: true,
    });
    this.topics.set(name, topic);
    return topic;
  }

  async publish(records) {
    return Promise.all(records.map(async record => (await this._topic(record.tier)).publishMessage({
      json: record,
      attributes: {
        schemaVersion: record.schemaVersion,
        recordId: record.recordId,
        sessionId: record.sessionId,
        userId: record.userId,
        sequence: String(record.sequence),
        recordType: record.type,
        tier: record.tier || 'events',
        // Pub/Sub is at-least-once. Consumers use recordId as their idempotency key.
        idempotencyKey: record.recordId,
      },
      orderingKey: record.sessionId,
    })));
  }

  async publishSession(envelope) {
    const topic = await this._topic();
    const message = {
      messageType: 'session_created',
      schemaVersion: envelope.schemaVersion,
      sessionId: envelope.sessionId,
      userId: envelope.user.id,
      session: envelope,
    };
    return topic.publishMessage({
      json: message,
      attributes: {
        schemaVersion: envelope.schemaVersion,
        sessionId: envelope.sessionId,
        userId: envelope.user.id,
        recordType: 'session',
        idempotencyKey: `session:${envelope.sessionId}`,
      },
      orderingKey: envelope.sessionId,
    });
  }
}

export class MemoryPublisher {
  constructor() { this.messages = []; this.sessions = []; }
  async publish(records) {
    this.messages.push(...records.map(record => structuredClone(record)));
    return records.map(record => `memory:${record.recordId}`);
  }
  async publishSession(envelope) {
    this.sessions.push(structuredClone(envelope));
    return `memory:session:${envelope.sessionId}`;
  }
}
