import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StreamStallError, createStallMonitor, monitorStream } from './stall.js';

beforeEach(() => {
  // Leave setImmediate real: several tests flush genuine macrotasks (to let
  // Node's unhandled-rejection detection run) while advancing faked
  // setTimeout/Date time.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('StreamStallError', () => {
  it('carries the configured threshold and a stable name', () => {
    const err = new StreamStallError(45_000);
    expect(err.name).toBe('StreamStallError');
    expect(err.stallTimeoutMs).toBe(45_000);
    expect(err.message).toContain('45000ms');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('createStallMonitor', () => {
  it('rejects a racing promise once the window elapses with no activity', async () => {
    const monitor = createStallMonitor(1_000, () => false);
    try {
      const raced = monitor.race(new Promise<never>(() => undefined));
      // Pre-attach the assertion handler BEFORE advancing so the rejection
      // is observed the moment it fires.
      const assertion = expect(raced).rejects.toBeInstanceOf(StreamStallError);
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
    } finally {
      monitor.dispose();
    }
  });

  it('a stall that fires while nothing is racing is NOT an unhandledRejection, and a later race observes it immediately', async () => {
    const observed: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      observed.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    const monitor = createStallMonitor(1_000, () => false);
    try {
      // Fire the stall with no race in flight (the consumer is "holding the
      // generator at a yield" in the real flow).
      await vi.advanceTimersByTimeAsync(1_000);
      await new Promise((r) => setImmediate(r));
      expect(observed).toEqual([]);
      // A subsequent race still observes the (already settled) rejection.
      const err = await monitor
        .race(new Promise<never>(() => undefined))
        .then(() => null)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(StreamStallError);
      expect((err as StreamStallError).stallTimeoutMs).toBe(1_000);
    } finally {
      monitor.dispose();
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('re-arms for the remainder when activity is fresher than the window', async () => {
    const monitor = createStallMonitor(1_000, () => false);
    try {
      let stalled = false;
      void monitor.race(new Promise<never>(() => undefined)).catch(() => {
        stalled = true;
      });
      // Activity at t=600 → the t=1000 fire re-arms for the 600ms remainder.
      await vi.advanceTimersByTimeAsync(600);
      monitor.bump();
      await vi.advanceTimersByTimeAsync(900);
      expect(stalled).toBe(false); // t=1500: only 900ms idle
      await vi.advanceTimersByTimeAsync(200);
      expect(stalled).toBe(true); // t=1700: 1100ms idle ≥ 1000
    } finally {
      monitor.dispose();
    }
  });

  it('never fires while suspended (tool in flight), re-arming the full window each time', async () => {
    let suspended = true;
    const monitor = createStallMonitor(1_000, () => suspended);
    try {
      let stalled = false;
      void monitor.race(new Promise<never>(() => undefined)).catch(() => {
        stalled = true;
      });
      // Many windows elapse while suspended — no stall.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(stalled).toBe(false);
      // Suspension lifts and the tool completion bumps the clock — the stall
      // then fires one full window later.
      suspended = false;
      monitor.bump();
      await vi.advanceTimersByTimeAsync(999);
      expect(stalled).toBe(false);
      await vi.advanceTimersByTimeAsync(1_001);
      expect(stalled).toBe(true);
    } finally {
      monitor.dispose();
    }
  });

  it('dispose() clears the timer and is idempotent', async () => {
    const monitor = createStallMonitor(1_000, () => false);
    let stalled = false;
    void monitor.race(new Promise<never>(() => undefined)).catch(() => {
      stalled = true;
    });
    monitor.dispose();
    monitor.dispose(); // second call hits the already-cleared branch
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stalled).toBe(false);
  });
});

describe('monitorStream', () => {
  it('passes events through, bumping the clock per event, and ends with the source', async () => {
    const monitor = createStallMonitor(1_000, () => false);
    try {
      async function* source(): AsyncGenerator<number> {
        yield 1;
        await new Promise((r) => setTimeout(r, 800));
        yield 2;
        await new Promise((r) => setTimeout(r, 800));
        yield 3;
      }
      const seen: number[] = [];
      const drain = (async () => {
        for await (const v of monitorStream(source(), monitor)) seen.push(v);
      })();
      // Total elapsed (1600ms) exceeds the window but no single gap does —
      // the per-event bump keeps the watchdog quiet.
      await vi.advanceTimersByTimeAsync(1_600);
      await drain;
      expect(seen).toEqual([1, 2, 3]);
    } finally {
      monitor.dispose();
    }
  });

  it('throws StreamStallError when the source hangs, catch-draining the orphaned next()', async () => {
    const observed: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      observed.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    const monitor = createStallMonitor(1_000, () => false);
    try {
      let rejectHang: (err: Error) => void = () => undefined;
      async function* source(): AsyncGenerator<number> {
        yield 1;
        await new Promise<never>((_r, rej) => {
          rejectHang = rej;
        });
      }
      const seen: number[] = [];
      const drain = (async () => {
        for await (const v of monitorStream(source(), monitor)) seen.push(v);
      })();
      const assertion = expect(drain).rejects.toBeInstanceOf(StreamStallError);
      await vi.advanceTimersByTimeAsync(2_000);
      await assertion;
      expect(seen).toEqual([1]);
      // The orphaned next() settles (rejected!) AFTER the stall won the race
      // — the attached no-op catch must swallow it.
      rejectHang(new Error('late death of the hung stream'));
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(observed).toEqual([]);
    } finally {
      monitor.dispose();
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('re-throws a source rejection unchanged (not a stall)', async () => {
    const monitor = createStallMonitor(60_000, () => false);
    try {
      // eslint-disable-next-line require-yield
      async function* source(): AsyncGenerator<number> {
        throw new Error('boom');
      }
      await expect(
        (async () => {
          for await (const v of monitorStream(source(), monitor)) void v;
        })(),
      ).rejects.toThrow('boom');
    } finally {
      monitor.dispose();
    }
  });

  it('closes a closeable source (fire-and-forget) when the consumer breaks early', async () => {
    const monitor = createStallMonitor(60_000, () => false);
    try {
      let closed = false;
      async function* source(): AsyncGenerator<number> {
        try {
          yield 1;
          yield 2;
        } finally {
          closed = true;
        }
      }
      for await (const v of monitorStream(source(), monitor)) {
        void v;
        break;
      }
      await new Promise((r) => setImmediate(r));
      expect(closed).toBe(true);
    } finally {
      monitor.dispose();
    }
  });

  it('swallows a rejecting return() on early close (fire-and-forget teardown never surfaces)', async () => {
    const observed: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      observed.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    const monitor = createStallMonitor(60_000, () => false);
    try {
      let i = 0;
      const angry: AsyncIterable<number> = {
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.resolve({ value: i++, done: false }),
          return: () => Promise.reject(new Error('teardown failed')),
        }),
      };
      for await (const v of monitorStream(angry, monitor)) {
        void v;
        break;
      }
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(observed).toEqual([]);
    } finally {
      monitor.dispose();
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('tolerates a bare iterator without return() when the consumer breaks early', async () => {
    const monitor = createStallMonitor(60_000, () => false);
    try {
      let i = 0;
      const bare: AsyncIterable<number> = {
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.resolve({ value: i++, done: false }),
        }),
      };
      const seen: number[] = [];
      for await (const v of monitorStream(bare, monitor)) {
        seen.push(v);
        if (seen.length === 2) break;
      }
      expect(seen).toEqual([0, 1]);
    } finally {
      monitor.dispose();
    }
  });
});
