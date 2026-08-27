import { provided, registerProviderRuntimeContract, waived } from './registry.js';

registerProviderRuntimeContract('opencode', {
  managedFiles: waived('OpenCode receives its generated config in process environment'),
  archives: waived('OpenCode persists and compacts its own session history'),
  continuationRotation: waived('OpenCode manages its continuation storage under XDG_DATA_HOME'),
  traceReaders: waived('OpenCode has no local trace reader'),
  attachments: provided({ initial: 'text-only', followUp: 'text-only' }),
  events: ['init', 'activity', 'result'],
  textDelivery: 'result',
  lifecycle: {
    memory: provided('native-session-hook'),
    compaction: provided('provider-native'),
    continuation: provided('opaque-token'),
    exchangeCompletion: waived('OpenCode retains its own session history'),
  },
  commands: { formatting: 'xml', nativeAdmin: [], nativeFiltered: [] },
});
