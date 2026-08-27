import { describe, expect, it } from 'vitest';

import './index.js';
import '../providers/index.js';
import {
  assertSetupProviderConformance,
  getProviderSetupContract,
  providerImagePolicy,
  provided,
  registerProviderSetupContract,
  waived,
} from './registry.js';

const missing = Symbol('missing');

function setupContractWith(path: string, value: unknown | typeof missing) {
  const contract = structuredClone(getProviderSetupContract('claude')!);
  const parts = path.split('.');
  let target = contract as unknown as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) target = target[part] as Record<string, unknown>;
  const field = parts.at(-1)!;
  if (value === missing) delete target[field];
  else target[field] = value;
  return contract;
}

function contractName(field: string, suffix: string): string {
  return `setup-${field}-${suffix}-${process.pid}`.replaceAll(/[^a-z0-9-]/g, '-');
}

describe('provider setup contracts', () => {
  it('loads and validates the complete Claude setup declaration', () => {
    expect(getProviderSetupContract('CLAUDE')).toEqual({
      installOffer: provided('built-in'),
      installSkill: waived('Claude is built into the checkout'),
      image: provided('hardened-compatible'),
      auth: provided('standard'),
      installVerification: waived('Claude is built into the checkout'),
      failureAssist: provided('claude-fallback'),
    });
    expect(assertSetupProviderConformance).not.toThrow();
  });

  it('defaults only Claude to hardened-compatible images', () => {
    expect(providerImagePolicy('CLAUDE')).toBe('hardened-compatible');
    expect(providerImagePolicy('unknown-provider')).toBe('local-required');
  });

  it('rejects incomplete and non-JSON setup declarations at registration', () => {
    const base = getProviderSetupContract('claude')!;
    expect(() =>
      registerProviderSetupContract(`setup-empty-waiver-${process.pid}`, {
        ...base,
        auth: waived(''),
      }),
    ).toThrow(/waiver requires a reason/);
    expect(() =>
      registerProviderSetupContract(`setup-non-json-${process.pid}`, {
        ...base,
        extra: () => undefined,
      } as unknown as typeof base),
    ).toThrow(/pure JSON/);
  });

  it('rejects an empty installSkill and stores an immutable clone', () => {
    expect(() =>
      registerProviderSetupContract(
        `setup-empty-install-skill-${process.pid}`,
        setupContractWith('installSkill', provided(' ')),
      ),
    ).toThrow(/installSkill\.value must be a non-empty string/);

    const name = `setup-immutable-${process.pid}`;
    const input = setupContractWith('installSkill', waived('none'));
    registerProviderSetupContract(name, input);
    input.installSkill = provided('changed');
    const stored = getProviderSetupContract(name)!;
    expect(stored.installSkill).toEqual(waived('none'));
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored.installSkill)).toBe(true);
  });

  it.each(['installOffer', 'installSkill', 'image', 'auth', 'installVerification', 'failureAssist'])(
    'rejects invalid and missing %s.kind at registration',
    (field) => {
      expect(() =>
        registerProviderSetupContract(
          contractName(field, 'invalid-kind'),
          setupContractWith(`${field}.kind`, 'invalid'),
        ),
      ).toThrow(`.${field}.kind`);
      expect(() =>
        registerProviderSetupContract(contractName(field, 'missing-kind'), setupContractWith(`${field}.kind`, missing)),
      ).toThrow(`.${field}.kind`);
    },
  );

  it.each([
    ['installOffer', 'invalid'],
    ['installSkill', 1],
    ['image', 'invalid'],
    ['auth', 'invalid'],
    ['installVerification', 'invalid'],
    ['failureAssist', 'invalid'],
  ])('rejects an invalid provided value for %s', (field, value) => {
    expect(() =>
      registerProviderSetupContract(
        contractName(field, 'invalid-value'),
        setupContractWith(field, { kind: 'provided', value }),
      ),
    ).toThrow(`.${field}.value`);
  });

  it.each(['installOffer', 'installSkill', 'image', 'auth', 'installVerification', 'failureAssist'])(
    'requires both discriminated-answer branches for %s',
    (field) => {
      expect(() =>
        registerProviderSetupContract(contractName(field, 'provided'), setupContractWith(field, { kind: 'provided' })),
      ).toThrow(/\.value is required/);
      expect(() =>
        registerProviderSetupContract(contractName(field, 'waived'), setupContractWith(field, { kind: 'waived' })),
      ).toThrow(/waiver requires a reason/);
    },
  );
});
