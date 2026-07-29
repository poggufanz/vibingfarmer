import { describe, it, expect } from 'vitest';
import { runtimeServerConfig } from '../src/server.mjs';

describe('runtimeServerConfig', () => {
  it('uses the validated config object and never ambient process.env values', () => {
    const config = {
      publicOrigin: 'https://canonical-relay.example',
      reporter: {
        url: 'https://canonical-app.example/api/agent-index',
        schema: 1,
        hasSecret: true,
      },
      secrets: { proxyAuth: true },
      runtime: {
        proxyKey: 'canonical-proxy-secret',
        reporterSecret: 'canonical-reporter-secret',
        debugErrors: false,
      },
      publicRuntime: { readiness: { ready: true }, digests: { deployments: 'a'.repeat(64) } },
    };
    const got = runtimeServerConfig(config);
    expect(got).toEqual({
      relayerOrigin: 'https://canonical-relay.example',
      reporterEndpoint: 'https://canonical-app.example/api/agent-index',
      reporterSchema: 1,
      reporterSecret: 'canonical-reporter-secret',
      proxyKey: 'canonical-proxy-secret',
      sanitizeErrors: true,
      publicRuntime: config.publicRuntime,
    });
  });
});
