import { describe, it, expect, vi } from 'vitest';
import { syncAgentIndex } from '../src/agentIndex.js';

function logs(spy) {
  return spy.mock.calls.map(([line]) => JSON.parse(line));
}

describe('syncAgentIndex', () => {
  it('skips (no fetch call) when AGENT_INDEX_URL is unset', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetchImpl = vi.fn();
    await syncAgentIndex({ AGENT_INDEX_INGEST_SECRET: 's' }, fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logs(log)[0]).toMatchObject({ tick: 'agent-index-skip' });
    log.mockRestore();
  });

  it('skips when AGENT_INDEX_INGEST_SECRET is unset', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetchImpl = vi.fn();
    await syncAgentIndex({ AGENT_INDEX_URL: 'https://app/api/agent-index' }, fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('POSTs ?action=ingest with a bearer secret and logs the outcome on success', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetchImpl = vi.fn(async (url, init) => {
      expect(url).toBe('https://app/api/agent-index?action=ingest');
      expect(init.method).toBe('POST');
      expect(init.headers.Authorization).toBe('Bearer topsecret');
      return { ok: true, status: 200, json: async () => ({ ok: 5, failed: 0, results: [] }) };
    });
    await syncAgentIndex(
      { AGENT_INDEX_URL: 'https://app/api/agent-index', AGENT_INDEX_INGEST_SECRET: 'topsecret' },
      fetchImpl
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(logs(log)[0]).toMatchObject({ tick: 'agent-index-synced', ok: 5, failed: 0 });
    log.mockRestore();
  });

  it('logs and swallows a non-OK response — never throws', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: 'Unauthorized' }) }));
    await expect(
      syncAgentIndex({ AGENT_INDEX_URL: 'https://app/api/agent-index', AGENT_INDEX_INGEST_SECRET: 'x' }, fetchImpl)
    ).resolves.toBeUndefined();
    expect(logs(log)[0]).toMatchObject({ tick: 'agent-index-failed', status: 401 });
    log.mockRestore();
  });

  it('logs and swallows a network error — never throws', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    await expect(
      syncAgentIndex({ AGENT_INDEX_URL: 'https://app/api/agent-index', AGENT_INDEX_INGEST_SECRET: 'x' }, fetchImpl)
    ).resolves.toBeUndefined();
    expect(logs(log)[0]).toMatchObject({ tick: 'agent-index-error' });
    expect(logs(log)[0].error).toMatch(/network down/);
    log.mockRestore();
  });
});
