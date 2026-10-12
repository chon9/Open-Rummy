/**
 * Entry point: load config from the environment, start the server and shut it
 * down gracefully on SIGTERM/SIGINT (WebSockets closed with 1001, HTTP stopped).
 */
import { startServer } from './app';
import { loadConfig } from './config';

/* eslint-disable no-console */

function describe(e: unknown): unknown {
  return e instanceof Error ? (e.stack ?? e.message) : e;
}

// Rooms live in memory: a crash would end every running game. A stray exception or
// rejection in one handler is logged and the process keeps serving; the per-room
// state it touched is at worst one broken game, which the room GC cleans up.
process.on('uncaughtException', (e) => {
  console.error(new Date().toISOString(), 'uncaughtException:', describe(e));
});
process.on('unhandledRejection', (reason) => {
  console.error(new Date().toISOString(), 'unhandledRejection:', describe(reason));
});

async function main(): Promise<void> {
  const cfg = loadConfig();
  const server = await startServer(cfg);

  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received, shutting down`);
    // Hard exit if something keeps the loop alive for too long.
    setTimeout(() => process.exit(1), 5000).unref();
    server.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

main().catch((e: unknown) => {
  console.error('Failed to start server:', e instanceof Error ? e.message : e);
  process.exit(1);
});
