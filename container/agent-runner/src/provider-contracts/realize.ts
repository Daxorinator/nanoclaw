import fs from 'fs';
import path from 'path';

import {
  getProviderRuntimeContract,
  getProviderArchivePlanner,
  getProviderContinuationRotationPlanner,
  getProviderRuntimeFileTransformer,
  getProviderPathResolver,
  listRegisteredTraceReaders,
} from './registry.js';
import type { AgentProvider } from '../providers/types.js';
import type { ProviderExchange } from '../providers/types.js';
import type { MemorySessionHookRegistration } from '../memory/session-hook.js';

export function realizeProviderManagedFiles(provider: string, when: string, context: unknown): void {
  const contract = getProviderRuntimeContract(provider);
  if (!contract || contract.managedFiles.kind === 'waived') return;
  const preparedDirectories = new Set<string>();

  for (const file of contract.managedFiles.value) {
    if (file.when !== when) continue;
    const transformer = getProviderRuntimeFileTransformer(provider, file.transformer);
    if (!transformer) {
      throw new Error(`Provider '${provider}' managed file '${file.id}' has no transformer '${file.transformer}'`);
    }

    const resolveRoot = getProviderPathResolver(provider, file.pathResolver);
    if (!resolveRoot) {
      throw new Error(`Provider '${provider}' managed file '${file.id}' has no path resolver '${file.pathResolver}'`);
    }
    const filePath = resolveContainedPath(
      resolveRoot(),
      file.relativePath,
      `Provider '${provider}' managed file '${file.id}' returned unsafe path`,
    );
    const directory = path.dirname(filePath);
    if (!preparedDirectories.has(directory)) {
      fs.mkdirSync(directory, { recursive: true });
      preparedDirectories.add(directory);
    }
    let exists = false;
    let content = '';
    if (file.read === 'text-if-present') {
      exists = fs.existsSync(filePath);
      if (exists) content = fs.readFileSync(filePath, 'utf-8');
    }
    const result = transformer({
      exists,
      content,
      context,
      filePath,
    });
    if (result.kind === 'replace') fs.writeFileSync(filePath, result.content);
  }
}

export function registerProviderMemorySessionHook(
  providerName: string,
  provider: AgentProvider,
  hook: MemorySessionHookRegistration,
): void {
  realizeProviderManagedFiles(providerName, 'memory-session-hook-registration', hook);
  provider.registerMemorySessionHook(hook);
}

export function newestRegisteredTrace(): string | null {
  for (const reader of listRegisteredTraceReaders()) {
    const found = reader();
    if (found) return found;
  }
  return null;
}

