# Remove the OpenCode agent provider

Switch every OpenCode group back to Claude before removing the payload:

```bash
ncl groups list
ncl groups config update --id <group-id> --provider claude
ncl groups restart --id <group-id>
```

Delete `import './opencode.js';` from these barrels:

- `src/providers/index.ts`
- `src/provider-contracts/index.ts`
- `container/agent-runner/src/providers/index.ts`
- `container/agent-runner/src/provider-contracts/index.ts`
- `setup/provider-contracts/index.ts`

Delete every file listed by the `nc:copy` directive in `SKILL.md`, remove `@opencode-ai/sdk` from `container/agent-runner/package.json`, its lockfile entry, and the `opencode-ai` entry from `container/cli-tools.json`.

Then rebuild and verify:

```bash
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
./container/build.sh
pnpm exec tsx scripts/provider-contract-verifier.ts
```
