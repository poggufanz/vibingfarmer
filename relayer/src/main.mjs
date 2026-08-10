// Backward-compatible entry point for older VM scripts. Keep startup behavior delegated to the
// import-safe runner so errors use stable safe codes and no listener is opened on module import.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runRelayer } from '../server-runner.mjs';

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void runRelayer();
}
