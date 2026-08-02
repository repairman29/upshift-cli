# Test depth ledger

A passing suite proves exactly what it asserts and nothing more. This ledger
names, for every suite, its depth tier AND its known gaps — so "tests pass"
never silently overstates what was verified. It updates in the same commit as
the suites it describes.

Tiers: **D1** smoke (it runs / sane shape) · **D2** happy path (real flow,
state asserted) · **D3** edges (failure modes, boundaries, idempotence) ·
**D4** adversarial (concurrency, malformed/abusive input).

## Where tests run

CI (added 2026-08-02, this repo previously had **no workflows**): lint + unit
tests + build + `--version` smoke on every push/PR. The corpus sweep
(`npm run test:corpus`) is manual. The full end-to-end harness (CLI commands
against fixtures, browser tests for the website) runs in the upstream
development repository before releases are published here — a green checkout
of THIS repo has been unit-tested and smoke-built, not e2e'd.

## Suites

| Suite | Depth | What it actually proves | Gaps |
|---|---|---|---|
| `src/lib/validate.test.ts` (16) | D3–D4-lite | input schemas reject empties, oversize names, shell metacharacters, null-byte paths, non-UUID org ids; `validateOrExit` exits 1 on failure | rejection lists are enumerated, not fuzzed; no unicode-normalization cases; schemas tested in isolation, not at the CLI boundary |
| `src/lib/config.test.ts` (16) | D2–D3 | testCommand string/array forms run, package-manager fallback selected, failures propagate | config file parsing/merge precedence untested; malformed config behavior unknown |
| `src/lib/credits.test.ts` (9) | D2–D3 | balance init/add/reset/consume; insufficient balance exits 2; org-remote consume path + per-user fallback (fetch mocked) | **fixed 2026-08-02: the suite previously deleted the REAL `~/.upshift/credits.json` of whoever ran `npm test`** — now redirected to a temp HOME; concurrent consumes (file race) untested; remote path is mock-only |
| `src/lib/package-manager.test.ts` (5) | D2 | package-manager detection basics | lockfile-conflict and workspace-monorepo detection untested |
| `src/lib/version-bump-kind.test.ts` (4) | D2 | semver bump classification | pre-release/build-metadata edge tags untested |
| `src/lib/audit-log.test.ts` (5) | D2 | audit entries written/read | log rotation/corruption recovery untested |
| `tests/corpus` + `scripts/corpus-smoke.mjs` | scenario, manual | scan behavior across a corpus of real-world repos | no schedule — runs only when someone remembers; no committed pass/fail ledger |

## Honest state

Unit coverage of validation and credit logic is genuinely D2–D3. What this
repo cannot see: `upshift upgrade`'s mutating behavior (no e2e fixture here),
multi-language scan paths, and anything requiring the platform API (remote
credits are tested against mocks only). Treat local green as "the logic
units hold", not "the CLI is release-verified" — release verification happens
upstream before publish.
