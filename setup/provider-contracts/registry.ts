import { getSetupProvider } from '../providers/registry.js';
import { getProviderDescriptor } from '../providers/skill-descriptor.js';

export type SetupContractAnswer<T> = { kind: 'provided'; value: T } | { kind: 'waived'; reason: string };

export interface ProviderSetupContract {
  installOffer: SetupContractAnswer<'built-in' | 'skill-descriptor'>;
  installSkill: SetupContractAnswer<string>;
  image: SetupContractAnswer<'hardened-compatible' | 'local-required'>;
  auth: SetupContractAnswer<'standard' | 'provider'>;
  installVerification: SetupContractAnswer<'provider'>;
  failureAssist: SetupContractAnswer<'provider' | 'claude-fallback'>;
}

const contracts = new Map<string, ProviderSetupContract>();

export function provided<T>(value: T): SetupContractAnswer<T> {
  return { kind: 'provided', value };
}

export function waived<T = never>(reason: string): SetupContractAnswer<T> {
  return { kind: 'waived', reason };
}

export function registerProviderSetupContract(name: string, contract: ProviderSetupContract): void {
  const key = name.toLowerCase();
  if (name !== key || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`Provider setup contract name must be lowercase kebab-case: '${name}'`);
  }
  if (contracts.has(key)) throw new Error(`Provider setup contract already registered: ${key}`);
  assertPureJson(contract, key);
  for (const [field, allowed] of [
    ['installOffer', ['built-in', 'skill-descriptor']],
    ['installSkill', undefined],
    ['image', ['hardened-compatible', 'local-required']],
    ['auth', ['standard', 'provider']],
    ['installVerification', ['provider']],
    ['failureAssist', ['provider', 'claude-fallback']],
  ] as const) {
    const answer = contract[field];
    validateAnswer(answer, `${key}.${field}`);
    if (answer.kind !== 'provided') continue;
    if (allowed) assertAllowed(answer.value, allowed, `${key}.${field}.value`);
    else if (typeof answer.value !== 'string' || !answer.value.trim()) {
      throw new Error(`${key}.${field}.value must be a non-empty string`);
    }
  }
  contracts.set(key, immutableJsonClone(contract));
}

export function getProviderSetupContract(name: string | null | undefined): ProviderSetupContract | undefined {
  return name ? contracts.get(name.toLowerCase()) : undefined;
}

export function listProviderSetupContractNames(): string[] {
  return [...contracts.keys()];
}

export function providerImagePolicy(provider: string): 'local-required' | 'hardened-compatible' {
  const normalized = provider.toLowerCase();
  const declared = getProviderSetupContract(normalized)?.image;
  if (declared?.kind === 'provided') return declared.value;
  return (
    getProviderDescriptor(normalized)?.image ?? (normalized === 'claude' ? 'hardened-compatible' : 'local-required')
  );
}

export function assertSetupProviderConformance(): void {
  for (const [provider, contract] of contracts) {
    const entry = getSetupProvider(provider);
    const descriptor = getProviderDescriptor(provider);
    if (contract.installOffer.kind === 'provided' && contract.installOffer.value === 'skill-descriptor') {
      if (!descriptor?.offered) throw new Error(`${provider}.installOffer requires an offered skill descriptor`);
    }
    if (contract.installSkill.kind === 'provided' && descriptor?.installSkill !== contract.installSkill.value) {
      throw new Error(`${provider}.installSkill does not match its skill descriptor`);
    }
    if (contract.image.kind === 'provided' && descriptor && descriptor.image !== contract.image.value) {
      throw new Error(`${provider}.image does not match its skill descriptor`);
    }
    if (contract.auth.kind === 'provided') {
      if (!entry) throw new Error(`Provider '${provider}' setup contract has no setup registration`);
      if (contract.auth.value === 'provider' && !entry.runAuth) throw new Error(`${provider}.auth requires runAuth`);
      if (contract.auth.value === 'standard' && entry.runAuth) {
        throw new Error(`${provider}.auth standard must not provide runAuth`);
      }
    }
    if (contract.installVerification.kind === 'provided' && !entry?.runInstallCheck) {
      throw new Error(`${provider}.installVerification requires runInstallCheck`);
    }
    if (
      contract.failureAssist.kind === 'provided' &&
      contract.failureAssist.value === 'provider' &&
      !entry?.offerFailureAssist
    ) {
      throw new Error(`${provider}.failureAssist requires offerFailureAssist`);
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
