/** Container-runtime provider declarations. Functions stay in a separate registry. */

import path from 'path';

import type { AgentProvider } from '../providers/types.js';

export type ContractAnswer<T> = { kind: 'provided'; value: T } | { kind: 'waived'; reason: string };

export type RuntimeEventKind = 'init' | 'result' | 'text' | 'error' | 'progress' | 'file' | 'activity';

export interface RuntimeManagedFile {
  id: string;
  pathResolver: string;
  relativePath: string;
  when: 'memory-session-hook-registration' | 'before-query';
  transformer: string;
  read: 'none' | 'text-if-present';
  write: 'direct-replace';
}

export interface ProviderRuntimeContract {
  managedFiles: ContractAnswer<readonly RuntimeManagedFile[]>;
  archives: ContractAnswer<{
    trigger: 'pre-compact' | 'exchange-complete';
    owner: 'core' | 'legacy-provider';
    planner?: string;
  }>;
  continuationRotation: ContractAnswer<{
    owner: 'core' | 'legacy-provider';
    planner?: string;
    pathResolver?: string;
    searchSubdirectory?: string;
    extension?: string;
  }>;
  traceReaders: ContractAnswer<readonly { id: string; reader: string }[]>;
  attachments: ContractAnswer<{ initial: 'text-only'; followUp: 'text-only' }>;
  events: readonly RuntimeEventKind[];
  textDelivery: 'mid-turn-complete' | 'result';
  lifecycle: {
    memory: ContractAnswer<'native-session-hook'>;
    compaction: ContractAnswer<'provider-hook' | 'provider-native'>;
    continuation: ContractAnswer<'opaque-token'>;
    exchangeCompletion: ContractAnswer<'provider-hook'>;
  };
  commands: {
    formatting: 'native' | 'xml';
    nativeAdmin: readonly string[];
    nativeFiltered: readonly string[];
  };
}

export interface RuntimeFileTransformInput {
  exists: boolean;
  content: string;
  context: unknown;
  filePath: string;
}

export type RuntimeFileTransformResult = { kind: 'unchanged' } | { kind: 'replace'; content: string };
export type RuntimeFileTransformer = (input: RuntimeFileTransformInput) => RuntimeFileTransformResult;
export type ProviderTraceReader = () => string | null;
export type ProviderPathResolver = () => string;
export interface RuntimeArchivePlan {
  relativePath: string;
  content: string;
  write: 'replace' | 'append';
  clockSamples?: {
    beforeDirectory: number;
    afterDirectory: number;
  };
}
export type RuntimeArchivePlanner = (input: unknown) => RuntimeArchivePlan | null;
export interface RuntimeContinuationRotationPlan {
  reason?: string;
  clockSamples?: 1;
}
export type RuntimeContinuationRotationPlanner = (input: unknown) => RuntimeContinuationRotationPlan | null;

const contracts = new Map<string, ProviderRuntimeContract>();
const fileTransformers = new Map<string, RuntimeFileTransformer>();
const traceReaders = new Map<string, ProviderTraceReader>();
const pathResolvers = new Map<string, ProviderPathResolver>();
const archivePlanners = new Map<string, RuntimeArchivePlanner>();
const rotationPlanners = new Map<string, RuntimeContinuationRotationPlanner>();

export function provided<T>(value: T): ContractAnswer<T> {
  return { kind: 'provided', value };
}

export function waived<T = never>(reason: string): ContractAnswer<T> {
  return { kind: 'waived', reason };
}

export function registerProviderRuntimeContract(name: string, contract: ProviderRuntimeContract): void {
  const key = providerKey(name);
  if (contracts.has(key)) throw new Error(`Provider runtime contract already registered: ${key}`);
  validateContract(key, contract);
  contracts.set(key, immutableJsonClone(contract));
}

export function getProviderRuntimeContract(name: string | null | undefined): ProviderRuntimeContract | undefined {
  return name ? contracts.get(name.toLowerCase()) : undefined;
}

