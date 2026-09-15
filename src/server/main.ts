/**
 * Entry point.
 *
 * The database lives next to the code by default so that "where is my data" has an obvious answer;
 * `CT_DATA` moves it, and the container sets it to a volume.
 */

import { fileURLToPath } from 'node:url';

import { createApp, start, stop } from './server.ts';

const databasePath =
  process.env.CT_DATA ?? fileURLToPath(new URL('../../data/churn-tracker.db', import.meta.url));

const app = createApp(databasePath);
const server = start(app);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      stop(app);
      app.store.close();
      process.exit(0);
    });
  });
}
