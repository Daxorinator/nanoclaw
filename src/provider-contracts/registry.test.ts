import { describe, expect, it } from 'vitest';

import './index.js';
import {
  getProviderHostContract,
  hasDeclaredProviderContract,
  listProviderHostContractNames,
  provided,
  registerProviderHostContract,
  type ProviderHostContract,
  waived,
} from './registry.js';

function emptyContract(): ProviderHostContract {
  return {
    projectDocument: waived('none'),
    stateVolumes: [],
    skillBackings: [],
    skillViews: [],
    files: [],
    groupInitOperations: [],
    spawnOperations: [{ kind: 'legacy-overlay' }],
    environment: provided('none'),
    legacyHostAdapter: waived('none'),
    commands: { nativeAdmin: [], nativeFiltered: [] },
  };
}

const missing = Symbol('missing');

function claudeContractWith(path: string, value: unknown | typeof missing): ProviderHostContract {
  const contract = structuredClone(getProviderHostContract('claude')!);
  const reconcile = contract.files[0]?.reconcile;
  if (reconcile?.kind === 'provided') reconcile.value.transformerProvider = 'claude';
  const parts = path.split('.');
  let target = contract as unknown as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) target = target[part] as Record<string, unknown>;
  const field = parts.at(-1)!;
  if (value === missing) delete target[field];
  else target[field] = value;
  return contract;
}

function contractName(field: string, suffix: string): string {
  return `invalid-${field}-${suffix}-${process.pid}`.replaceAll(/[^a-z0-9-]/g, '-');
}

