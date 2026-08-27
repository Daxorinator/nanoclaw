import { provided, registerProviderSetupContract, waived } from './registry.js';

registerProviderSetupContract('opencode', {
  installOffer: waived('OpenCode remains skill-only and is not offered by interactive setup'),
  installSkill: provided('add-opencode'),
  image: provided('local-required'),
  auth: waived('OpenCode credentials are configured through OneCLI and provider environment settings'),
  installVerification: waived('the shared provider conformance suite is the install gate'),
  failureAssist: waived('OpenCode does not provide a host-side setup assistant'),
});
