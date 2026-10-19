import { assertProductionConfig, loadConfig } from './config.js';
import { createHttpServer } from './app.js';
import { PubSubPublisher } from './publisher.js';

const config = loadConfig();
assertProductionConfig(config);
const publisher = new PubSubPublisher(config);
const server = createHttpServer({ config, publisher });

server.listen(config.port, '0.0.0.0', () => {
  console.log(JSON.stringify({ severity: 'INFO', message: 'telemetry ingest listening', port: config.port }));
});

const shutdown = signal => {
  console.log(JSON.stringify({ severity: 'INFO', message: 'shutting down', signal }));
  server.close(error => process.exit(error ? 1 : 0));
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
