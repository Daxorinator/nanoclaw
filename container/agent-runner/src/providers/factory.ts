import type { AgentProvider, ProviderOptions } from './types.js';
import { getProviderFactory } from './provider-registry.js';
import '../provider-contracts/index.js';
import { getProviderRuntimeContract, validateProviderRuntimeInstance } from '../provider-contracts/registry.js';
import {
  archiveProviderExchangeFromContract,
  maybeRotateProviderContinuation,
  realizeProviderManagedFiles,
} from '../provider-contracts/realize.js';

/**
 * Any registered provider name. Kept as a named alias for readability; the
 * set of valid names is open and determined at runtime by whichever provider
 * modules the `providers/index.ts` barrel imports.
 */
export type ProviderName = string;

export function createProvider(name: ProviderName, options: ProviderOptions = {}): AgentProvider {
  const contract = getProviderRuntimeContract(name);
  const provider = getProviderFactory(name)(
    contract
      ? {
          ...options,
          coreIo: {
            realizeManagedFiles: (when, context) => realizeProviderManagedFiles(name, when, context),
          },
        }
      : options,
  );
  if (contract) {
    validateProviderRuntimeInstance(name, contract, provider);

    const archive = contract.archives.kind === 'provided' ? contract.archives.value : undefined;
    if (archive?.owner === 'core' && archive.trigger === 'exchange-complete') {
      provider.onExchangeComplete = (exchange) => {
        archiveProviderExchangeFromContract(name, exchange);
      };
    }

    const rotation =
      contract.continuationRotation.kind === 'provided' ? contract.continuationRotation.value : undefined;
    if (rotation?.owner === 'core') {
      provider.maybeRotateContinuation = (continuation) =>
        maybeRotateProviderContinuation(name, continuation, options.assistantName, (message) =>
          console.error(`[${name}-provider] ${message}`),
        );
    }
  }
  return provider;
}
