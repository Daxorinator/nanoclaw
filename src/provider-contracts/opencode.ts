import { CLAUDE_COMPATIBLE_HOST_SURFACES } from './claude.js';
import {
  provided,
  registerProviderHostContract,
  waived,
} from './registry.js';

const inherited = structuredClone(CLAUDE_COMPATIBLE_HOST_SURFACES);
const projectDocument =
  inherited.projectDocument.kind === 'provided'
    ? provided({
        ...inherited.projectDocument.value,
        sourceProtection: waived('OpenCode inherits the current Claude document plane without adding protection'),
      })
    : inherited.projectDocument;

registerProviderHostContract('opencode', {
  ...inherited,
  projectDocument,
  stateVolumes: [
    ...inherited.stateVolumes,
    {
      id: 'opencode-data',
      directory: 'opencode-xdg',
      containerPath: '/opencode-xdg',
      scope: 'session',
      mode: 'rw',
      mountClass: 'allowlisted-extra',
    },
  ],
  files: inherited.files.map((file) => ({
    ...file,
    reconcile:
      file.reconcile.kind === 'provided'
        ? provided({ ...file.reconcile.value, transformerProvider: 'claude' })
        : file.reconcile,
  })),
  spawnOperations: [
    { kind: 'state-volume', id: 'opencode-data' },
    { kind: 'legacy-overlay' },
    { kind: 'skill-backing', id: 'claude-skills', action: 'sync' },
    { kind: 'project-document' },
  ],
  environment: provided('legacy-overlay'),
  legacyHostAdapter: provided('required'),
  commands: { nativeAdmin: [], nativeFiltered: [] },
});
