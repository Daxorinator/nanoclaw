import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, spyOn } from 'bun:test';

import './index.js';
import type { AgentProvider } from '../providers/types.js';
import { TIMEZONE, formatLocalStamp } from '../timezone.js';
import {
  archiveProviderExchangeFromContract,
  archiveProviderTranscript,
  newestRegisteredTrace,
  realizeProviderManagedFiles,
} from './realize.js';
import {
  getProviderRuntimeContract,
  hasDeclaredProviderRuntimeContract,
  provided,
  registerProviderArchivePlanner,
  registerProviderContinuationRotationPlanner,
  registerProviderPathResolver,
  registerProviderRuntimeContract,
  registerProviderRuntimeFileTransformer,
  registerProviderTraceReader,
  type ProviderRuntimeContract,
  validateProviderRuntimeInstance,
  waived,
} from './registry.js';

function emptyContract(): ProviderRuntimeContract {
  return {
    managedFiles: waived('none'),
    archives: waived('none'),
    continuationRotation: waived('none'),
    traceReaders: waived('none'),
    attachments: provided({ initial: 'text-only', followUp: 'text-only' }),
    events: ['activity', 'result'],
    textDelivery: 'result',
    lifecycle: {
      memory: provided('native-session-hook'),
      compaction: waived('none'),
      continuation: provided('opaque-token'),
      exchangeCompletion: waived('none'),
    },
    commands: { formatting: 'xml', nativeAdmin: [], nativeFiltered: [] },
  };
}

function coreArchiveContract(trigger: 'pre-compact' | 'exchange-complete', planner: string): ProviderRuntimeContract {
  const contract = emptyContract();
  contract.archives = provided({ trigger, owner: 'core', planner });
  if (trigger === 'pre-compact') contract.lifecycle.compaction = provided('provider-hook');
  else contract.lifecycle.exchangeCompletion = provided('provider-hook');
  return contract;
}

const missing = Symbol('missing');

function claudeContractWith(path: string, value: unknown | typeof missing): ProviderRuntimeContract {
  const contract = structuredClone(getProviderRuntimeContract('claude')!);
  const parts = path.split('.');
  let target = contract as unknown as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) target = target[part] as Record<string, unknown>;
  const field = parts.at(-1)!;
  if (value === missing) delete target[field];
  else target[field] = value;
  return contract;
}

function contractName(field: string, suffix: string): string {
  return `runtime-${field}-${suffix}-${process.pid}`.replaceAll(/[^a-z0-9-]/g, '-');
}

function registerClaudeContract(name: string, contract: ProviderRuntimeContract): void {
  registerProviderPathResolver(name, 'config-directory', () => '/tmp');
  registerProviderRuntimeFileTransformer(name, 'memory-session-hook', () => ({ kind: 'unchanged' }));
  registerProviderTraceReader(name, 'claude-home', () => null);
  registerProviderArchivePlanner(name, 'transcript-markdown', () => null);
  registerProviderContinuationRotationPlanner(name, 'cold-resume', () => null);
  registerProviderRuntimeContract(name, contract);
}

function runtimeInstance(overrides: Partial<AgentProvider> = {}): AgentProvider {
  return {
    supportsNativeSlashCommands: false,
    registerMemorySessionHook: () => {},
    query: () => {
      throw new Error('unused');
    },
    isSessionInvalid: () => false,
    ...overrides,
  };
}

