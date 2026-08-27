import { provided, registerProviderSetupContract, waived } from './registry.js';

registerProviderSetupContract('claude', {
  installOffer: provided('built-in'),
  installSkill: waived('Claude is built into the checkout'),
  image: provided('hardened-compatible'),
  auth: provided('standard'),
  installVerification: waived('Claude is built into the checkout'),
  failureAssist: provided('claude-fallback'),
});
