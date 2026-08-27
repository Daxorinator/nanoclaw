import { provided, registerProviderSetupContract } from './registry.js';

registerProviderSetupContract('codex', {
  installOffer: provided('skill-descriptor'),
  installSkill: provided('add-codex'),
  image: provided('local-required'),
  auth: provided('provider'),
  installVerification: provided('provider'),
  failureAssist: provided('provider'),
});
