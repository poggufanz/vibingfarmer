import { describe, expect, it } from 'vitest';

describe('agent index durable reporter configuration', () => {
  // Defect caught: intent/lifecycle callers could disagree on action URLs or authenticate against a non-canonical endpoint.
  it('derives fixed intent and lifecycle action URLs from one canonical reporter endpoint', async () => {
    const { createAgentIndexConfig } = await import('../src/agentIndexConfig.mjs');
    const config = createAgentIndexConfig({
      endpoint: 'https://app.example/api/agent-index',
      secret: 'server-only-secret',
      schemaVersion: 1,
      dbPath: '/var/lib/vf/relayer.db',
      relayerOrigin: 'https://relay.example',
      production: true,
    });
    expect(config).toMatchObject({
      intentUrl: 'https://app.example/api/agent-index?action=base-child-intent',
      lifecycleUrl: 'https://app.example/api/agent-index?action=base-child-lifecycle',
      schemaVersion: 1,
      ready: true,
    });
    expect(JSON.stringify(config)).not.toContain('server-only-secret');
    expect(config.secret).toBe('server-only-secret');
  });

  // Defect caught: production could start with transient jobs or an unauthenticated/unversioned reporter.
  it.each([
    ['RELAYER_DB_PATH', { dbPath: '' }],
    ['AGENT_INDEX_REPORTER_URL', { endpoint: '' }],
    ['AGENT_INDEX_REPORTER_SECRET', { secret: '' }],
    ['RELAYER_PUBLIC_ORIGIN', { relayerOrigin: '' }],
    ['AGENT_INDEX_REPORTER_SCHEMA', { schemaVersion: 2 }],
  ])('fails closed when production lacks valid %s readiness', async (name, changed) => {
    const { createAgentIndexConfig } = await import('../src/agentIndexConfig.mjs');
    expect(() => createAgentIndexConfig({
      endpoint: 'https://app.example/api/agent-index',
      secret: 'server-only-secret',
      schemaVersion: 1,
      dbPath: '/var/lib/vf/relayer.db',
      relayerOrigin: 'https://relay.example',
      production: true,
      ...changed,
    })).toThrow(new RegExp(name));
  });

  // Defect caught: a presence-only check accepted SQLite memory URIs in production, so every
  // accepted intent/work row disappeared on restart.
  it.each([':memory:', 'file::memory:', 'file:relayer?mode=memory']) (
    'rejects ephemeral production SQLite path %s',
    async (dbPath) => {
      const { createAgentIndexConfig } = await import('../src/agentIndexConfig.mjs');
      expect(() => createAgentIndexConfig({
        endpoint: 'https://app.example/api/agent-index',
        secret: 'server-only-secret',
        schemaVersion: 1,
        dbPath,
        relayerOrigin: 'https://relay.example',
        production: true,
      })).toThrow(/RELAYER_DB_PATH|ephemeral|memory/i);
    },
  );
});