describe('provider host contracts', () => {
  it('loads the complete Claude base declaration from the separate contract barrel', () => {
    const contract = getProviderHostContract('claude');

    expect(contract).toBeDefined();
    expect(contract?.projectDocument).toMatchObject({
      kind: 'provided',
      value: {
        fileName: 'CLAUDE.md',
        containerPath: '/workspace/agent/CLAUDE.md',
        sourceProtection: { kind: 'provided', value: 'install-surface' },
      },
    });
    expect(contract?.stateVolumes).toEqual([
      expect.objectContaining({ id: 'claude-home', directory: '.claude-shared', scope: 'group' }),
    ]);
    expect(contract?.skillBackings).toEqual([
      expect.objectContaining({ id: 'claude-skills', templateCopies: provided('in-place') }),
    ]);
    expect(contract?.files).toEqual([
      expect.objectContaining({
        id: 'claude-settings',
        contentOwner: 'provider',
        reconcile: provided({ transformer: 'claude-memory-settings', when: 'group-init', write: 'atomic-replace' }),
      }),
    ]);
    expect(contract?.environment).toEqual(expect.objectContaining({ kind: 'waived' }));
    expect(contract?.legacyHostAdapter).toEqual(expect.objectContaining({ kind: 'waived' }));
    expect(contract?.commands.nativeFiltered).toContain('/remote-control');
    expect(JSON.parse(JSON.stringify(contract))).toEqual(contract);
  });

  it('keeps provider lookup case-insensitive and unknown providers undeclared', () => {
    expect(hasDeclaredProviderContract('CLAUDE')).toBe(true);
    expect(hasDeclaredProviderContract('not-installed')).toBe(false);
    expect(listProviderHostContractNames()).toContain('claude');
  });

  it('rejects duplicate declarations at registration', () => {
    const name = `duplicate-contract-${process.pid}`;
    const empty = emptyContract();
    registerProviderHostContract(name, empty);
    expect(() => registerProviderHostContract(name, empty)).toThrow(/already registered/);
  });

  it('stores an immutable clone so callers cannot bypass validation after registration', () => {
    const name = `immutable-contract-${process.pid}`;
    const input = emptyContract();
    registerProviderHostContract(name, input);
    (input.commands as unknown as { nativeAdmin: string[] }).nativeAdmin = ['/later'];

    const stored = getProviderHostContract(name)!;
    expect(stored.commands.nativeAdmin).toEqual([]);
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored.commands.nativeAdmin)).toBe(true);
    expect(() => (stored.commands.nativeAdmin as string[]).push('/later')).toThrow();
  });

  it.each([
    ['empty waiver', () => ({ ...emptyContract(), projectDocument: waived('') }), /waiver requires a reason/],
    [
      'host path',
      () => ({
        ...emptyContract(),
        projectDocument: provided({
          fileName: 'AGENTS.md',
          baseDocumentFile: '/tmp/AGENTS.md',
          containerPath: '/workspace/agent/AGENTS.md',
          mountClass: 'group-state' as const,
          sourceProtection: waived('not protected today'),
        }),
      }),
      /one file or directory name/,
    ],
    [
      'duplicate volume identity',
      () => ({
        ...emptyContract(),
        stateVolumes: [
          {
            id: 'state',
            directory: '.one',
            containerPath: '/one',
            scope: 'group' as const,
            mode: 'rw' as const,
            mountClass: 'group-state' as const,
          },
          {
            id: 'state',
            directory: '.two',
            containerPath: '/two',
            scope: 'session' as const,
            mode: 'rw' as const,
            mountClass: 'allowlisted-extra' as const,
          },
        ],
      }),
      /must be unique/,
    ],
    [
      'missing backing volume',
      () => ({
        ...emptyContract(),
        skillBackings: [
          {
            id: 'skills',
            location: { kind: 'state-volume' as const, volumeId: 'missing', subdirectory: 'skills' },
            skillsSubdirectory: 'skills',
            sharedLinks: waived('none'),
            conflictDiagnostics: waived('none'),
            templateCopies: waived('none'),
          },
        ],
      }),
      /references unknown/,
    ],
    [
      'non-JSON value',
      () => ({ ...emptyContract(), extra: () => undefined }) as unknown as ProviderHostContract,
      /pure JSON/,
    ],
  ])('rejects %s at registration', (_label, makeContract, expected) => {
    const name = `invalid-${_label.toLowerCase().replaceAll(' ', '-')}-${process.pid}`;
    expect(() => registerProviderHostContract(name, makeContract())).toThrow(expected);
  });

  it.each([
    ['not an array', {}, /projectDocument\.extraSections must be an array/],
    ['missing name', [{ body: 'body' }], /extraSections\[0\]\.name must be a non-empty string/],
    ['missing body', [{ name: 'name' }], /extraSections\[0\]\.body must be a non-empty string/],
    ['blank name', [{ name: ' ', body: 'body' }], /extraSections\[0\]\.name must be a non-empty string/],
    ['blank body', [{ name: 'name', body: ' ' }], /extraSections\[0\]\.body must be a non-empty string/],
  ])('rejects malformed project-document extra sections: %s', (_label, value, expected) => {
    expect(() =>
      registerProviderHostContract(
        contractName(`extra-sections-${_label}`, 'invalid'),
        claudeContractWith('projectDocument.value.extraSections', value),
      ),
    ).toThrow(expected);
  });

  it.each(['stateVolumes', 'skillBackings', 'skillViews', 'files', 'groupInitOperations', 'spawnOperations'])(
    'requires top-level host array %s',
    (field) => {
      expect(() =>
        registerProviderHostContract(contractName(`array-${field}`, 'wrong'), claudeContractWith(field, {})),
      ).toThrow(`.${field} must be an array`);
      expect(() =>
        registerProviderHostContract(contractName(`array-${field}`, 'missing'), claudeContractWith(field, missing)),
      ).toThrow(`.${field} must be an array`);
    },
  );

  it.each([
    ['projectDocument.kind', 'claude.projectDocument.kind'],
    ['projectDocument.value.mountClass', 'claude.projectDocument.mountClass'],
    ['projectDocument.value.sourceProtection.kind', 'claude.projectDocument.sourceProtection.kind'],
    ['projectDocument.value.sourceProtection.value', 'claude.projectDocument.sourceProtection.value'],
    ['stateVolumes.0.scope', 'claude.stateVolumes.claude-home.scope'],
    ['stateVolumes.0.mode', 'claude.stateVolumes.claude-home.mode'],
    ['stateVolumes.0.mountClass', 'claude.stateVolumes.claude-home.mountClass'],
    ['skillBackings.0.location.kind', 'claude.skillBackings.claude-skills.location.kind'],
    ['skillBackings.0.sharedLinks.kind', 'claude.skillBackings.claude-skills.sharedLinks.kind'],
    ['skillBackings.0.sharedLinks.value.prune', 'claude.skillBackings.claude-skills.sharedLinks.value.prune'],
    ['skillBackings.0.conflictDiagnostics.kind', 'claude.skillBackings.claude-skills.conflictDiagnostics.kind'],
    ['skillBackings.0.conflictDiagnostics.value', 'claude.skillBackings.claude-skills.conflictDiagnostics.value'],
    ['skillBackings.0.templateCopies.kind', 'claude.skillBackings.claude-skills.templateCopies.kind'],
    ['skillBackings.0.templateCopies.value', 'claude.skillBackings.claude-skills.templateCopies.value'],
    ['skillViews.0.mode', 'claude.skillViews.claude-skills.mode'],
    ['skillViews.0.mountClass', 'claude.skillViews.claude-skills.mountClass'],
    ['skillViews.0.mount', 'claude.skillViews.claude-skills.mount'],
    ['files.0.prepare.operation', 'claude.files.claude-settings.prepare.operation'],
    ['files.0.prepare.when', 'claude.files.claude-settings.prepare.when'],
    ['files.0.prepare.mode', 'claude.files.claude-settings.prepare.mode'],
    ['files.0.contentOwner', 'claude.files.claude-settings.contentOwner'],
    ['files.0.reconcile.kind', 'claude.files.claude-settings.reconcile.kind'],
    ['files.0.reconcile.value.when', 'claude.files.claude-settings.reconcile.value.when'],
    ['files.0.reconcile.value.write', 'claude.files.claude-settings.reconcile.value.write'],
    ['groupInitOperations.0.kind', 'claude.group-initOperations[].kind'],
    ['groupInitOperations.2.action', 'claude.group-initOperations.skill-backing.action'],
    ['environment.kind', 'claude.environment.kind'],
    ['legacyHostAdapter.kind', 'claude.legacyHostAdapter.kind'],
    ['commands.nativeAdmin', 'claude.commands.nativeAdmin'],
    ['commands.nativeFiltered', 'claude.commands.nativeFiltered'],
  ])('rejects invalid and missing %s at registration', (path, field) => {
    expect(() =>
      registerProviderHostContract(contractName(path, 'invalid'), claudeContractWith(path, 'invalid')),
    ).toThrow(field.slice('claude'.length));
    expect(() =>
      registerProviderHostContract(contractName(path, 'missing'), claudeContractWith(path, missing)),
    ).toThrow(field.slice('claude'.length));
  });

  it.each([
    'projectDocument',
    'projectDocument.value.sourceProtection',
    'skillBackings.0.sharedLinks',
    'skillBackings.0.conflictDiagnostics',
    'skillBackings.0.templateCopies',
    'files.0.reconcile',
    'environment',
    'legacyHostAdapter',
  ])('requires both discriminated-answer branches for %s', (path) => {
    expect(() =>
      registerProviderHostContract(contractName(path, 'provided'), claudeContractWith(path, { kind: 'provided' })),
    ).toThrow(/\.value is required/);
    expect(() =>
      registerProviderHostContract(contractName(path, 'waived'), claudeContractWith(path, { kind: 'waived' })),
    ).toThrow(/waiver requires a reason/);
  });

  it.each([
    ['environment', 'claude.environment.value'],
    ['legacyHostAdapter', 'claude.legacyHostAdapter.value'],
  ])('rejects an invalid provided value for %s', (path, field) => {
    expect(() =>
      registerProviderHostContract(
        contractName(path, 'value'),
        claudeContractWith(path, { kind: 'provided', value: 'invalid' }),
      ),
    ).toThrow(field.slice('claude'.length));
  });

  it("requires the legacy host adapter when environment uses 'legacy-overlay'", () => {
    expect(() =>
      registerProviderHostContract(contractName('legacy-overlay-adapter', 'waived'), {
        ...emptyContract(),
        environment: provided('legacy-overlay'),
      }),
    ).toThrow(/environment 'legacy-overlay' requires legacyHostAdapter 'required'/);
  });

  it('rejects invalid prepared-file ownership, content, reconciliation, and transformers', () => {
    expect(() =>
      registerProviderHostContract(
        contractName('prepare-content', 'missing'),
        claudeContractWith('files.0.prepare.content', missing),
      ),
    ).toThrow(/files\.claude-settings\.prepare\.content/);
    expect(() =>
      registerProviderHostContract(
        contractName('create-owner', 'gateway'),
        claudeContractWith('files.0.contentOwner', 'gateway'),
      ),
    ).toThrow(/contentOwner must be 'provider' for create-if-missing/);

    const appendProvider = claudeContractWith('files.0.prepare', {
      operation: 'append-open-close',
      when: 'every-spawn',
      mode: 'process-default',
    });
    appendProvider.files[0].contentOwner = 'provider';
    appendProvider.files[0].reconcile = waived('gateway-owned');
    expect(() => registerProviderHostContract(contractName('append-owner', 'provider'), appendProvider)).toThrow(
      /contentOwner must be 'gateway' for append-open-close/,
    );

    const appendReconcile = claudeContractWith('files.0.prepare', {
      operation: 'append-open-close',
      when: 'every-spawn',
      mode: 'process-default',
    });
    appendReconcile.files[0].contentOwner = 'gateway';
    expect(() => registerProviderHostContract(contractName('append-reconcile', 'provided'), appendReconcile)).toThrow(
      /reconcile must be waived for append-open-close/,
    );

    expect(() =>
      registerProviderHostContract(
        contractName('reconcile-when', 'mismatch'),
        claudeContractWith('files.0.reconcile.value.when', 'every-spawn'),
      ),
    ).toThrow(/reconcile\.value\.when must match prepare\.when/);
    expect(() =>
      registerProviderHostContract(
        contractName('reconcile-transformer', 'missing'),
        claudeContractWith('files.0.reconcile.value.transformer', 'missing'),
      ),
    ).toThrow(/reconcile\.value\.transformer references missing transformer 'claude:missing'/);
  });

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['too-large', 0o10000],
  ])('rejects invalid numeric prepared-file mode %s', (label, mode) => {
    expect(() =>
      registerProviderHostContract(
        contractName('prepare-mode', label),
        claudeContractWith('files.0.prepare.mode', mode),
      ),
    ).toThrow(/prepare\.mode must be 'process-default' or an integer from 0 to 0o7777/);
  });

  it.each([
    [
      'prepared file',
      [
        { kind: 'prepared-file', id: 'claude-settings' },
        { kind: 'state-volume', id: 'claude-home' },
        { kind: 'skill-backing', id: 'claude-skills', action: 'initialize' },
      ],
      /prepared-file 'claude-settings' must follow state-volume 'claude-home'/,
    ],
    [
      'skill backing',
      [
        { kind: 'skill-backing', id: 'claude-skills', action: 'initialize' },
        { kind: 'state-volume', id: 'claude-home' },
        { kind: 'prepared-file', id: 'claude-settings' },
      ],
      /skill-backing 'claude-skills' must follow state-volume 'claude-home'/,
    ],
  ])('rejects %s before its lifecycle volume', (_label, operations, expected) => {
    expect(() =>
      registerProviderHostContract(
        contractName(`operation-order-${_label}`, 'invalid'),
        claudeContractWith('groupInitOperations', operations),
      ),
    ).toThrow(expected);
  });

  it.each([
    ['prepared-file', { kind: 'prepared-file', id: 'claude-settings' }, /prepared-file 'claude-settings'/],
    [
      'skill-backing',
      { kind: 'skill-backing', id: 'claude-skills', action: 'initialize' },
      /skill-backing 'claude-skills'/,
    ],
  ])('does not let group-init %s rely on a volume moved to spawn', (_label, dependent, expected) => {
    const contract = claudeContractWith('groupInitOperations', [
      dependent,
      ...(dependent.kind === 'prepared-file'
        ? [{ kind: 'skill-backing', id: 'claude-skills', action: 'initialize' }]
        : [{ kind: 'prepared-file', id: 'claude-settings' }]),
    ]);
    contract.spawnOperations = [{ kind: 'state-volume', id: 'claude-home' }, ...contract.spawnOperations];
    expect(() => registerProviderHostContract(contractName(`cross-phase-${_label}`, 'invalid'), contract)).toThrow(
      expected,
    );
  });

  it('requires a session-volume dependent to follow its spawn volume', () => {
    const contract = claudeContractWith('stateVolumes', [
      ...getProviderHostContract('claude')!.stateVolumes,
      {
        id: 'session-state',
        directory: 'session-state',
        containerPath: '/session-state',
        scope: 'session',
        mode: 'rw',
        mountClass: 'allowlisted-extra',
      },
    ]);
    contract.files = [
      ...contract.files,
      {
        id: 'session-file',
        volumeId: 'session-state',
        relativePath: 'state.json',
        prepare: { operation: 'append-open-close', when: 'every-spawn', mode: 0o600 },
        contentOwner: 'gateway',
        reconcile: waived('gateway-owned'),
      },
    ];
    contract.spawnOperations = [
      { kind: 'prepared-file', id: 'session-file' },
      { kind: 'state-volume', id: 'session-state' },
      ...contract.spawnOperations,
    ];
    expect(() => registerProviderHostContract(contractName('session-volume-order', 'invalid'), contract)).toThrow(
      /prepared-file 'session-file' must follow state-volume 'session-state'/,
    );
  });

  it('requires an allowlisted mount to have an explicit spawn position', () => {
    const contract = claudeContractWith('stateVolumes', [
      ...getProviderHostContract('claude')!.stateVolumes,
      {
        id: 'late-only',
        directory: 'late-only',
        containerPath: '/late-only',
        scope: 'group',
        mode: 'rw',
        mountClass: 'allowlisted-extra',
      },
    ]);
    contract.groupInitOperations = [{ kind: 'state-volume', id: 'late-only' }, ...contract.groupInitOperations];

    expect(() => registerProviderHostContract(contractName('allowlisted-spawn-order', 'invalid'), contract)).toThrow(
      /allowlisted-extra mount 'state-volume:late-only' must appear in spawnOperations/,
    );
  });

  it.each([
    [
      'non-state backing',
      'skillBackings.0.location',
      { kind: 'group-directory', directory: '.agents', subdirectory: '' },
      /requires a state-volume backing/,
    ],
    [
      'wrong destination',
      'skillViews.0.containerPath',
      '/home/node/.claude/other',
      /containerPath must be .* for parent-volume/,
    ],
    ['wrong mode', 'skillViews.0.mode', 'ro', /mode must match parent volume/],
    ['wrong mount class', 'skillViews.0.mountClass', 'allowlisted-extra', /mountClass must match parent volume/],
  ])('rejects unrealizable parent-volume view: %s', (_label, field, value, expected) => {
    expect(() =>
      registerProviderHostContract(
        contractName(`parent-volume-${_label}`, 'invalid'),
        claudeContractWith(field, value),
      ),
    ).toThrow(expected);
  });

  it.each([
    [
      'container path alias',
      'stateVolumes.0.containerPath',
      '/home/node//.claude',
      /canonical absolute container path/,
    ],
    ['relative dot alias', 'files.0.relativePath', './settings.json', /canonical relative path/],
    ['relative parent alias', 'files.0.relativePath', 'config/../settings.json', /canonical relative path/],
    ['leading relative parent', 'files.0.relativePath', '../settings.json', /canonical relative path/],
    ['backing relative parent', 'skillBackings.0.location.subdirectory', '../skills', /canonical relative path/],
    ['skills relative parent', 'skillBackings.0.skillsSubdirectory', '../skills', /canonical relative path/],
    ['relative slash alias', 'files.0.relativePath', 'config//settings.json', /canonical relative path/],
  ])('rejects noncanonical %s', (_label, field, value, expected) => {
    expect(() =>
      registerProviderHostContract(contractName(`path-${_label}`, 'invalid'), claudeContractWith(field, value)),
    ).toThrow(expected);
  });
});
