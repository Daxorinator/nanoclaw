import path from 'path';

import {
  reconcileCodexHooksJson,
  renderCodexConfigToml,
  type CodexMemorySessionHook,
} from '../providers/codex-app-server.js';
import { planProviderExchangeArchive } from '../providers/exchange-archive.js';
import type { McpServerConfig, ProviderExchange } from '../providers/types.js';

import {
  provided,
  registerProviderArchivePlanner,
  registerProviderPathResolver,
  registerProviderRuntimeContract,
  registerProviderRuntimeFileTransformer,
  waived,
} from './registry.js';

const provider = 'codex';

interface CodexConfigContext {
  servers: Record<string, McpServerConfig>;
  memorySessionHook: CodexMemorySessionHook;
  options: { model?: string; effort?: string };
}

registerProviderPathResolver(provider, 'config-directory', () => path.join(process.env.HOME || '/home/node', '.codex'));
registerProviderRuntimeFileTransformer(provider, 'config-toml', ({ context }) => {
  const input = context as CodexConfigContext;
  return { kind: 'replace', content: renderCodexConfigToml(input.servers, input.options) };
});
registerProviderRuntimeFileTransformer(provider, 'memory-hooks', ({ exists, content, context, filePath }) => {
  const input = context as CodexConfigContext;
  return { kind: 'replace', content: reconcileCodexHooksJson(content, input.memorySessionHook, filePath, exists) };
});
registerProviderArchivePlanner(provider, 'thread-markdown', planExchangeArchive);

registerProviderRuntimeContract(provider, {
  managedFiles: provided([
    {
      id: 'config-toml',
      pathResolver: 'config-directory',
      relativePath: 'config.toml',
      when: 'before-query',
      transformer: 'config-toml',
      read: 'none',
      write: 'direct-replace',
    },
    {
      id: 'memory-hooks',
      pathResolver: 'config-directory',
      relativePath: 'hooks.json',
      when: 'before-query',
      transformer: 'memory-hooks',
      read: 'text-if-present',
      write: 'direct-replace',
    },
  ]),
  archives: provided({ trigger: 'exchange-complete', owner: 'core', planner: 'thread-markdown' }),
  continuationRotation: waived('Codex keeps continuation history in the app-server'),
  traceReaders: waived('Codex has no local trace reader'),
  attachments: provided({ initial: 'text-only', followUp: 'text-only' }),
  events: ['activity', 'init', 'progress', 'error', 'file', 'result'],
  textDelivery: 'result',
  lifecycle: {
    memory: provided('native-session-hook'),
    compaction: waived('Codex app-server owns its context lifecycle'),
    continuation: provided('opaque-token'),
    exchangeCompletion: provided('provider-hook'),
  },
  commands: { formatting: 'xml', nativeAdmin: [], nativeFiltered: [] },
});

function planExchangeArchive(value: unknown): { relativePath: string; content: string; write: 'append' } | null {
  const { exchange, entries, nowMs, targetExists } = value as {
    exchange: ProviderExchange;
    entries: string[];
    nowMs: number;
    targetExists?: boolean;
  };
  return planProviderExchangeArchive({
    provider,
    prompt: exchange.prompt,
    result: exchange.result,
    continuation: exchange.continuation,
    status: exchange.status,
    timestamp: new Date(nowMs),
    entries,
    targetExists,
  });
}
