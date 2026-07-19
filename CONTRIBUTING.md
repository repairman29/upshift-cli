# Contributing to Upshift

Thanks for your interest in contributing to Upshift! This document provides guidelines for contributing.

## Getting Started

1. Fork the repository
2. Clone your fork:
   ```bash
   git clone https://github.com/YOUR_USERNAME/upshift-cli.git
   cd upshift-cli
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Build:
   ```bash
   npm run build
   ```
5. Run locally:
   ```bash
   node dist/cli.js --help
   ```

## Project structure

```
src/
├── cli.ts           # Main CLI entry point
├── commands/        # CLI command definitions
└── lib/             # Core logic (scan, explain, upgrade, fix, migrate, ecosystem, etc.)
migrations/          # Framework migration templates (JSON)
```

## Running Tests

```bash
npm run test:unit    # Unit tests (Vitest)
```

- **Unit tests:** Pure helpers live next to the code as `src/**/*.test.ts`.
- **Corpus smoke (optional):** `npm run test:corpus` builds the CLI, shallow-clones the pinned public repos in `tests/corpus/repos.json`, and runs read-only `scan`. Requires network + git.

## Linting & formatting

```bash
npm run lint         # ESLint over src/
npm run format:check # Prettier check
npm run format       # Prettier write
```

## Pull Request Guidelines

1. **Create a branch** for your feature or fix
2. **Write clear commit messages**
3. **Update documentation** if needed
4. **Test your changes** locally (`npm run test:unit`)
5. **Submit a PR** with a clear description

### Pricing and public copy

Prices, credit counts, and tier names are defined in the canonical **[pricing.json](pricing.json)**. If you change any of them, update `pricing.json` first, then the CLI strings in `src/lib/credits.ts`.

## Areas We'd Love Help With

- **Package manager support**: Improving yarn and pnpm compatibility
- **Migration templates**: Curated rules for major framework upgrades (see below)
- **GitHub Action**: Improvements to CI/CD integration
- **Documentation**: Tutorials, examples, translations

### Migration templates

We ship migration templates (e.g. React 18→19) in `migrations/`. To contribute one:

1. Add a JSON file: `migrations/<ecosystem>-<from>-<to>.json` (e.g. `next-13-14.json`, `vue-2-3.json`).
2. Follow the schema in [migrations/README.md](migrations/README.md): `name`, `description`, `from`/`to`, `package`, `steps` (find/replace or package/version), `links` to official upgrade guides.
3. Open a PR with a short description and link to the official migration guide.

## Code Style

- Use TypeScript
- Follow existing patterns in the codebase
- Keep functions small and focused
- Add JSDoc comments for public APIs

## Questions?

Open an issue or reach out to [@repairman29](https://github.com/repairman29).

## License

By contributing, you agree that your contributions will be licensed under the Apache License 2.0.