export function hasDeclaredProviderRuntimeContract(name: string | null | undefined): boolean {
  return getProviderRuntimeContract(name) !== undefined;
}

export function listProviderRuntimeContractNames(): string[] {
  return [...contracts.keys()];
}

export function listProviderRuntimeContracts(): readonly ProviderRuntimeContract[] {
  return [...contracts.values()];
}

export function listRegisteredTraceReaders(): readonly ProviderTraceReader[] {
  const readers: ProviderTraceReader[] = [];
  for (const [provider, contract] of contracts) {
    if (contract.traceReaders.kind === 'waived') continue;
    for (const trace of contract.traceReaders.value) {
      const reader = getProviderTraceReader(provider, trace.reader);
      if (reader) readers.push(reader);
    }
  }
  return readers;
}

export function registerProviderRuntimeFileTransformer(
  provider: string,
  name: string,
  transformer: RuntimeFileTransformer,
): void {
  const key = `${providerKey(provider)}:${contractName(name, 'file transformer')}`;
  if (fileTransformers.has(key)) throw new Error(`Provider runtime file transformer already registered: ${key}`);
  fileTransformers.set(key, transformer);
}

export function getProviderRuntimeFileTransformer(provider: string, name: string): RuntimeFileTransformer | undefined {
  return fileTransformers.get(`${provider.toLowerCase()}:${name}`);
}

export function registerProviderPathResolver(provider: string, name: string, resolver: ProviderPathResolver): void {
  const key = `${providerKey(provider)}:${contractName(name, 'path resolver')}`;
  if (pathResolvers.has(key)) throw new Error(`Provider path resolver already registered: ${key}`);
  pathResolvers.set(key, resolver);
}

export function getProviderPathResolver(provider: string, name: string): ProviderPathResolver | undefined {
  return pathResolvers.get(`${provider.toLowerCase()}:${name}`);
}

export function registerProviderTraceReader(provider: string, name: string, reader: ProviderTraceReader): void {
  const key = `${providerKey(provider)}:${contractName(name, 'trace reader')}`;
  if (traceReaders.has(key)) throw new Error(`Provider trace reader already registered: ${key}`);
  traceReaders.set(key, reader);
}

export function getProviderTraceReader(provider: string, name: string): ProviderTraceReader | undefined {
  return traceReaders.get(`${provider.toLowerCase()}:${name}`);
}

export function registerProviderArchivePlanner(provider: string, name: string, planner: RuntimeArchivePlanner): void {
  registerFunction(archivePlanners, provider, name, 'archive planner', planner);
}

export function getProviderArchivePlanner(provider: string, name: string): RuntimeArchivePlanner | undefined {
  return archivePlanners.get(`${provider.toLowerCase()}:${name}`);
}

export function registerProviderContinuationRotationPlanner(
  provider: string,
  name: string,
  planner: RuntimeContinuationRotationPlanner,
): void {
  registerFunction(rotationPlanners, provider, name, 'continuation rotation planner', planner);
}

export function getProviderContinuationRotationPlanner(
  provider: string,
  name: string,
): RuntimeContinuationRotationPlanner | undefined {
  return rotationPlanners.get(`${provider.toLowerCase()}:${name}`);
}

export function validateProviderRuntimeInstance(
  provider: string,
  contract: ProviderRuntimeContract,
  instance: AgentProvider,
): void {
  const native = contract.commands.formatting === 'native';
  if (instance.supportsNativeSlashCommands !== native) {
    throw new Error(
      `Provider '${provider}' runtime contract commands.formatting does not match supportsNativeSlashCommands`,
    );
  }
  const emitsMidTurnText = contract.textDelivery === 'mid-turn-complete';
  if (Boolean(instance.emitsMidTurnText) !== emitsMidTurnText) {
    throw new Error(`Provider '${provider}' runtime contract textDelivery does not match emitsMidTurnText`);
  }
  const hasExchangeCompletion = typeof instance.onExchangeComplete === 'function';
  if ((contract.lifecycle.exchangeCompletion.kind === 'provided') !== hasExchangeCompletion) {
    throw new Error(
      `Provider '${provider}' runtime contract lifecycle.exchangeCompletion does not match onExchangeComplete`,
    );
  }
  const hasContinuationRotation = typeof instance.maybeRotateContinuation === 'function';
  if ((contract.continuationRotation.kind === 'provided') !== hasContinuationRotation) {
    throw new Error(
      `Provider '${provider}' runtime contract continuationRotation does not match maybeRotateContinuation`,
    );
  }
}