describe('provider runtime contracts', () => {
  it('loads the complete Claude declaration from the separate contract barrel', () => {
    const contract = getProviderRuntimeContract('claude');
    expect(contract).toBeDefined();
    expect(contract?.managedFiles).toEqual(
      provided([
        expect.objectContaining({
          id: 'memory-session-hook',
          pathResolver: 'config-directory',
          relativePath: 'settings.json',
        }),
      ]),
    );
    expect(contract?.traceReaders).toEqual(provided([{ id: 'claude-home', reader: 'claude-home' }]));
    expect(contract?.archives).toEqual(
      provided({ trigger: 'pre-compact', owner: 'core', planner: 'transcript-markdown' }),
    );
    expect(contract?.continuationRotation).toEqual(
      expect.objectContaining({
        kind: 'provided',
        value: expect.objectContaining({ owner: 'core', planner: 'cold-resume' }),
      }),
    );
    expect(contract?.events).toContain('text');
    expect(contract?.commands.formatting).toBe('native');
    expect(JSON.parse(JSON.stringify(contract))).toEqual(contract);
    expect(hasDeclaredProviderRuntimeContract('CLAUDE')).toBe(true);
    expect(hasDeclaredProviderRuntimeContract('legacy')).toBe(false);
  });

  it('rejects duplicate and incomplete declarations at registration', () => {
    const name = `runtime-contract-${process.pid}`;
    const contract = emptyContract();
    registerProviderRuntimeContract(name, contract);
    expect(() => registerProviderRuntimeContract(name, contract)).toThrow(/already registered/);
    expect(() =>
      registerProviderRuntimeContract(`${name}-invalid`, {
        ...emptyContract(),
        archives: waived(''),
      }),
    ).toThrow(/waiver requires a reason/);
  });

  it('rejects waiving the required shared-memory lifecycle', () => {
    expect(() =>
      registerProviderRuntimeContract(`runtime-no-memory-${process.pid}`, {
        ...emptyContract(),
        lifecycle: { ...emptyContract().lifecycle, memory: waived('not supported') },
      }),
    ).toThrow(/memory cannot be waived/);
  });

  it('stores an immutable clone so callers cannot bypass validation after registration', () => {
    const name = `runtime-immutable-${process.pid}`;
    const input = emptyContract();
    registerProviderRuntimeContract(name, input);
    (input.commands as unknown as { nativeAdmin: string[] }).nativeAdmin = ['/later'];

    const stored = getProviderRuntimeContract(name)!;
    expect(stored.commands.nativeAdmin).toEqual([]);
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored.commands.nativeAdmin)).toBe(true);
    expect(() => (stored.commands.nativeAdmin as string[]).push('/later')).toThrow();
  });

  it('rejects non-JSON plans and missing local functions', () => {
    expect(() =>
      registerProviderRuntimeContract(`runtime-non-json-${process.pid}`, {
        ...emptyContract(),
        extra: () => undefined,
      } as unknown as ProviderRuntimeContract),
    ).toThrow(/pure JSON/);

    expect(() =>
      registerProviderRuntimeContract(`runtime-missing-transformer-${process.pid}`, {
        ...emptyContract(),
        managedFiles: provided([
          {
            id: 'settings',
            pathResolver: 'missing',
            relativePath: 'settings.json',
            when: 'before-query',
            transformer: 'missing',
            read: 'text-if-present',
            write: 'direct-replace',
          },
        ]),
      }),
    ).toThrow(/missing path resolver|missing transformer/);
  });

  it.each([
    ['managedFiles.kind', 'claude.managedFiles.kind'],
    ['managedFiles.value.0.when', 'claude.managedFiles.memory-session-hook.when'],
    ['managedFiles.value.0.read', 'claude.managedFiles.memory-session-hook.read'],
    ['managedFiles.value.0.write', 'claude.managedFiles.memory-session-hook.write'],
    ['archives.kind', 'claude.archives.kind'],
    ['archives.value.trigger', 'claude.archives.value.trigger'],
    ['archives.value.owner', 'claude.archives.value.owner'],
    ['continuationRotation.kind', 'claude.continuationRotation.kind'],
    ['continuationRotation.value.owner', 'claude.continuationRotation.value.owner'],
    ['traceReaders.kind', 'claude.traceReaders.kind'],
    ['attachments.kind', 'claude.attachments.kind'],
    ['attachments.value.initial', 'claude.attachments.value.initial'],
    ['attachments.value.followUp', 'claude.attachments.value.followUp'],
    ['textDelivery', 'claude.textDelivery'],
    ['lifecycle.memory.kind', 'claude.lifecycle.memory.kind'],
    ['lifecycle.memory.value', 'claude.lifecycle.memory.value'],
    ['lifecycle.compaction.kind', 'claude.lifecycle.compaction.kind'],
    ['lifecycle.compaction.value', 'claude.lifecycle.compaction.value'],
    ['lifecycle.continuation.kind', 'claude.lifecycle.continuation.kind'],
    ['lifecycle.continuation.value', 'claude.lifecycle.continuation.value'],
    ['lifecycle.exchangeCompletion.kind', 'claude.lifecycle.exchangeCompletion.kind'],
    ['commands.formatting', 'claude.commands.formatting'],
    ['commands.nativeAdmin', 'claude.commands.nativeAdmin'],
    ['commands.nativeFiltered', 'claude.commands.nativeFiltered'],
  ])('rejects invalid and missing %s at registration', (path, field) => {
    const invalidName = contractName(path, 'invalid');
    expect(() => registerClaudeContract(invalidName, claudeContractWith(path, 'invalid'))).toThrow(
      field.slice('claude'.length),
    );
    const missingName = contractName(path, 'missing');
    expect(() => registerClaudeContract(missingName, claudeContractWith(path, missing))).toThrow(
      field.slice('claude'.length),
    );
  });

  it('rejects invalid and missing runtime event declarations', () => {
    const invalidName = contractName('events', 'invalid');
    expect(() => registerClaudeContract(invalidName, claudeContractWith('events.0', 'invalid'))).toThrow(
      /\.events\[\]/,
    );
    const missingName = contractName('events', 'missing');
    expect(() => registerClaudeContract(missingName, claudeContractWith('events', missing))).toThrow(
      /\.events is required/,
    );
  });

  it('keeps event inventory separate from text delivery semantics', () => {
    const name = `runtime-partial-text-${process.pid}`;
    const contract = emptyContract();
    contract.events = ['text', 'result'];
    registerProviderRuntimeContract(name, contract);
    expect(() => validateProviderRuntimeInstance(name, contract, runtimeInstance())).not.toThrow();
  });

  it.each([
    'managedFiles',
    'archives',
    'continuationRotation',
    'traceReaders',
    'attachments',
    'lifecycle.memory',
    'lifecycle.compaction',
    'lifecycle.continuation',
    'lifecycle.exchangeCompletion',
  ])('requires both discriminated-answer branches for %s', (path) => {
    const providedName = contractName(path, 'provided');
    expect(() => registerClaudeContract(providedName, claudeContractWith(path, { kind: 'provided' }))).toThrow(
      /\.value is required/,
    );
    const waivedName = contractName(path, 'waived');
    expect(() => registerClaudeContract(waivedName, claudeContractWith(path, { kind: 'waived' }))).toThrow(
      /waiver requires a reason/,
    );
  });

  it('validates the provided exchange-completion lifecycle value', () => {
    const name = contractName('exchange-completion', 'value');
    expect(() =>
      registerClaudeContract(
        name,
        claudeContractWith('lifecycle.exchangeCompletion', { kind: 'provided', value: 'invalid' }),
      ),
    ).toThrow(/\.lifecycle\.exchangeCompletion\.value/);
  });

  it.each(['planner', 'pathResolver', 'searchSubdirectory', 'extension'] as const)(
    'rejects core-only continuationRotation.%s on the legacy-provider arm',
    (field) => {
      const name = contractName(`legacy-continuation-${field}`, 'invalid');
      expect(() =>
        registerProviderRuntimeContract(name, {
          ...emptyContract(),
          continuationRotation: provided({ owner: 'legacy-provider', [field]: 'value' }),
        }),
      ).toThrow(`.continuationRotation.value.${field}`);
    },
  );

  it('rejects the core-only archive planner on the legacy-provider arm', () => {
    const name = contractName('legacy-archive-planner', 'invalid');
    expect(() =>
      registerProviderRuntimeContract(name, {
        ...emptyContract(),
        archives: provided({ trigger: 'exchange-complete', owner: 'legacy-provider', planner: 'value' }),
      }),
    ).toThrow('.archives.value.planner');
  });

  it.each([
    ['exchange-complete', waived('none'), waived('none'), 'exchangeCompletion'],
    ['pre-compact', provided('provider-native'), waived('none'), 'compaction'],
  ] as const)('rejects unreachable core %s archives', (trigger, compaction, exchangeCompletion, field) => {
    const name = contractName(`unreachable-${trigger}`, 'invalid');
    registerProviderArchivePlanner(name, 'archive', () => null);
    expect(() =>
      registerProviderRuntimeContract(name, {
        ...emptyContract(),
        archives: provided({ trigger, owner: 'core', planner: 'archive' }),
        lifecycle: { ...emptyContract().lifecycle, compaction, exchangeCompletion },
      }),
    ).toThrow(field);
  });

  it.each([
    ['dot', './settings.json'],
    ['bare-parent', '..'],
    ['leading-parent', '../settings.json'],
    ['parent', 'config/../settings.json'],
    ['slash', 'config//settings.json'],
    ['trailing', 'config/'],
  ])('rejects noncanonical managed-file relative path %s', (label, relativePath) => {
    const name = contractName('managed-relative-path', label);
    registerProviderPathResolver(name, 'root', () => '/tmp');
    registerProviderRuntimeFileTransformer(name, 'settings', () => ({ kind: 'unchanged' }));
    expect(() =>
      registerProviderRuntimeContract(name, {
        ...emptyContract(),
        managedFiles: provided([
          {
            id: 'settings',
            pathResolver: 'root',
            relativePath,
            when: 'before-query',
            transformer: 'settings',
            read: 'none',
            write: 'direct-replace',
          },
        ]),
      }),
    ).toThrow(/canonical relative path/);
  });

  it('honors managed-file read policy and preserves config-before-hooks failure ordering', () => {
    const name = `runtime-managed-files-${process.pid}`;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
    const configPath = path.join(root, 'config.toml');
    const hooksPath = path.join(root, 'hooks.json');
    const calls: string[] = [];
    const originalExistsSync = fs.existsSync.bind(fs);

    registerProviderPathResolver(name, 'config-directory', () => root);
    registerProviderRuntimeFileTransformer(name, 'config', ({ exists, content }) => {
      calls.push(`config:${exists}:${content}`);
      return { kind: 'replace', content: 'new config\n' };
    });
    registerProviderRuntimeFileTransformer(name, 'hooks', ({ exists, content }) => {
      calls.push(`hooks:${exists}:${content}`);
      JSON.parse(content || '{}');
      return { kind: 'replace', content: '{"hooks":true}\n' };
    });
    registerProviderRuntimeContract(name, {
      ...emptyContract(),
      managedFiles: provided([
        {
          id: 'config',
          pathResolver: 'config-directory',
          relativePath: 'config.toml',
          when: 'before-query',
          transformer: 'config',
          read: 'none',
          write: 'direct-replace',
        },
        {
          id: 'hooks',
          pathResolver: 'config-directory',
          relativePath: 'hooks.json',
          when: 'before-query',
          transformer: 'hooks',
          read: 'text-if-present',
          write: 'direct-replace',
        },
      ]),
    });

    try {
      fs.writeFileSync(configPath, 'stale config');
      fs.writeFileSync(hooksPath, '{}');
      const mkdirSpy = spyOn(fs, 'mkdirSync');
      const existsSpy = spyOn(fs, 'existsSync').mockImplementation((candidate) => {
        if (candidate === configPath) throw new Error('config existence must not be checked');
        return originalExistsSync(candidate);
      });
      try {
        realizeProviderManagedFiles(name, 'before-query', {});
        expect(mkdirSpy).toHaveBeenCalledTimes(1);
      } finally {
        existsSpy.mockRestore();
        mkdirSpy.mockRestore();
      }
      expect(calls).toEqual(['config:false:', 'hooks:true:{}']);
      expect(fs.readFileSync(configPath, 'utf-8')).toBe('new config\n');
      expect(fs.readFileSync(hooksPath, 'utf-8')).toBe('{"hooks":true}\n');

      calls.length = 0;
      fs.writeFileSync(configPath, 'stale again');
      fs.writeFileSync(hooksPath, '{');
      expect(() => realizeProviderManagedFiles(name, 'before-query', {})).toThrow();
      expect(calls).toEqual(['config:false:', 'hooks:true:{']);
      expect(fs.readFileSync(configPath, 'utf-8')).toBe('new config\n');
      expect(fs.readFileSync(hooksPath, 'utf-8')).toBe('{');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('decides empty transcript no-op before reading the optional sessions index', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `runtime-transcript-noop-${process.pid}-`));
    const transcriptPath = path.join(root, 'empty.jsonl');
    const conversationsDir = path.join(root, 'conversations');
    const previous = process.env.NANOCLAW_CONVERSATIONS_DIR;
    process.env.NANOCLAW_CONVERSATIONS_DIR = conversationsDir;
    fs.writeFileSync(transcriptPath, '');

    try {
      expect(archiveProviderTranscript('claude', transcriptPath, 'empty', 'Claude', () => {})).toBe(false);
      fs.mkdirSync(path.join(root, 'sessions-index.json'));
      const logs: string[] = [];
      expect(archiveProviderTranscript('claude', transcriptPath, 'empty', 'Claude', (line) => logs.push(line))).toBe(
        false,
      );
      expect(logs).toEqual([]);
      expect(fs.existsSync(conversationsDir)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.NANOCLAW_CONVERSATIONS_DIR;
      else process.env.NANOCLAW_CONVERSATIONS_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('samples Claude clocks around mkdir and uses the local filename date across UTC rollover', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `runtime-transcript-clock-${process.pid}-`));
    const transcriptPath = path.join(root, 'transcript.jsonl');
    const indexPath = path.join(root, 'sessions-index.json');
    const conversationsDir = path.join(root, 'conversations');
    const previous = process.env.NANOCLAW_CONVERSATIONS_DIR;
    const beforeDirectoryClockMs = [Date.parse('2026-01-01T23:59:59.900Z'), Date.parse('2026-01-02T00:00:00.100Z')];
    const utcRolloverClockMs = [Date.parse('2027-02-03T23:59:59.900Z'), Date.parse('2027-02-04T00:00:00.100Z')];
    const filenameClockMs =
      utcRolloverClockMs.find(
        (clockMs) => formatLocalStamp(new Date(clockMs), TIMEZONE).slice(0, 10) !== new Date(clockMs).toISOString().slice(0, 10),
      ) ?? utcRolloverClockMs[0];
    const afterDirectoryClockMs = [filenameClockMs, Date.parse('2027-02-04T00:00:00.100Z')];
    let beforeDirectoryClockIndex = 0;
    let afterDirectoryClockIndex = 0;
    let indexRead = false;
    process.env.NANOCLAW_CONVERSATIONS_DIR = conversationsDir;
    fs.writeFileSync(transcriptPath, '{}');
    fs.writeFileSync(indexPath, '{}');
    const readSpy = spyOn(fs, 'readFileSync').mockImplementation((candidate) => {
      if (candidate === transcriptPath) return '{"type":"user","message":{"content":"hello"}}\n';
      if (candidate === indexPath) {
        indexRead = true;
        return '{"entries":[]}';
      }
      throw new Error(`unexpected read: ${String(candidate)}`);
    });
    const mkdirSpy = spyOn(fs, 'mkdirSync');
    const nowSpy = spyOn(Date, 'now').mockImplementation(() => {
      expect(indexRead).toBe(true);
      return mkdirSpy.mock.calls.length === 0
        ? beforeDirectoryClockMs[beforeDirectoryClockIndex++]
        : afterDirectoryClockMs[afterDirectoryClockIndex++];
    });

    try {
      try {
        expect(archiveProviderTranscript('claude', transcriptPath, 'session', 'Claude', () => {})).toBe(true);
      } finally {
        readSpy.mockRestore();
        nowSpy.mockRestore();
        mkdirSpy.mockRestore();
      }
      const hour = new Date(beforeDirectoryClockMs[0]).getHours().toString().padStart(2, '0');
      const minute = new Date(beforeDirectoryClockMs[1]).getMinutes().toString().padStart(2, '0');
      const localDate = formatLocalStamp(new Date(afterDirectoryClockMs[0]), TIMEZONE).slice(0, 10);
      const filename = `${localDate}-conversation-${hour}${minute}.md`;
      const archived = fs.readFileSync(path.join(conversationsDir, filename), 'utf-8');
      const header = new Date(afterDirectoryClockMs[1]).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });
      expect(archived).toContain(`Archived: ${header}`);
      expect(beforeDirectoryClockIndex).toBe(2);
      expect(afterDirectoryClockIndex).toBe(2);
    } finally {
      if (previous === undefined) delete process.env.NANOCLAW_CONVERSATIONS_DIR;
      else process.env.NANOCLAW_CONVERSATIONS_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses zero pre-mkdir clocks for a summarized Claude transcript', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `runtime-transcript-summary-clock-${process.pid}-`));
    const transcriptPath = path.join(root, 'transcript.jsonl');
    const conversationsDir = path.join(root, 'conversations');
    const previous = process.env.NANOCLAW_CONVERSATIONS_DIR;
    process.env.NANOCLAW_CONVERSATIONS_DIR = conversationsDir;
    fs.writeFileSync(transcriptPath, '{"type":"user","message":{"content":"hello"}}\n');
    fs.writeFileSync(
      path.join(root, 'sessions-index.json'),
      '{"entries":[{"sessionId":"session","summary":"Useful Summary"}]}',
    );
    const mkdirSpy = spyOn(fs, 'mkdirSync');
    const clockMs = [Date.parse('2027-03-04T23:59:59.900Z'), Date.parse('2027-03-05T00:00:00.100Z')];
    let clockIndex = 0;
    const nowSpy = spyOn(Date, 'now').mockImplementation(() => {
      expect(mkdirSpy).toHaveBeenCalledTimes(1);
      return clockMs[clockIndex++];
    });

    try {
      try {
        expect(archiveProviderTranscript('claude', transcriptPath, 'session', 'Claude', () => {})).toBe(true);
      } finally {
        nowSpy.mockRestore();
        mkdirSpy.mockRestore();
      }
      expect(clockIndex).toBe(2);
      expect(fs.readdirSync(conversationsDir)).toEqual(['2027-03-04-useful-summary.md']);
    } finally {
      if (previous === undefined) delete process.env.NANOCLAW_CONVERSATIONS_DIR;
      else process.env.NANOCLAW_CONVERSATIONS_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('consumes only Claude fallback clocks when conversations mkdir fails', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `runtime-transcript-mkdir-clock-${process.pid}-`));
    const transcriptPath = path.join(root, 'transcript.jsonl');
    const conversationsDir = path.join(root, 'not-a-directory');
    const previous = process.env.NANOCLAW_CONVERSATIONS_DIR;
    process.env.NANOCLAW_CONVERSATIONS_DIR = conversationsDir;
    fs.writeFileSync(transcriptPath, '{"type":"user","message":{"content":"hello"}}\n');
    fs.writeFileSync(conversationsDir, 'blocked');
    const nowSpy = spyOn(Date, 'now').mockReturnValue(100);

    try {
      const logs: string[] = [];
      expect(archiveProviderTranscript('claude', transcriptPath, 'session', 'Claude', (line) => logs.push(line))).toBe(
        false,
      );
      expect(nowSpy).toHaveBeenCalledTimes(2);
      expect(logs[0]).toContain('Failed to archive transcript:');
    } finally {
      nowSpy.mockRestore();
      if (previous === undefined) delete process.env.NANOCLAW_CONVERSATIONS_DIR;
      else process.env.NANOCLAW_CONVERSATIONS_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('archives a transcript without a summary when the optional sessions index is unreadable', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `runtime-transcript-index-${process.pid}-`));
    const transcriptPath = path.join(root, 'transcript.jsonl');
    const conversationsDir = path.join(root, 'conversations');
    const previous = process.env.NANOCLAW_CONVERSATIONS_DIR;
    process.env.NANOCLAW_CONVERSATIONS_DIR = conversationsDir;
    fs.writeFileSync(transcriptPath, '{"type":"user","message":{"content":"hello"}}\n');
    fs.mkdirSync(path.join(root, 'sessions-index.json'));

    try {
      expect(archiveProviderTranscript('claude', transcriptPath, 'session', 'Claude', () => {})).toBe(true);
      const [archive] = fs.readdirSync(conversationsDir);
      expect(fs.readFileSync(path.join(conversationsDir, archive), 'utf-8')).toContain('**User**: hello');
    } finally {
      if (previous === undefined) delete process.env.NANOCLAW_CONVERSATIONS_DIR;
      else process.env.NANOCLAW_CONVERSATIONS_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('decides empty exchange no-op before conversations discovery', () => {
    const name = `runtime-exchange-noop-${process.pid}`;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
    const conversationsDir = path.join(root, 'conversations');
    const previous = process.env.NANOCLAW_CONVERSATIONS_DIR;
    process.env.NANOCLAW_CONVERSATIONS_DIR = conversationsDir;
    registerProviderArchivePlanner(name, 'exchange', (value) => {
      const exchange = (value as { exchange: { result: string | null } }).exchange;
      return exchange.result?.trim()
        ? { relativePath: 'exchange.md', content: exchange.result, write: 'append' }
        : null;
    });
    registerProviderRuntimeContract(name, coreArchiveContract('exchange-complete', 'exchange'));
    const nowSpy = spyOn(Date, 'now');
    const mkdirSpy = spyOn(fs, 'mkdirSync');
    const readdirSpy = spyOn(fs, 'readdirSync');

    try {
      const empty = { prompt: 'hello', result: ' ', status: 'completed' as const };
      expect(archiveProviderExchangeFromContract(name, empty)).toBeNull();
      expect(fs.existsSync(conversationsDir)).toBe(false);
      fs.writeFileSync(conversationsDir, 'not a directory');
      expect(archiveProviderExchangeFromContract(name, empty)).toBeNull();
      expect(nowSpy).toHaveBeenCalledTimes(0);
      expect(mkdirSpy).toHaveBeenCalledTimes(0);
      expect(readdirSpy).toHaveBeenCalledTimes(0);
    } finally {
      nowSpy.mockRestore();
      mkdirSpy.mockRestore();
      readdirSpy.mockRestore();
      if (previous === undefined) delete process.env.NANOCLAW_CONVERSATIONS_DIR;
      else process.env.NANOCLAW_CONVERSATIONS_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('creates the archive directory after the empty probe and reuses one clock reading', () => {
    const name = `runtime-exchange-order-${process.pid}`;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
    const conversationsDir = path.join(root, 'conversations');
    const previous = process.env.NANOCLAW_CONVERSATIONS_DIR;
    const calls: Array<{ directoryExists: boolean; nowMs: number; targetExists?: boolean }> = [];
    let clock = 200;
    const nowSpy = spyOn(Date, 'now').mockImplementation(() => ++clock);
    process.env.NANOCLAW_CONVERSATIONS_DIR = conversationsDir;
    registerProviderArchivePlanner(name, 'exchange', (value) => {
      const input = value as { nowMs: number; targetExists?: boolean };
      calls.push({
        directoryExists: fs.existsSync(conversationsDir),
        nowMs: input.nowMs,
        ...(input.targetExists === undefined ? {} : { targetExists: input.targetExists }),
      });
      return { relativePath: 'exchange.md', content: 'archive', write: 'append' };
    });
    registerProviderRuntimeContract(name, coreArchiveContract('exchange-complete', 'exchange'));

    try {
      expect(archiveProviderExchangeFromContract(name, { prompt: 'hello', result: 'world', status: 'completed' })).toBe(
        'exchange.md',
      );
      expect(calls).toEqual([
        { directoryExists: false, nowMs: 0, targetExists: false },
        { directoryExists: true, nowMs: 201 },
        { directoryExists: true, nowMs: 201, targetExists: false },
      ]);
      expect(nowSpy).toHaveBeenCalledTimes(1);
    } finally {
      nowSpy.mockRestore();
      if (previous === undefined) delete process.env.NANOCLAW_CONVERSATIONS_DIR;
      else process.env.NANOCLAW_CONVERSATIONS_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves mkdir-before-scan errors for non-empty exchange archives', () => {
    const name = `runtime-exchange-error-order-${process.pid}`;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
    const conversationsDir = path.join(root, 'not-a-directory');
    const previous = process.env.NANOCLAW_CONVERSATIONS_DIR;
    process.env.NANOCLAW_CONVERSATIONS_DIR = conversationsDir;
    fs.writeFileSync(conversationsDir, 'blocked');
    registerProviderArchivePlanner(name, 'exchange', () => ({
      relativePath: 'exchange.md',
      content: 'archive',
      write: 'append',
    }));
    registerProviderRuntimeContract(name, coreArchiveContract('exchange-complete', 'exchange'));

    try {
      expect(() =>
        archiveProviderExchangeFromContract(name, { prompt: 'hello', result: 'world', status: 'completed' }),
      ).toThrow(/EEXIST/);
    } finally {
      if (previous === undefined) delete process.env.NANOCLAW_CONVERSATIONS_DIR;
      else process.env.NANOCLAW_CONVERSATIONS_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows archive targets contained by the filesystem root', () => {
    const name = `runtime-exchange-root-${process.pid}`;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
    const target = path.join(root, 'exchange.md');
    const previous = process.env.NANOCLAW_CONVERSATIONS_DIR;
    process.env.NANOCLAW_CONVERSATIONS_DIR = path.parse(root).root;
    registerProviderArchivePlanner(name, 'exchange', () => ({
      relativePath: path.relative(path.parse(root).root, target),
      content: 'archive',
      write: 'append',
    }));
    registerProviderRuntimeContract(name, coreArchiveContract('exchange-complete', 'exchange'));

    try {
      expect(archiveProviderExchangeFromContract(name, { prompt: 'hello', result: 'world', status: 'completed' })).toBe(
        path.relative(path.parse(root).root, target),
      );
      expect(fs.readFileSync(target, 'utf-8')).toBe('archive');
    } finally {
      if (previous === undefined) delete process.env.NANOCLAW_CONVERSATIONS_DIR;
      else process.env.NANOCLAW_CONVERSATIONS_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('passes dangling selected-target existence to the archive planner', () => {
    const name = `runtime-exchange-dangling-${process.pid}`;
    const conversationsDir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
    const previous = process.env.NANOCLAW_CONVERSATIONS_DIR;
    process.env.NANOCLAW_CONVERSATIONS_DIR = conversationsDir;
    fs.symlinkSync('archive-target.md', path.join(conversationsDir, 'exchange.md'));
    registerProviderArchivePlanner(name, 'exchange', (value) => ({
      relativePath: 'exchange.md',
      content: (value as { targetExists?: boolean }).targetExists === false ? 'header\narchive' : 'archive',
      write: 'append',
    }));
    registerProviderRuntimeContract(name, coreArchiveContract('exchange-complete', 'exchange'));

    try {
      expect(archiveProviderExchangeFromContract(name, { prompt: 'hello', result: 'world', status: 'completed' })).toBe(
        'exchange.md',
      );
      expect(fs.readFileSync(path.join(conversationsDir, 'archive-target.md'), 'utf-8')).toBe('header\narchive');
    } finally {
      if (previous === undefined) delete process.env.NANOCLAW_CONVERSATIONS_DIR;
      else process.env.NANOCLAW_CONVERSATIONS_DIR = previous;
      fs.rmSync(conversationsDir, { recursive: true, force: true });
    }
  });

  it('reads Claude traces from the OS home even when CLAUDE_CONFIG_DIR diverges', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `runtime-trace-home-${process.pid}-`));
    const home = path.join(root, 'home');
    const config = path.join(root, 'config');
    const homeTrace = path.join(home, '.claude', 'projects', 'home-project', 'home.jsonl');
    const configTrace = path.join(config, 'projects', 'config-project', 'config.jsonl');
    fs.mkdirSync(path.dirname(homeTrace), { recursive: true });
    fs.mkdirSync(path.dirname(configTrace), { recursive: true });
    fs.writeFileSync(homeTrace, '{}\n');
    fs.writeFileSync(configTrace, '{}\n');
    const previousConfig = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = config;
    const homedirSpy = spyOn(os, 'homedir').mockReturnValue(home);

    try {
      expect(newestRegisteredTrace()).toBe(homeTrace);
    } finally {
      homedirSpy.mockRestore();
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousConfig;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('validates exchange-completion and continuation-rotation hooks in both directions', () => {
    const exchangeProvided = `runtime-exchange-provided-${process.pid}`;
    const exchangeWaived = `runtime-exchange-waived-${process.pid}`;
    registerProviderRuntimeContract(exchangeProvided, {
      ...emptyContract(),
      lifecycle: { ...emptyContract().lifecycle, exchangeCompletion: provided('provider-hook') },
    });
    registerProviderRuntimeContract(exchangeWaived, emptyContract());
    expect(() =>
      validateProviderRuntimeInstance(
        exchangeProvided,
        getProviderRuntimeContract(exchangeProvided)!,
        runtimeInstance(),
      ),
    ).toThrow(/exchangeCompletion.*onExchangeComplete/);
    expect(() =>
      validateProviderRuntimeInstance(
        exchangeWaived,
        getProviderRuntimeContract(exchangeWaived)!,
        runtimeInstance({ onExchangeComplete: () => {} }),
      ),
    ).toThrow(/exchangeCompletion.*onExchangeComplete/);

    const rotationProvided = `runtime-rotation-provided-${process.pid}`;
    const rotationWaived = `runtime-rotation-waived-${process.pid}`;
    registerProviderContinuationRotationPlanner(rotationProvided, 'rotation', () => null);
    registerProviderPathResolver(rotationProvided, 'state', () => '/tmp');
    registerProviderRuntimeContract(rotationProvided, {
      ...emptyContract(),
      continuationRotation: provided({
        owner: 'core',
        planner: 'rotation',
        pathResolver: 'state',
        searchSubdirectory: 'projects',
        extension: '.jsonl',
      }),
    });
    registerProviderRuntimeContract(rotationWaived, emptyContract());
    expect(() =>
      validateProviderRuntimeInstance(
        rotationProvided,
        getProviderRuntimeContract(rotationProvided)!,
        runtimeInstance(),
      ),
    ).toThrow(/continuationRotation.*maybeRotateContinuation/);
    expect(() =>
      validateProviderRuntimeInstance(
        rotationWaived,
        getProviderRuntimeContract(rotationWaived)!,
        runtimeInstance({ maybeRotateContinuation: () => null }),
      ),
    ).toThrow(/continuationRotation.*maybeRotateContinuation/);
  });

  it('executes a declared exchange archive plan', () => {
    const name = `runtime-exchange-archive-${process.pid}`;
    const conversationsDir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
    const previous = process.env.NANOCLAW_CONVERSATIONS_DIR;
    process.env.NANOCLAW_CONVERSATIONS_DIR = conversationsDir;
    registerProviderArchivePlanner(name, 'exchange', () => ({
      relativePath: 'exchange.md',
      content: 'archived\n',
      write: 'append',
    }));
    registerProviderRuntimeContract(name, coreArchiveContract('exchange-complete', 'exchange'));

    try {
      expect(archiveProviderExchangeFromContract(name, { prompt: 'hello', result: 'world', status: 'completed' })).toBe(
        'exchange.md',
      );
      expect(fs.readFileSync(path.join(conversationsDir, 'exchange.md'), 'utf-8')).toBe('archived\n');
    } finally {
      if (previous === undefined) delete process.env.NANOCLAW_CONVERSATIONS_DIR;
      else process.env.NANOCLAW_CONVERSATIONS_DIR = previous;
      fs.rmSync(conversationsDir, { recursive: true, force: true });
    }
  });
});
