# AGENTS.md

## What this project is

Analyzes all official BetterDiscord addons (plugins + themes from the store) to answer questions like:

- **API usage counts** — how much is each `BdApi` member used, so the impact of changes, deprecations, and removals in BetterDiscord core can be measured before pruning legacy code.
- **Remote URL inventory** — which hosts addons actually reach, to eventually form a tight CSP.
- **Security signals** — `innerHTML`/`outerHTML` assignment, `insertAdjacentHTML`, `eval`, `Function` constructor.

The output is aggregate data for maintainer decision-making, not a linter for addon authors.

## Running

```sh
bun run analyze   # download/refresh addon cache if stale, run all analyses, write results/
bun run clear     # delete .cache (forces re-download of all addons on next run)
bunx tsc --noEmit && bunx eslint src   # the verification pass; keep both green
```

- Addons are cached in `.cache/addons/<author>/<name>.plugin.js|.theme.css` (refreshed weekly from the store API; ~200 plugins, ~150 themes).
- Results land in `results/addons.json` (per addon), `results/authors.json` (per author), `results/summary.json` (global). All are uncommitted snapshots — regenerating them is expected after analysis changes.
- The `imports` analysis makes live network requests (fetches remote CSS `@import`s of every theme), so a full run needs network and takes a couple of minutes.

## Architecture

Two layers:

1. **Pipeline** — `src/index.ts` → `src/cache.ts` (store download) → `src/analyze.ts` (runs every `Analysis` in `src/analyses/` per addon, then aggregates per-addon → per-author → summary). An `Analysis` returns a `Results` value (`Record<string, number>` | `number` | `boolean` | `string[]`); aggregation merges by summing numbers/record values and concatenating arrays (`mergeResults` in `analyze.ts`).
2. **AST engine** — `src/ast/`: meriyah parse → alias collection (`aliases.ts`) → single walk running `Rule`s (`meriyah.ts`, rules in `src/ast/rules/`). Rules produce structured `Finding`s. `src/analyses/ast.ts` bridges the two layers: one memoized `analyzeAddon` call per addon, fanned out into several registry analyses.

To add a check: write a `Rule` in `src/ast/rules/` (register it in `rules/index.ts`), then expose it as an `Analysis` in `src/analyses/ast.ts` (export from `src/analyses/index.ts`). Rules use `match`/`report` (per-node, parent provided), `visitText` (raw source, used for themes), and `finalize` (whole-file). `report` may return one `Finding` or an array.

### Alias tracking

`collectAliases` resolves `const Api = BdApi`, `const W = Api.Webpack`, destructuring (incl. renames and `window.`-rooted chains), and constructor instances — `const bd = new BdApi("Name")` aliases `bd` to `BdApi`, a pattern ~a third of store plugins use — so the bdapi and network-url rules see canonical paths. It is deliberately **scope-blind and conservative**: any name declared twice, reassigned, or shadowed by a function param/catch/class name anywhere in the file is dropped entirely. Minified code mostly loses its aliases — that's intended; undercounting beats miscounting. Don't "fix" this by making it less conservative without real scope tracking (that's the parked evaluator's job, see below).

## Footguns

- **Bun silently deletes statements starting with `declare`.** A call like `declare(x, y);` is stripped by Bun's transpiler as a TS ambient declaration while `tsc` parses it as a call — typecheck stays green, code just doesn't run. Don't name functions/callbacks `declare` (or other TS keywords like `type`/`namespace`) if they'll be called in statement position. This actually happened here; see `register` in `src/ast/aliases.ts`.
- **meriyah types `CallExpression.callee` as `any`.** Always go through `calleeOf()` in `src/ast/helpers.ts`; direct `.callee` access trips the type-aware eslint rules and loses safety.
- **ESTree, not swc/babel shapes.** String literals are `Literal` nodes (there is no `"StringLiteral"` type), identifiers have `.name` (not `.value`). An earlier swc-based generation of this code was removed for exactly this confusion; see git history around commit `288616d` if archaeology is needed.
- **`fs.exists` is a Bun-only extension** rejected by the `fs/promises` typings — use the local `exists()` helper in `src/cache.ts`.
- **`grep` may be aliased to `ugrep` in this shell**, whose BRE alternation (`\|`) behaves differently from GNU grep and can return bogus matches. Prefer `grep -F` for fixed strings, or the dedicated search tools.
- The deprecated-API list in `src/ast/rules/bdapi.ts` is **old-old legacy aliases kept as a sanity check** — the store corpus is expected to report zero of them (`deprecated-apis: {}` in summary.json). Nonzero means either the store regressed or a rule broke.

## Current state / roadmap

- Theme URL extraction lives in the `css-url` `visitText` rule (`src/ast/rules/cssurls.ts`, aggregated as `css-urls` keyed by hostname). It applies to plugins too, catching `url()` refs inside embedded CSS strings that the AST `remote-url` rule can't see. The `imports` analysis stays separate because it resolves transitive remote `@import`s over the network rather than just extracting them.
- `src/evaluator/` is a constant-folding partial evaluator: `core.ts` folds expressions (literals, templates, concat, member access on known objects/arrays, a few pure string methods), `interpret.ts` walks a program in source order with real nested scopes (shadowing and reassignment behave correctly; source order only *approximates* execution order — it is not a real interpreter). Its consumer is the `network-url` rule (`src/ast/rules/networkurls.ts`), which evaluates the URL argument at network sinks (`fetch`, `BdApi.Net.fetch`, `new WebSocket`/`EventSource`, XHR `.open`, `window.open`, `navigator.sendBeacon`); unresolvable segments degrade to `${…}` placeholders as long as the host stays static. Roughly half of corpus `fetch` sites resolve — the rest take runtime values through function params, which is correct conservatism, not a bug to fix.
- `debug/` and `notes/` are scratch/context folders, not part of the build (`tsconfig` only includes `src/`); `debug/obfuscation.ts` still references the deleted swc engine and is kept only as a signal-list reference for a future obfuscation-detection rule.

## Conventions

- Bun + TypeScript, ESM, strict tsconfig with type-aware eslint (`@zerebos/eslint-config`); 4-space indent, double quotes. Run `bunx tsc --noEmit` and `bunx eslint src` before considering work done; an occasional targeted `// eslint-disable-next-line` with judgement is acceptable.
- Verify analysis changes empirically: run rules across `.cache/addons` and sanity-check counts against `grep -F` ground truth on a couple of specific files, plus a synthetic snippet for edge cases (see the expectations encoded above: parse errors should stay 0 across the corpus).
