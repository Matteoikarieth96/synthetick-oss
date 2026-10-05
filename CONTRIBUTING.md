# Contributing to SyntheTick

Thanks for helping. This file is the short path from "I want to change something" to a merged pull request.

## Ground rules

1. **The spec is the source of truth.** [signal-desk-v4-spec.md](signal-desk-v4-spec.md) describes intended behaviour. When code and spec disagree, the spec wins. If your change alters a decision, update the spec in the same pull request, first.
2. **The honesty contract is not negotiable.** Requirements are enforced three times, empty results are honest, missing data is a dash. A change that weakens any of those will not be merged. Tests for them live in `runtime/test-regression.ts`.
3. **No secrets, no vendor data.** Never commit `.env`, keys, wallet files or payloads from a paid data vendor. A secret scan runs on every push.
4. **Data sources need a terms check.** A new vendor adapter must say, in the pull request, what its terms allow and confirm that the repository does not redistribute its data.

## Set up

Follow [docs/QUICKSTART.md](docs/QUICKSTART.md). You can work on much of the code with no keys at all:

```bash
npm install
npm run typecheck
npm run test:offline      # regression, requirements, security, parsing: no keys, no database, no .env
```

## Branches and pull requests

- Fork, then branch off **`staging`**: `git checkout -b feat/short-name origin/staging`.
- Open the pull request against **`staging`**. `main` only changes when maintainers promote `staging`.
- Keep a pull request to one change. Small is fast to review.
- Fill in the template. Say how you tested it and add a screenshot for any UI change.
- CI runs typecheck and `npm run test:offline`. Both must pass.
- Commit messages: a short imperative summary, then a paragraph on why if it is not obvious.
- By contributing you agree your work is licensed under the MIT License of this repository.
- Only contribute code, text, images or data that you wrote or that is under an MIT-compatible license (MIT, BSD, ISC, Apache-2.0, CC0), and keep its copyright notice. Do not add GPL, AGPL or "non-commercial" material, data from a paid vendor, or third-party logos.

## Where to start

Issues labelled `good first issue` are sized for a first contribution. Good areas:

- **Data sources:** a vendor-neutral adapter interface (the equities code is written against one vendor today), keyless sources, more exchanges and countries.
- **Asset classes:** commodities, REITs, individual bonds.
- **Tests:** offline tests for dedup, caps, regions, FX, the CSV parser, the sail-agent decision code.
- **Docs and translations**, **API clients** (Python, TypeScript), **new MCP tools**, **accessibility**.

Not sure it fits? Open an issue and ask before you write a lot of code.

## Style

- TypeScript, strict mode, ES modules, Node 22. `npm run typecheck` must be clean.
- Match the surrounding code: comment density, naming, idiom.
- UI copy: plain words, no em or en dashes.
- Prompts are plain strings in `runtime/`. If you change one, include before and after output in the pull request.

## Working with AI assistants

Fine, and the repository has a `CLAUDE.md` for that. You are still responsible for the change: read it, run it, and do not paste generated text you have not checked. Never let an assistant touch real keys or `.env`.

## Reporting problems

Bugs and ideas: open an issue. Security problems: use the private report on the Security tab ([SECURITY.md](SECURITY.md)), never a public issue.