function validateContract(provider: string, contract: ProviderRuntimeContract): void {
  assertPureJson(contract, provider);
  for (const [field, answer] of Object.entries({
    managedFiles: contract.managedFiles,
    archives: contract.archives,
    continuationRotation: contract.continuationRotation,
    traceReaders: contract.traceReaders,
    attachments: contract.attachments,
    'lifecycle.memory': contract.lifecycle?.memory,
    'lifecycle.compaction': contract.lifecycle?.compaction,
    'lifecycle.continuation': contract.lifecycle?.continuation,
    'lifecycle.exchangeCompletion': contract.lifecycle?.exchangeCompletion,
  })) {
    validateAnswer(answer, `${provider}.${field}`);
  }

  if (!Array.isArray(contract.events)) throw new Error(`${provider}.events is required`);
  for (const event of contract.events) {
    assertAllowed(event, ['init', 'result', 'text', 'error', 'progress', 'file', 'activity'], `${provider}.events[]`);
  }
  unique(contract.events, `${provider}.events`);
  assertAllowed(contract.textDelivery, ['mid-turn-complete', 'result'], `${provider}.textDelivery`);
  if (contract.textDelivery === 'mid-turn-complete' && !contract.events.includes('text')) {
    throw new Error(`${provider}.textDelivery 'mid-turn-complete' requires a text event`);
  }
  assertAllowed(contract.commands?.formatting, ['native', 'xml'], `${provider}.commands.formatting`);
  assertCommandArray(contract.commands?.nativeAdmin, `${provider}.commands.nativeAdmin`);
  assertCommandArray(contract.commands?.nativeFiltered, `${provider}.commands.nativeFiltered`);
  unique(contract.commands.nativeAdmin, `${provider}.commands.nativeAdmin`);
  unique(contract.commands.nativeFiltered, `${provider}.commands.nativeFiltered`);

  if (contract.managedFiles.kind === 'provided') {
    if (!Array.isArray(contract.managedFiles.value)) throw new Error(`${provider}.managedFiles.value must be an array`);
    unique(
      contract.managedFiles.value.map((file) => file.id),
      `${provider}.managedFiles[].id`,
    );
    unique(
      contract.managedFiles.value.map((file) => `${file.pathResolver}:${file.relativePath}`),
      `${provider}.managedFiles[] paths`,
    );
    for (const file of contract.managedFiles.value) {
      contractName(file.id, `${provider}.managedFiles[].id`);
      contractName(file.transformer, `${provider}.managedFiles.${file.id}.transformer`);
      contractName(file.pathResolver, `${provider}.managedFiles.${file.id}.pathResolver`);
      assertRelativePath(file.relativePath, `${provider}.managedFiles.${file.id}.relativePath`);
      assertAllowed(
        file.when,
        ['memory-session-hook-registration', 'before-query'],
        `${provider}.managedFiles.${file.id}.when`,
      );
      assertAllowed(file.read, ['none', 'text-if-present'], `${provider}.managedFiles.${file.id}.read`);
      assertAllowed(file.write, ['direct-replace'], `${provider}.managedFiles.${file.id}.write`);
      if (!getProviderPathResolver(provider, file.pathResolver)) {
        throw new Error(`${provider}.managedFiles.${file.id} references missing path resolver '${file.pathResolver}'`);
      }
      if (!getProviderRuntimeFileTransformer(provider, file.transformer)) {
        throw new Error(`${provider}.managedFiles.${file.id} references missing transformer '${file.transformer}'`);
      }
    }
  }

  if (contract.traceReaders.kind === 'provided') {
    if (!Array.isArray(contract.traceReaders.value)) throw new Error(`${provider}.traceReaders.value must be an array`);
    unique(
      contract.traceReaders.value.map((reader) => reader.id),
      `${provider}.traceReaders[].id`,
    );
    for (const trace of contract.traceReaders.value) {
      contractName(trace.id, `${provider}.traceReaders[].id`);
      contractName(trace.reader, `${provider}.traceReaders.${trace.id}.reader`);
      if (!getProviderTraceReader(provider, trace.reader)) {
        throw new Error(`${provider}.traceReaders.${trace.id} references missing reader '${trace.reader}'`);
      }
    }
  }

  if (contract.archives.kind === 'provided') {
    assertAllowed(
      contract.archives.value?.trigger,
      ['pre-compact', 'exchange-complete'],
      `${provider}.archives.value.trigger`,
    );
    assertAllowed(contract.archives.value?.owner, ['core', 'legacy-provider'], `${provider}.archives.value.owner`);
  }

  if (contract.continuationRotation.kind === 'provided') {
    assertAllowed(
      contract.continuationRotation.value?.owner,
      ['core', 'legacy-provider'],
      `${provider}.continuationRotation.value.owner`,
    );
  }

  if (contract.attachments.kind === 'provided') {
    assertAllowed(contract.attachments.value?.initial, ['text-only'], `${provider}.attachments.value.initial`);
    assertAllowed(contract.attachments.value?.followUp, ['text-only'], `${provider}.attachments.value.followUp`);
  }

  if (contract.lifecycle.memory.kind !== 'provided') {
    throw new Error(`${provider}.lifecycle.memory cannot be waived because shared memory is required`);
  }
  assertAllowed(contract.lifecycle.memory.value, ['native-session-hook'], `${provider}.lifecycle.memory.value`);
  if (contract.lifecycle.compaction.kind === 'provided') {
    assertAllowed(
      contract.lifecycle.compaction.value,
      ['provider-hook', 'provider-native'],
      `${provider}.lifecycle.compaction.value`,
    );
  }
  if (contract.lifecycle.continuation.kind === 'provided') {
    assertAllowed(contract.lifecycle.continuation.value, ['opaque-token'], `${provider}.lifecycle.continuation.value`);
  }
  if (contract.lifecycle.exchangeCompletion.kind === 'provided') {
    assertAllowed(
      contract.lifecycle.exchangeCompletion.value,
      ['provider-hook'],
      `${provider}.lifecycle.exchangeCompletion.value`,
    );
  }

  if (contract.archives.kind === 'provided' && contract.archives.value.owner === 'core') {
    const archive = contract.archives.value;
    const planner = archive.planner;
    if (!planner || !getProviderArchivePlanner(provider, planner)) {
      throw new Error(`${provider}.archives references missing planner '${planner ?? ''}'`);
    }
    if (archive.trigger === 'exchange-complete' && contract.lifecycle.exchangeCompletion.kind !== 'provided') {
      throw new Error(`${provider}.archives exchange-complete trigger requires lifecycle.exchangeCompletion`);
    }
    if (
      archive.trigger === 'pre-compact' &&
      (contract.lifecycle.compaction.kind !== 'provided' || contract.lifecycle.compaction.value !== 'provider-hook')
    ) {
      throw new Error(`${provider}.archives pre-compact trigger requires lifecycle.compaction 'provider-hook'`);
    }
  } else if (contract.archives.kind === 'provided' && contract.archives.value.owner === 'legacy-provider') {
    if (contract.archives.value.planner !== undefined) {
      throw new Error(`${provider}.archives.value.planner must be omitted for owner 'legacy-provider'`);
    }
  }

  if (contract.continuationRotation.kind === 'provided' && contract.continuationRotation.value.owner === 'core') {
    const rotation = contract.continuationRotation.value;
    if (!rotation.planner || !getProviderContinuationRotationPlanner(provider, rotation.planner)) {
      throw new Error(`${provider}.continuationRotation references missing planner '${rotation.planner ?? ''}'`);
    }
    if (!rotation.pathResolver || !getProviderPathResolver(provider, rotation.pathResolver)) {
      throw new Error(
        `${provider}.continuationRotation references missing path resolver '${rotation.pathResolver ?? ''}'`,
      );
    }
    assertRelativePath(rotation.searchSubdirectory ?? '', `${provider}.continuationRotation.searchSubdirectory`);
    if (!rotation.extension?.startsWith('.') || rotation.extension.includes('/') || rotation.extension.includes('\\')) {
      throw new Error(`${provider}.continuationRotation.extension must be a file extension`);
    }
  } else if (
    contract.continuationRotation.kind === 'provided' &&
    contract.continuationRotation.value.owner === 'legacy-provider'
  ) {
    const rotation = contract.continuationRotation.value;
    for (const field of ['planner', 'pathResolver', 'searchSubdirectory', 'extension'] as const) {
      if (rotation[field] !== undefined) {
        throw new Error(`${provider}.continuationRotation.value.${field} must be omitted for owner 'legacy-provider'`);
      }
    }
  }
}

