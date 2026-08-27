import { describe, expect, it } from 'vitest';

import '../providers/index.js';
import './index.js';
import {
  assertProviderHostConformance,
  getProviderHostContract,
  provided,
  registerProviderHostContract,
} from './registry.js';

describe('installed host provider contracts', () => {
  it('match their compatibility adapters', () => {
    expect(() => assertProviderHostConformance()).not.toThrow();
  });

  it('rejects a declared provider whose required host adapter is missing', () => {
    const contract = structuredClone(getProviderHostContract('claude')!);
    if (contract.files[0]?.reconcile.kind === 'provided') {
      contract.files[0].reconcile.value.transformerProvider = 'claude';
    }
    contract.legacyHostAdapter = provided('required');
    registerProviderHostContract('missing-startup-adapter', contract);

    expect(() => assertProviderHostConformance()).toThrow(
      "Provider 'missing-startup-adapter' host contract requires a legacy host adapter",
    );
  });
});
