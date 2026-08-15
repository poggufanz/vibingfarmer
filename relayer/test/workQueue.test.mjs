import { describe, expect, it, vi } from 'vitest';
import { createWorkQueue } from '../src/workQueue.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('createWorkQueue', () => {
  it('bounds active and pending work while isolating item failures', async () => {
    const started = [];
    const completed = [];
    const failures = [];
    const gates = new Map();
    const run = vi.fn(async (item) => {
      started.push(item.id);
      await new Promise((resolve) => gates.set(item.id, resolve));
      if (item.fail) throw new Error('injected item failure');
      completed.push(item.id);
    });
    const queue = createWorkQueue({
      concurrency: 2,
      maxPending: 2,
      run,
      onError: (error, item) => failures.push({ error, item }),
    });

    expect(queue.enqueue({ id: 'one' })).toBe(true);
    expect(queue.enqueue({ id: 'two', fail: true })).toBe(true);
    await vi.waitFor(() => expect(started).toHaveLength(2));
    expect(queue.enqueue({ id: 'three' })).toBe(true);
    expect(queue.enqueue({ id: 'four' })).toBe(true);
    expect(queue.enqueue({ id: 'five' })).toBe(false);
    expect(queue.active).toBe(2);
    expect(queue.pending).toBe(2);
    expect(queue.size).toBe(4);

    gates.get('one')();
    gates.get('two')();
    await vi.waitFor(() => expect(started).toContain('three'));
    gates.get('three')();
    await vi.waitFor(() => expect(started).toContain('four'));
    gates.get('four')();
    await queue.drain();

    expect(completed).toEqual(['one', 'three', 'four']);
    expect(failures).toHaveLength(1);
    expect(failures[0].item.id).toBe('two');
    expect(queue.size).toBe(0);
  });

  it('deduplicates running/queued identities and stops without scheduling cancelled work', async () => {
    const release = [];
    const run = vi.fn((item) => new Promise((resolve) => release.push(() => resolve(item.id))));
    const queue = createWorkQueue({ concurrency: 1, maxPending: 4, run });

    expect(queue.enqueue({ id: 'same' })).toBe(true);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(queue.enqueue({ id: 'same' })).toBe(false);
    expect(queue.enqueue({ id: 'queued' })).toBe(true);
    expect(queue.enqueue({ id: 'queued' })).toBe(false);
    const stopped = queue.stop({ cancelPending: true });
    expect(queue.state).toBe('stopped');
    expect(queue.enqueue({ id: 'after-stop' })).toBe(false);
    release.shift()();
    await stopped;
    await tick();

    expect(run).toHaveBeenCalledTimes(1);
    expect(queue.pending).toBe(0);
    await expect(queue.drain()).resolves.toBeUndefined();
  });

  it('gracefully stops by draining accepted pending work while rejecting new work', async () => {
    const releases = new Map();
    const started = [];
    const run = vi.fn((item) => {
      started.push(item.id);
      return new Promise((resolve) => releases.set(item.id, resolve));
    });
    const queue = createWorkQueue({ concurrency: 1, maxPending: 2, run });

    expect(queue.enqueue({ id: 'first' })).toBe(true);
    expect(queue.enqueue({ id: 'second' })).toBe(true);
    await vi.waitFor(() => expect(started).toEqual(['first']));

    const stopping = queue.stop({ cancelPending: false });
    expect(queue.enqueue({ id: 'rejected-after-stop' })).toBe(false);
    releases.get('first')();
    await vi.waitFor(() => expect(started).toEqual(['first', 'second']));
    releases.get('second')();
    await expect(stopping).resolves.toBeUndefined();
    expect(queue.size).toBe(0);
  });
});
