// Small in-memory dispatch bound for durable recovery work. SQLite remains the authority; this
// queue only prevents a recovery scan from turning an arbitrary number of rows into promises.

function identityOf(item) {
  if (item && typeof item === 'object') {
    const value = item.id ?? item.jobId ?? item.mandateId ?? item.identity?.id
      ?? item.identity?.childId;
    if (value !== undefined && value !== null) return String(value);
  }
  return typeof item === 'string' || typeof item === 'number' ? String(item) : null;
}

function validBound(value, label, { allowZero = false } = {}) {
  if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value < 1)) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

export function createWorkQueue({ concurrency = 1, maxPending = 100, run, onError = () => {} } = {}) {
  validBound(concurrency, 'concurrency');
  validBound(maxPending, 'maxPending', { allowZero: true });
  if (typeof run !== 'function' || typeof onError !== 'function') {
    throw new Error('work queue callbacks are invalid');
  }
  const pending = [];
  const identities = new Set();
  let active = 0;
  let stopped = false;
  let finishing = false;
  let drainResolvers = [];

  function settleDrain() {
    if (active !== 0 || pending.length !== 0) return;
    const waiters = drainResolvers;
    drainResolvers = [];
    for (const resolve of waiters) resolve();
  }

  function launch({ allowStopped = false } = {}) {
    while ((allowStopped || finishing || !stopped) && active < concurrency && pending.length > 0) {
      const entry = pending.shift();
      active += 1;
      Promise.resolve()
        .then(() => run(entry.item))
        .catch((error) => {
          try { onError(error, entry.item); } catch {}
        })
        .finally(() => {
          active -= 1;
          identities.delete(entry.identity);
          launch({ allowStopped: finishing });
          settleDrain();
        });
    }
    settleDrain();
  }

  function enqueue(item) {
    if (stopped) return false;
    const identity = identityOf(item);
    if (!identity || identities.has(identity) || pending.length >= maxPending) return false;
    identities.add(identity);
    pending.push({ item, identity });
    launch();
    return true;
  }

  function drain() {
    if (active === 0 && pending.length === 0) return Promise.resolve();
    return new Promise((resolve) => drainResolvers.push(resolve));
  }

  async function stop({ cancelPending = false } = {}) {
    stopped = true;
    if (cancelPending) {
      for (const entry of pending.splice(0)) identities.delete(entry.identity);
    } else {
      // Stop accepting new work but finish a bounded queue that was already accepted.
      finishing = true;
      launch({ allowStopped: true });
    }
    await drain();
  }

  return Object.freeze({
    enqueue,
    drain,
    stop,
    get active() { return active; },
    get pending() { return pending.length; },
    get size() { return active + pending.length; },
    get state() { return stopped ? 'stopped' : 'running'; },
  });
}
