import { describe, it, expect, vi } from 'vitest';
import { compileRule, buildToolFilterCanUseTool } from './tool-filters.js';
import type { CanUseTool, CanUseToolContext } from './agent.js';

const TEST_CTX: CanUseToolContext = {
  signal: new AbortController().signal,
  suggestions: [],
};

describe('compileRule', () => {
  describe('plain-name rules', () => {
    it('matches any invocation of the named tool (canonical name)', () => {
      const rule = compileRule('read_file');
      expect(rule.toolName).toBe('read_file');
      expect(rule.matches({ path: 'foo.txt' })).toBe(true);
      expect(rule.matches({})).toBe(true);
      expect(rule.matches(null)).toBe(true);
    });

    it('accepts the Claude-SDK-style alias and normalizes to the canonical name', () => {
      const rule = compileRule('Bash');
      expect(rule.toolName).toBe('bash');
      expect(rule.matches({ command: 'anything' })).toBe(true);
    });

    it('accepts the legacy run_command spelling as an alias for bash', () => {
      const plain = compileRule('run_command');
      expect(plain.toolName).toBe('bash');
      const scoped = compileRule('run_command(npm *)');
      expect(scoped.toolName).toBe('bash');
      expect(scoped.matches({ command: 'npm install' })).toBe(true);
      expect(scoped.matches({ command: 'pnpm install' })).toBe(false);
    });

    it('trims surrounding whitespace before lookup', () => {
      expect(compileRule('  read_file  ').toolName).toBe('read_file');
    });

    it('throws on an unknown plain name', () => {
      expect(() => compileRule('UnknownTool')).toThrow(/unknown tool name/i);
    });

    it('throws on the empty string', () => {
      expect(() => compileRule('')).toThrow(/empty/i);
      expect(() => compileRule('   ')).toThrow(/empty/i);
    });

    it('throws when given a non-string input (defensive type guard)', () => {
      // TypeScript prevents this at compile time, but compileRule is part of
      // the public API and may be reached from untyped callers — exercise the
      // typeof guard so it stays load-bearing.
      expect(() => compileRule(undefined as unknown as string)).toThrow(/expected string/i);
      expect(() => compileRule(42 as unknown as string)).toThrow(/expected string/i);
    });

    it('Phase 5.2.4: accepts MCP-prefixed plain names ("<server>__<tool>")', () => {
      const rule = compileRule('linear__list_issues');
      expect(rule.toolName).toBe('linear__list_issues');
      // MCP rules match every invocation of that prefixed name (scoped
      // patterns are not supported — we don't know the input shape).
      expect(rule.matches({})).toBe(true);
      expect(rule.matches({ anything: 'else' })).toBe(true);
    });

    it('Phase 5.2.4: rejects malformed MCP-prefix shapes (leading/trailing __)', () => {
      expect(() => compileRule('__leading')).toThrow(/unknown tool name/i);
      expect(() => compileRule('trailing__')).toThrow(/unknown tool name/i);
    });
  });

  describe('Bash(<command pattern>)', () => {
    const rule = compileRule('Bash(npm *)');

    it('targets the bash tool', () => {
      expect(rule.toolName).toBe('bash');
    });

    it('matches commands prefixed with the pattern', () => {
      expect(rule.matches({ command: 'npm install' })).toBe(true);
      expect(rule.matches({ command: 'npm run test -- --watch' })).toBe(true);
    });

    it('does not match commands without the prefix', () => {
      expect(rule.matches({ command: 'pnpm install' })).toBe(false);
      expect(rule.matches({ command: 'rm -rf /' })).toBe(false);
    });

    it('returns false when the input lacks a string command argument', () => {
      expect(rule.matches({})).toBe(false);
      expect(rule.matches({ command: 42 })).toBe(false);
      expect(rule.matches(null)).toBe(false);
      expect(rule.matches('npm install')).toBe(false);
    });

    it('escapes other regex metacharacters in the pattern body', () => {
      // `.` is a regex metachar — must be treated as a literal dot.
      const escapedRule = compileRule('Bash(echo .)');
      expect(escapedRule.matches({ command: 'echo .' })).toBe(true);
      expect(escapedRule.matches({ command: 'echo a' })).toBe(false);
    });
  });

  describe('Edit(<glob pattern>)', () => {
    it('matches a deep path with a `**` wildcard', () => {
      const rule = compileRule('Edit(src/handlers.ts)');
      expect(rule.toolName).toBe('edit_file');
      expect(rule.matches({ path: 'src/handlers.ts' })).toBe(true);
      expect(rule.matches({ path: 'src/other.ts' })).toBe(false);
    });

    it('treats `*` as a single-segment wildcard (no `/` crossing)', () => {
      const rule = compileRule('Edit(src/*.ts)');
      expect(rule.matches({ path: 'src/agent.ts' })).toBe(true);
      expect(rule.matches({ path: 'src/nested/agent.ts' })).toBe(false);
    });

    it('treats `**` as a zero-or-more-segments wildcard (spans `/`)', () => {
      // Built dynamically so the `*/` sequence does not close a JSDoc block.
      // As of Phase 3.11, when `**` is immediately followed by `/`, the pair
      // `**/` collapses to `(?:.*/)?` — zero-or-more path segments, matching
      // gitignore / minimatch / bash-globstar semantics. So `src/**/agent.ts`
      // now matches `src/agent.ts` (zero segments between) in addition to the
      // pre-3.11 multi-segment cases.
      const rule = compileRule(`Edit(src/${'**'}/agent.ts)`);
      expect(rule.matches({ path: 'src/agent.ts' })).toBe(true); // zero-segment ** now matches
      expect(rule.matches({ path: 'src/tools/agent.ts' })).toBe(true);
      expect(rule.matches({ path: 'src/a/b/c/agent.ts' })).toBe(true);
      expect(rule.matches({ path: 'lib/tools/agent.ts' })).toBe(false);
    });
  });

  describe('malformed rules', () => {
    it('throws when the closing parenthesis is missing', () => {
      expect(() => compileRule('Bash(npm install')).toThrow(/closing parenthesis/i);
    });

    it('throws when the pattern between parentheses is empty', () => {
      expect(() => compileRule('Bash()')).toThrow(/empty pattern/i);
    });

    it('throws when the tool name before the paren is empty', () => {
      expect(() => compileRule('(npm *)')).toThrow(/missing tool name/i);
    });

    it('throws when the tool name is unknown', () => {
      expect(() => compileRule('Frobnicate(*)')).toThrow(/unknown tool name/i);
    });
  });
});

