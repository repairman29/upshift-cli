# Migration templates

Templates for major framework/library upgrades. Used by `upshift upgrade` and `upshift fix` to suggest or apply codemods.

**Hero path:** We prioritize **React** and **Next.js** templates first; other entries below are valuable but may lag behind Node/React in real-world testing.

## Included

- **react-18-19** — React 18 → 19 (createRoot, hydrateRoot, react-dom) — **primary hero template**
- **next-13-14** — Next.js 13 → 14 (metadata, next + react-dom versions) — **primary hero template**
- **vue-2-3** — Vue 2 → 3 (createApp, vue-router 4)
- **angular-16-17** — Angular 16 → 17 (@angular/core, @angular/cli; run `ng update` for control flow / standalone)
- **typescript-4-5** — TypeScript 4 → 5 (typescript, tslib package bumps)
- **jest-28-29** — Jest 28 → 29 (jest, jest-environment-jsdom; see upgrade guide for snapshot/API changes)
- **vite-4-5** — Vite 4 → 5 (vite, @vitejs/plugin-react; Node 18+, ESM config; see official migration guide)

## Contributing a template

1. Add a JSON file: `migrations/<ecosystem>-<from>-<to>.json` (e.g. `next-13-14.json`).
2. Schema:
   - `name`: short id
   - `description`: human-readable
   - `from` / `to`: version range (e.g. `"18.x"`, `"19.x"`)
   - `package`: main package name
   - `steps`: array of `{ id, description, find?, replace?, package?, version?, note? }`
   - `links`: URLs to official upgrade guides
3. Open a PR; see [CONTRIBUTING.md](../CONTRIBUTING.md#migration-templates).

## Usage

- **List templates:** `upshift migrate <package> --list` (e.g. `upshift migrate react --list`, `upshift migrate @angular/core --list`, `upshift migrate typescript --list`)
- **Apply template:** `upshift migrate react` or `upshift migrate next --template next-13-14` or `upshift migrate @angular/core --template angular-16-17`
- **Custom template:** `upshift migrate <package> --template-file path/to/my-migration.json` — load a JSON file with the same schema (package, steps, from, to, description, links). Path is relative to `--cwd` or absolute.
- **Dry run:** `upshift migrate react --dry-run` to see what would be changed without modifying files
- `upshift explain <pkg> --ai` is **most capable on Node**; Python/Ruby/Go may have scan-oriented or lighter explain paths (1 credit when AI runs). Templates align with **Node** packages unless noted.
