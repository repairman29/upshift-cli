# Upshift

[![npm version](https://img.shields.io/npm/v/upshift-cli.svg)](https://www.npmjs.com/package/upshift-cli)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

**AI-powered dependency upgrades.** Stop reading changelogs. Let AI fix what breaks.

Version-bump PRs (from Dependabot, Renovate, or manual bumps) leave the hard work on you: breaking changes, failed tests, and risky rollbacks. Upshift is the **after-the-bump layer**: it **explains** what changed, **suggests code fixes**, runs **your tests**, and **rolls back** automatically when a test fails (rollback needs a test script; if you don't have one, the CLI tells you and skips the gate).

> **Dependabot hands you the chore list. Upshift helps you actually finish it.**

Built by one person (hi, I'm [Jeff](https://github.com/repairman29)). If something's wrong, [open an issue](https://github.com/repairman29/upshift-cli/issues) and I'll see it.

## Guardrails first (not another autonomous coding agent)

Upshift is built for **review and safety**: run your existing test command, restore `package.json` + lockfile on failure, use `upshift fix --dry-run` before applying AI edits, and configure **human-in-the-loop** (prompts, or webhook approval) via `.upshiftrc.json`. Optional **confidence** hints and **opt-in** local outcome logging help you learn what breaks over time.

## Hero stack (where we go deepest)

- **Best-in-class path:** **npm, yarn, pnpm** on **Node**, especially **React / Next.js** upgrades, `explain`, `fix`, and [migration templates](migrations/README.md).
- **Scan breadth:** **Python** (pip/poetry), **Ruby** (bundler), **Go** (modules) for `upshift scan`, reports, and Radar. Treat **AI fix / migrate** as **Node-first** unless noted otherwise.

## Dependabot / Renovate and Upshift

| They do | Upshift adds |
|--------|----------------|
| Open PRs with version bumps | **Plain-English** breaking-change analysis + optional **AI** deep dive |
| You read changelogs | **`explain`** + **`fix`** suggest concrete code changes |
| You handle test failures | **`upgrade`** runs **your** tests and **auto-rollback** |

Upshift **complements** bots you already use; it does not replace org-wide PR automation.

## Install

```bash
npm install -g upshift-cli
```

Then run:
```bash
upshift --help
```

### From source (dev)

```bash
git clone https://github.com/repairman29/upshift-cli.git
cd upshift-cli
npm install
npm run build
node dist/cli.js --help
```

## Usage

### Scan & Explain
```bash
upshift scan                          # See all outdated packages
upshift scan --json                   # Machine-readable output
upshift scan --licenses               # Include license per direct dep (npm)
upshift scan --report report.json     # Write JSON for Radar (central dashboard)
upshift radar                         # Open Radar in browser

upshift explain react --ai            # AI explains breaking changes
upshift explain react --from 18 --to 19
upshift explain react --risk          # low/medium/high risk score
upshift explain react --changelog     # Fetch changelog from GitHub
```

### Upgrade & Fix
```bash
upshift upgrade react                 # Upgrade with tests + auto-rollback
upshift upgrade react --to 19.0.0
upshift upgrade react -y              # Skip approval prompt (e.g. CI)
upshift upgrade --all                 # Batch upgrade all packages
upshift upgrade --all-minor           # Only minor/patch updates

upshift fix react                     # AI generates code fixes
upshift fix react --dry-run           # Preview changes without applying

upshift rollback                      # Restore previous state
upshift rollback --list               # See available backups
```

### Suggest & Plan
```bash
upshift suggest                      # Recommended upgrades (low risk, high value)
upshift suggest --limit 10           # Top 10 suggestions
upshift plan                         # Multi-step upgrade order (dependency + risk)
upshift plan --mode minor            # Only minor/patch upgrades
upshift migrate react --list         # List migration templates for react
upshift migrate react --dry-run      # Preview template application
upshift migrate next                 # Apply Next.js 13→14 template
upshift migrate vue --list           # List Vue templates
```

### Interactive & Monorepo
```bash
upshift interactive                   # TUI for selecting packages
upshift workspaces                    # Scan monorepo workspaces
```

### Notifications
```bash
upshift notify --slack https://...    # Send report to Slack
upshift notify --discord https://...  # Send report to Discord
```

## Human-in-the-loop (oversight)

Self-healing via **LLM-generated code fixes** should be reviewed, not applied blindly. Use `upshift fix --dry-run` to preview changes, then review before applying. For automated pipelines, use approval gates:

- **Single upgrade:** By default, major version upgrades prompt `Upgrade X from A to B (major)? [y/N]` when run interactively. Use `-y` to skip (e.g. CI).
- **Config:** Create `.upshiftrc.json` with `upshift init`. Set `approval.mode` to `"prompt"` (default), `"none"`, or `"webhook"` (POST proposed upgrade to `approval.webhookUrl`; 200 = approve). Set `approval.requireFor` to `["major"]` (default) or `["all"]`. Set `upgradePolicy: { blockRisk: ["high"] }` to block high-risk upgrades (use `-y` to override). Set `autoConfirm: true` to skip all prompts.
- **Batch:** `upshift upgrade --all` (or `--all-minor`) already asks for confirmation before applying; use `-y` to skip.

## What it does today

- **Upgrade** a dependency and **run tests**; **roll back** on failure (package.json + lockfile)
- **Explain** breaking changes (`explain`, optional `--ai`); **risk** scores and changelogs
- **Fix** with AI-suggested code changes (`fix`, `--dry-run` supported)
- **Scan** outdated / vulnerable packages (npm, yarn, pnpm; plus Python, Ruby, Go for scan)
- **Suggest** / **plan** ordered upgrades; **migration templates** (React, Next, Vue, …)
- **Radar** reports for a **central dependency health** view

## AI configuration

`upshift explain --ai`, `upshift fix`, and `upshift audit --ai` call an OpenAI-compatible API.

- Set `OPENAI_API_KEY` to use the hosted OpenAI API.
- **Local model:** point `OPENAI_BASE_URL` at any OpenAI-compatible server (LM Studio, Ollama, etc.), e.g. `OPENAI_BASE_URL=http://127.0.0.1:1234/v1` and `OPENAI_MODEL=qwen/qwen3-14b`.

AI features use a local **credit** bank (10 free credits by default), stored in `~/.upshift/credits.json`. When credits run out, the CLI exits with code 2. To skip credit checks entirely for a local LLM, set `UPSHIFT_SKIP_CREDITS_FOR_LOCAL_LLM=1`. Credit packs and subscription tiers are listed in **[pricing.json](pricing.json)**.

## GitHub Action

Add to your repo for automated scanning on PRs. The action installs the published `upshift-cli` and runs `upshift scan`:

```yaml
# .github/workflows/upshift.yml
name: Upshift Scan
on: [pull_request]
jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: repairman29/upshift-cli@main
        with:
          comment-on-pr: "true"
          fail-on: "critical"
```

See [action.yml](action.yml) for all inputs and outputs.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Migration templates are especially welcome — the schema is in [migrations/README.md](migrations/README.md).

## License

[Apache-2.0](LICENSE) © Jeff Adkins
