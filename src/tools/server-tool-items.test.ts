import { describe, it, expect } from 'vitest';
import { isServerToolOutputItem, normalizeServerToolItem } from './server-tool-items.js';

describe('isServerToolOutputItem', () => {
  it('matches openrouter:* output items', () => {
    expect(isServerToolOutputItem({ type: 'openrouter:datetime' })).toBe(true);
    expect(isServerToolOutputItem({ type: 'openrouter:web_search' })).toBe(true);
    expect(isServerToolOutputItem({ type: 'openrouter:web_fetch' })).toBe(true);
    // Forward-compat: any future openrouter:* tool flows through.
    expect(isServerToolOutputItem({ type: 'openrouter:image_generation' })).toBe(true);
  });

  it('rejects client items and non-objects', () => {
    expect(isServerToolOutputItem({ type: 'function_call' })).toBe(false);
    expect(isServerToolOutputItem({ type: 'message' })).toBe(false);
    expect(isServerToolOutputItem({ type: 'web_search_call' })).toBe(false);
    expect(isServerToolOutputItem(null)).toBe(false);
    expect(isServerToolOutputItem(undefined)).toBe(false);
    expect(isServerToolOutputItem('openrouter:datetime')).toBe(false);
    expect(isServerToolOutputItem({})).toBe(false);
  });
});

describe('normalizeServerToolItem', () => {
  it('strips the envelope and surfaces the result payload (datetime)', () => {
    const out = normalizeServerToolItem({
      type: 'openrouter:datetime',
      id: 'st_dt',
      status: 'completed',
      datetime: '2026-06-11T12:00:00Z',
      timezone: 'UTC',
    });
    expect(out).toEqual({
      toolType: 'openrouter:datetime',
      callId: 'st_dt',
      status: 'completed',
      output: { datetime: '2026-06-11T12:00:00Z', timezone: 'UTC' },
      isError: false,
    });
    // No recoverable input for datetime.
    expect(out.input).toBeUndefined();
  });

  it('recovers the query as input for web_search', () => {
    const out = normalizeServerToolItem({
      type: 'openrouter:web_search',
      id: 'st_ws',
      status: 'completed',
      action: {
        type: 'search',
        query: 'callboard release notes',
        sources: [{ type: 'url', url: 'https://x' }],
      },
    });
    expect(out.toolType).toBe('openrouter:web_search');
    expect(out.input).toEqual({ query: 'callboard release notes' });
    expect(out.isError).toBe(false);
    // The action (with sources) survives in output too.
    expect(out.output).toHaveProperty('action');
  });

  it('flags web_fetch failures via the error field', () => {
    const out = normalizeServerToolItem({
      type: 'openrouter:web_fetch',
      id: 'st_wf',
      status: 'completed',
      url: 'https://example.com',
      error: 'fetch timed out',
      httpStatus: 504,
    });
    expect(out.isError).toBe(true);
    expect(out.output).toMatchObject({ url: 'https://example.com', error: 'fetch timed out' });
  });

  it('treats a non-completed status as an error', () => {
    const out = normalizeServerToolItem({
      type: 'openrouter:web_search',
      id: 'st_ws2',
      status: 'incomplete',
    });
    expect(out.isError).toBe(true);
  });

  it('defaults missing id/status gracefully', () => {
    const out = normalizeServerToolItem({ type: 'openrouter:datetime' });
    expect(out.callId).toBeUndefined();
    expect(out.status).toBe('completed');
    expect(out.isError).toBe(false);
    expect(out.output).toEqual({});
  });
});