function registerFunction<T>(
  registry: Map<string, T>,
  provider: string,
  name: string,
  label: string,
  implementation: T,
): void {
  const key = `${providerKey(provider)}:${contractName(name, label)}`;
  if (registry.has(key)) throw new Error(`Provider runtime ${label} already registered: ${key}`);
  registry.set(key, implementation);
}

function providerKey(name: string): string {
  const key = name.toLowerCase();
  if (name !== key || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`Provider runtime contract name must be lowercase kebab-case: '${name}'`);
  }
  return key;
}

function contractName(name: string, field: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error(`${field} must be lowercase kebab-case`);
  return name;
}

function validateAnswer(answer: unknown, field: string): void {
  const candidate = answer as { kind?: unknown; reason?: unknown } | null | undefined;
  assertAllowed(candidate?.kind, ['provided', 'waived'], `${field}.kind`);
  if (candidate?.kind === 'provided') {
    if (!Object.prototype.hasOwnProperty.call(candidate, 'value')) throw new Error(`${field}.value is required`);
  } else if (typeof candidate?.reason !== 'string' || !candidate.reason.trim()) {
    throw new Error(`${field} waiver requires a reason`);
  }
}

function assertAllowed(value: unknown, allowed: readonly unknown[], field: string): void {
  if (!allowed.includes(value)) {
    throw new Error(`${field} must be one of ${allowed.map((entry) => `'${String(entry)}'`).join(', ')}`);
  }
}

function unique(values: readonly string[], field: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`${field} must be unique; duplicate '${value}'`);
    seen.add(value);
  }
}

function assertRelativePath(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.includes('\\') ||
    value.endsWith('/') ||
    path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    value.split('/').includes('..') ||
    value === '.'
  ) {
    throw new Error(`${field} must be a canonical relative path`);
  }
}

function assertCommandArray(value: unknown, field: string): asserts value is readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  for (const command of value) {
    if (typeof command !== 'string' || !/^\/[a-z0-9-]+$/.test(command)) {
      throw new Error(`${field} contains invalid command '${String(command)}'`);
    }
  }
}

function assertPureJson(value: unknown, field: string): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${field} must contain only finite JSON numbers`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertPureJson(entry, `${field}[${index}]`));
    return;
  }
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${field} must be pure JSON`);
  }
  for (const [key, entry] of Object.entries(value)) assertPureJson(entry, `${field}.${key}`);
}

function immutableJsonClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
