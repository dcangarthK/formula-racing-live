export class PubSubPublisher {
  constructor({ projectId, topic }) {
    this.projectId = projectId;
    this.topicName = topic;
    this.client = null;
    this.topic = null;
  }

  async _topic() {
    if (this.topic) return this.topic;
    const { PubSub } = await import('@google-cloud/pubsub');
    this.client = new PubSub(this.projectId ? { projectId: this.projectId } : {});
    this.topic = this.client.topic(this.topicName, {
      batching: { maxMessages: 100, maxMilliseconds: 25 },
      messageOrdering: true,
    });
    return this.topic;
  }

  async publish(records) {
    const topic = await this._topic();
    return Promise.all(records.map(record => topic.publishMessage({
      json: record,
      attributes: {
        schemaVersion: record.schemaVersion,
        recordId: record.recordId,
        sessionId: record.sessionId,
        userId: record.userId,
        sequence: String(record.sequence),
        recordType: record.type,
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