describe('buildToolFilterCanUseTool', () => {
  it('allows everything when both lists are empty and no mode gate is set', async () => {
    const gate = buildToolFilterCanUseTool({});
    const result = await gate('bash', { command: 'ls' }, TEST_CTX);
    expect(result).toEqual({ behavior: 'allow' });
  });

  it('denies when a disallowedTools rule matches', async () => {
    const gate = buildToolFilterCanUseTool({ disallowedTools: ['Bash(rm *)'] });
    const result = await gate('bash', { command: 'rm -rf /' }, TEST_CTX);
    expect(result.behavior).toBe('deny');
    if (result.behavior === 'deny') {
      expect(result.reason).toMatch(/disallowedTools/);
    }
  });

  it('allows other commands when only a deny rule is set', async () => {
    const gate = buildToolFilterCanUseTool({ disallowedTools: ['Bash(rm *)'] });
    const result = await gate('bash', { command: 'ls' }, TEST_CTX);
    expect(result.behavior).toBe('allow');
  });

  it('disallowedTools wins over allowedTools (deny overrides allow)', async () => {
    const gate = buildToolFilterCanUseTool({
      allowedTools: ['Bash(rm *)'],
      disallowedTools: ['Bash(rm *)'],
    });
    const result = await gate('bash', { command: 'rm -rf /' }, TEST_CTX);
    expect(result.behavior).toBe('deny');
  });

  it('falls through to the mode gate when neither list matches', async () => {
    const modeGate = vi.fn<CanUseTool>(async () => ({ behavior: 'deny', reason: 'mode-deny' }));
    const gate = buildToolFilterCanUseTool({
      allowedTools: ['Bash(npm *)'],
      modeGate,
    });
    const result = await gate('bash', { command: 'ls' }, TEST_CTX);
    expect(modeGate).toHaveBeenCalledWith('bash', { command: 'ls' }, TEST_CTX);
    expect(result).toEqual({ behavior: 'deny', reason: 'mode-deny' });
  });

  it('short-circuits the mode gate when allowedTools matches', async () => {
    const modeGate = vi.fn<CanUseTool>(async () => ({ behavior: 'deny', reason: 'mode-deny' }));
    const gate = buildToolFilterCanUseTool({
      allowedTools: ['Bash(npm *)'],
      modeGate,
    });
    const result = await gate('bash', { command: 'npm install' }, TEST_CTX);
    expect(modeGate).not.toHaveBeenCalled();
    expect(result.behavior).toBe('allow');
  });

  it('compiles rules eagerly — a malformed rule throws at build time, not at first call', () => {
    expect(() => buildToolFilterCanUseTool({ allowedTools: ['Frobnicate'] })).toThrow(
      /unknown tool name/i,
    );
    expect(() => buildToolFilterCanUseTool({ disallowedTools: ['Bash('] })).toThrow(
      /closing parenthesis/i,
    );
  });
});