export function archiveProviderTranscript(
  provider: string,
  transcriptPath: string | undefined,
  sessionId: string | undefined,
  assistantName: string | undefined,
  log: (message: string) => void,
): boolean {
  const contract = getProviderRuntimeContract(provider);
  const archive =
    contract?.archives.kind === 'provided' && contract.archives.value.trigger === 'pre-compact'
      ? contract.archives.value
      : undefined;
  const planner =
    archive?.owner === 'core' && archive.planner ? getProviderArchivePlanner(provider, archive.planner) : undefined;
  if (!planner) return false;
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    log('No transcript found for archiving');
    return false;
  }

  try {
    const transcriptContent = fs.readFileSync(transcriptPath, 'utf-8');
    const emptyClockMs = { beforeDirectory: [], afterDirectory: [] };
    const probe = planner({
      transcriptContent,
      sessionId,
      assistantName,
      clockMs: emptyClockMs,
    });
    if (!probe) return false;

    const indexPath = path.join(path.dirname(transcriptPath), 'sessions-index.json');
    let sessionsIndexContent: string | undefined;
    if (fs.existsSync(indexPath)) {
      try {
        sessionsIndexContent = fs.readFileSync(indexPath, 'utf-8');
      } catch {
        // Transcript archival remains best-effort when the optional index is unreadable.
      }
    }
    const planInput = {
      transcriptContent,
      sessionsIndexContent,
      sessionId,
      assistantName,
    };
    let plan = planner({ ...planInput, clockMs: emptyClockMs });
    const conversationsDir = process.env.NANOCLAW_CONVERSATIONS_DIR || '/workspace/agent/conversations';
    let directoryPrepared = false;
    if (plan?.clockSamples) {
      const beforeDirectory = Array.from({ length: plan.clockSamples.beforeDirectory }, () => Date.now());
      fs.mkdirSync(conversationsDir, { recursive: true });
      directoryPrepared = true;
      const afterDirectory = Array.from({ length: plan.clockSamples.afterDirectory }, () => Date.now());
      const clockMs = { beforeDirectory, afterDirectory };
      plan = planner({ ...planInput, clockMs });
    }
    if (!plan) return false;

    const target = resolveContainedPath(conversationsDir, plan.relativePath, 'Archive planner returned unsafe path');
    if (!directoryPrepared) fs.mkdirSync(conversationsDir, { recursive: true });
    writeArchivePlan(target, plan.write, plan.content);
    log(`Archived conversation to ${plan.relativePath}`);
    return true;
  } catch (error) {
    log(`Failed to archive transcript: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

export function archiveProviderExchangeFromContract(provider: string, exchange: ProviderExchange): string | null {
  const contract = getProviderRuntimeContract(provider);
  const archive = contract?.archives.kind === 'provided' ? contract.archives.value : undefined;
  const planner =
    archive?.trigger === 'exchange-complete' && archive.owner === 'core' && archive.planner
      ? getProviderArchivePlanner(provider, archive.planner)
      : undefined;
  if (!planner) return null;

  const probe = planner({ exchange, entries: [], nowMs: 0, targetExists: false, probe: true });
  if (!probe) return null;
  const nowMs = Date.now();

  const conversationsDir = process.env.NANOCLAW_CONVERSATIONS_DIR || '/workspace/agent/conversations';
  fs.mkdirSync(conversationsDir, { recursive: true });
  const entries = fs.readdirSync(conversationsDir);
  const selected = planner({ exchange, entries, nowMs });
  if (!selected) return null;
  const selectedTarget = resolveContainedPath(
    conversationsDir,
    selected.relativePath,
    'Archive planner returned unsafe path',
  );
  const plan = planner({
    exchange,
    entries,
    nowMs,
    targetExists: fs.existsSync(selectedTarget),
  });
  if (!plan) return null;
  const target = resolveContainedPath(conversationsDir, plan.relativePath, 'Archive planner returned unsafe path');
  writeArchivePlan(target, plan.write, plan.content);
  return plan.relativePath;
}

export function maybeRotateProviderContinuation(
  provider: string,
  continuation: string,
  assistantName: string | undefined,
  log: (message: string) => void,
): string | null {
  const contract = getProviderRuntimeContract(provider);
  const rotation = contract?.continuationRotation.kind === 'provided' ? contract.continuationRotation.value : undefined;
  if (
    rotation?.owner !== 'core' ||
    !rotation.planner ||
    !rotation.pathResolver ||
    !rotation.searchSubdirectory ||
    !rotation.extension
  ) {
    return null;
  }
  const planner = getProviderContinuationRotationPlanner(provider, rotation.planner);
  const resolveRoot = getProviderPathResolver(provider, rotation.pathResolver);
  if (!planner || !resolveRoot) return null;

  const transcriptPath = findContinuationFile(
    path.join(resolveRoot(), rotation.searchSubdirectory),
    `${continuation}${rotation.extension}`,
  );
  if (!transcriptPath) return null;

  try {
    const size = fs.statSync(transcriptPath).size;
    let firstLine = '';
    try {
      firstLine = readFirstLine(transcriptPath);
    } catch {
      // Size-only rotation must survive an unreadable first entry.
    }
    const planInput = {
      size,
      firstLine,
      environment: process.env,
    };
    let plan = planner(planInput);
    if (plan?.clockSamples) {
      plan = planner({ ...planInput, nowMs: Date.now() });
    }
    if (!plan?.reason) return null;

    archiveProviderTranscript(provider, transcriptPath, continuation, assistantName, log);
    try {
      fs.renameSync(transcriptPath, `${transcriptPath}.rotated-${Date.now()}`);
    } catch (error) {
      log(`Failed to move rotated transcript aside: ${error instanceof Error ? error.message : String(error)}`);
    }
    return plan.reason;
  } catch {
    return null;
  }
}

function findContinuationFile(root: string, fileName: string): string | null {
  let directories: string[];
  try {
    directories = fs.readdirSync(root);
  } catch {
    return null;
  }
  for (const directory of directories) {
    const candidate = path.join(root, directory, fileName);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function readFirstLine(filePath: string): string {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(4096);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.toString('utf-8', 0, bytes).split('\n', 1)[0];
  } finally {
    fs.closeSync(fd);
  }
}

function writeArchivePlan(filePath: string, operation: 'replace' | 'append', content: string): void {
  if (operation === 'append') fs.appendFileSync(filePath, content);
  else fs.writeFileSync(filePath, content);
}

function resolveContainedPath(root: string, relativePath: string, errorPrefix: string): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relativePath);
  const relative = path.relative(resolvedRoot, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${errorPrefix} '${relativePath}'`);
  }
  return target;
}
