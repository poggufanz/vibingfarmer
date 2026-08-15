// Legacy entry point intentionally quarantined. Importing this module performs
// no environment reads, RPC calls, wallet writes, broadcasts, or file writes.
export { deployHardenedStaging, validateDeploymentInputs } from './deploy-hardened.mjs';

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  throw new Error(
    'scripts/deploy.mjs no longer broadcasts. Import deployHardenedStaging with explicit injected clients and a non-canonical staging output.',
  );
}
