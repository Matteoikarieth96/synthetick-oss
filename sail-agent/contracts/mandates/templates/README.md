# Sail permission templates (not included)

The live agent uses two of Sail's permission templates, `SwapPermissionNoOracle` and its base `ConfigurablePermission`.
They are published by Sail under GPL-2.0-or-later, so this MIT repository does not redistribute their source.

- To use them, point at the shared singleton Sail already deployed (see `../../../docs/HOW-IT-WORKS.md`), or
- fetch the source from https://github.com/sail-money/protocol (`contracts/templates/`), put it here, change its `../interfaces/` imports to `@sail/interfaces/`, install OpenZeppelin v5.1.0, then run `forge build`.
  If you deploy your own instance, the GPL applies to that combined work.

Nothing else in `sail-agent/` imports these files.
