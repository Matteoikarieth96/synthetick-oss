# Notice

SyntheTick is licensed under the MIT License (see `LICENSE`), Copyright (c) 2026 SyntheTick contributors, except the brand assets in `brand/`.
Files that carry an `SPDX-License-Identifier` header are under that license; the header is authoritative.

## Third-party files in this repository

| Files | License | Origin |
|---|---|---|
| `sail-agent/.agents/**`, `sail-agent/.cursor/rules`, `sail-agent/AGENTS.md`, `sail-agent/CLAUDE.md`, `sail-agent/soul.md`, `sail-agent/.sail/README.md`, `sail-agent/ui/README.md`, `sail-agent/docs/PERMISSION_MODEL.md`, `sail-agent/src/config.ts`, `sail-agent/src/mandate.ts`, `sail-agent/scripts/{probe-mandate,quote-swap,resolve-token,shared-template-addr}.mjs`, `sail-agent/contracts/mandates/{BoundedCallPermission,SailCalldata}.sol`, `sail-agent/contracts/mandates/README.md`, `sail-agent/contracts/test/BoundedCallPermission.t.sol`, `sail-agent/contracts/.sail/contracts/interfaces/{IPermission,IBatchPermission}.sol`. Modified by SyntheTick contributors: `sail-agent/.agents/skills/sailor-automation/{SKILL.md,references/github-actions.md}` (keystore advice), `sail-agent/{README.md,Dockerfile,.dockerignore,.gitignore,.env.example,package.json,tsconfig.json}`, `sail-agent/.sail/config.json`, `sail-agent/src/agent.ts`, `sail-agent/contracts/{README.md,foundry.toml}` | MIT, Copyright (c) 2026 Agentic Finance Inc. | Sailor harness scaffold 2.1.3 (github.com/sail-money/Sailor). License text: `sail-agent/LICENSE-SAILOR-MIT.txt` |
| `sail-agent/contracts/.sail/contracts/interfaces/{IAgentIdentityResolver,IConfigurablePermission,IOracle,IPermissionIntrospection,SailCapabilities}.sol` | MIT (SPDX header) | Sail Protocol interface files (github.com/sail-money/Protocol) |
| `brand/` | Not covered by the MIT License | SyntheTick logo and mascot, see `TRADEMARKS.md` |

## Not included on purpose

Sail's permission templates `ConfigurablePermission.sol` and `SwapPermissionNoOracle.sol`, and the Sailor scaffold's `sailor-templates/oracles/` folder (a TWAP oracle with Uniswap v3 math helpers), are GPL-2.0-or-later and are not shipped here, so this repository stays MIT. Nothing here needs them to build, test or run. To deploy your own sell-side swap permission, fetch the template from github.com/sail-money/Protocol (`contracts/templates/`) under its own license; see `sail-agent/README.md`. The oracle folder ships inside the `@sail.money/sailor` npm package (`node_modules/@sail.money/sailor/scaffold/.agents/skills/sailor-templates/oracles/`).

See `THIRD_PARTY.md` for dependencies, services loaded at runtime and data-source terms.
