import { CODEX_PROJECT_DOC_EXTRA_SECTIONS, CODEX_PROJECT_DOC_MAX_BYTES } from '../providers/codex-agents-md.js';

import { provided, registerProviderHostContract, waived } from './registry.js';

registerProviderHostContract('codex', {
  projectDocument: provided({
    fileName: 'AGENTS.md',
    baseDocumentFile: 'AGENTS.md',
    extraSections: CODEX_PROJECT_DOC_EXTRA_SECTIONS,
    maxBytes: CODEX_PROJECT_DOC_MAX_BYTES,
    containerPath: '/workspace/agent/AGENTS.md',
    mountClass: 'allowlisted-extra',
    sourceProtection: waived('the current install-surface driver does not protect provider-installed AGENTS.md'),
  }),
  stateVolumes: [
    {
      id: 'codex-home',
      directory: '.codex-shared',
      containerPath: '/home/node/.codex',
      scope: 'group',
      mode: 'rw',
      mountClass: 'allowlisted-extra',
    },
  ],
  skillBackings: [
    {
      id: 'codex-skills',
      location: { kind: 'group-directory', directory: '.agents', subdirectory: '' },
      skillsSubdirectory: 'skills',
      ...{ conflictDiagnostics: provided('silent') },
      sharedLinks: provided({ prune: 'symlinks-only' }),
      templateCopies: provided('copy'),
    },
  ],
  skillViews: [
    {
      backingId: 'codex-skills',
      containerPath: '/workspace/agent/.agents',
      mode: 'ro',
      mountClass: 'allowlisted-extra',
      mount: 'bind',
    },
    {
      backingId: 'codex-skills',
      containerPath: '/home/node/.agents',
      mode: 'ro',
      mountClass: 'allowlisted-extra',
      mount: 'bind',
    },
  ],
  groupInitOperations: [],
  spawnOperations: [
    { kind: 'state-volume', id: 'codex-home' },
    { kind: 'prepared-file', id: 'codex-auth-stub' },
    { kind: 'project-document' },
    { kind: 'skill-backing', id: 'codex-skills', action: 'sync' },
    { kind: 'legacy-overlay' },
  ],
  files: [
    {
      id: 'codex-auth-stub',
      volumeId: 'codex-home',
      relativePath: 'auth.json',
      prepare: { operation: 'append-open-close', when: 'every-spawn', mode: 'process-default' },
      contentOwner: 'gateway',
      reconcile: waived('the gateway owns auth.json and the host only ensures the mountpoint exists'),
    },
  ],
  environment: provided('none'),
  legacyHostAdapter: provided('required'),
  commands: { nativeAdmin: [], nativeFiltered: [] },
});
