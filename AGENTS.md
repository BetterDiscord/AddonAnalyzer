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

`collectScopeInfo` resolves `const Api = BdApi`, `const W = Api.Webpack`, destructuring (incl. renames and `window.`-rooted chains), and constructor instances — `const bd = new BdApi("Name")` aliases `bd` to `BdApi`, a pattern ~a third of store plugins use — so the bdapi and network-url rules see canonical paths. It is deliberately **scope-blind and conservative**: any name declared twice, reassigned, or shadowed by a function param/catch/class name anywhere in the file is dropped entirely. Minified code mostly loses its aliases — that's intended; undercounting beats miscounting. Don't "fix" this by making it less conservative without real scope tracking (that's the parked evaluator's job, see below). `collectAliases` remains as a thin wrapper returning just the map.

It also exposes the two raw binding sets it computes, on `RuleContext` as `declared` (bound by any declarator/assignment) and `shadowed` (bound by a function param, catch clause, or function/class name). Rules keyed on names that can plausibly be local — unlike `BdApi`, which never is — need them, and the right set differs per rule:

- `globals` skips a root that is **declared or shadowed**: a file with `const global = {}` or `function f(process)` anywhere makes every mention of that root untrustworthy, so the whole file's hits for it are dropped.
- `react-hazards` skips only **shadowed** roots. A local *declaration* is exactly how a real ReactDOM arrives (`const ReactDOM = BdApi.Webpack.getModule(…)`), so treating declarations as disqualifying there would drop the main case the rule exists for.

## Footguns

- **Bun silently deletes statements starting with `declare`.** A call like `declare(x, y);` is stripped by Bun's transpiler as a TS ambient declaration while `tsc` parses it as a call — typecheck stays green, code just doesn't run. Don't name functions/callbacks `declare` (or other TS keywords like `type`/`namespace`) if they'll be called in statement position. This actually happened here; see `register` in `src/ast/aliases.ts`.
- **meriyah types `CallExpression.callee` as `any`.** Always go through `calleeOf()` in `src/ast/helpers.ts`; direct `.callee` access trips the type-aware eslint rules and loses safety.
- **ESTree, not swc/babel shapes.** String literals are `Literal` nodes (there is no `"StringLiteral"` type), identifiers have `.name` (not `.value`). An earlier swc-based generation of this code was removed for exactly this confusion; see git history around commit `288616d` if archaeology is needed.
- **`fs.exists` is a Bun-only extension** rejected by the `fs/promises` typings — use the local `exists()` helper in `src/cache.ts`.
- **`grep` may be aliased to `ugrep` in this shell**, whose BRE alternation (`\|`) behaves differently from GNU grep and can return bogus matches. Prefer `grep -F` for fixed strings, or the dedicated search tools.
- The deprecated-API list in `src/ast/rules/bdapi.ts` is **old-old legacy aliases kept as a sanity check** — the store corpus is expected to report zero of them (`deprecated-apis: {}` in summary.json). Nonzero means either the store regressed or a rule broke.

## Current state / roadmap

- Theme URL extraction lives in the `css-url` `visitText` rule (`src/ast/rules/cssurls.ts`, aggregated as `css-urls` keyed by hostname). It applies to plugins too, catching `url()` refs inside embedded CSS strings that the AST `remote-url` rule can't see. The `imports` analysis stays separate because it resolves transitive remote `@import`s over the network rather than just extracting them.
- `src/evaluator/` is a constant-folding partial evaluator: `core.ts` folds expressions (literals, templates, concat, member access on known objects/arrays, a few pure string methods), `interpret.ts` walks a program in source order with real nested scopes (shadowing and reassignment behave correctly; source order only *approximates* execution order — it is not a real interpreter). Its consumers are the `network-url` rule (`src/ast/rules/networkurls.ts`), which evaluates the URL argument at network sinks (`fetch`, `BdApi.Net.fetch`, `new WebSocket`/`EventSource`, XHR `.open`, `window.open`, `navigator.sendBeacon`) with unresolvable segments degrading to `${…}` placeholders as long as the host stays static, and the `webpack-targets`/`patcher-targets` rules (`src/ast/rules/webpacktargets.ts`). Roughly half of corpus `fetch` sites resolve — the rest take runtime values through function params, which is correct conservatism, not a bug to fix.
- `webpack-targets` + `patcher-targets` (`src/ast/rules/webpacktargets.ts`, "Discord internals reliance" report card) inventory what the ecosystem pulls out of Discord: webpack lookup arguments (`getByKeys`/`getStore`/`Filters.by*` etc., keyed `${kind}:${value}` so keys/strings/protoKeys/stores/displayNames share one record) and `BdApi.Patcher.before|instead|after` targets (keyed by method name, patch type in details). Both use `interpretProgram` so const arrays and aliases resolve; `getModule`/`getMangled`/`getWithKey` are deliberately *not* parsed — their nested `Filters.*` calls are separate CallExpressions counted on their own. Unresolvable args collapse to `(dynamic)`. The Patcher method is read as `arguments[length - 2]` (the arg before the trailing callback), *not* a fixed index: the static `BdApi.Patcher.after(caller, module, method, cb)` puts it at index 2, but a `new BdApi(name)` instance bakes the caller in, giving `(module, method, cb)` with method at index 1 — the alias tracker collapses both to `BdApi.Patcher`, so position-relative-to-callback is the only signature-agnostic locator. Undercounts BDFDB/ZLibrary plugins (they route lookups through the library, see handoff-00 known limitations). Sanity magnitudes on the 2026-07 corpus: `getModule` 234 call sites across 137 plugins using `BdApi.Webpack`; 230 patcher calls, ~55 `(dynamic)` (genuinely runtime — mangled `getMangled` keys), the rest real methods led by `render`/`type`.
- **Environment & fragility** (handoff-02, "Environment coupling" + "Hardcoded Discord class names" cards):
  - `globals` (`src/ast/rules/globals.ts`) inventories direct reach into the bridged environment — roots `process`, `Buffer`, `__dirname`, `__filename`, `global`, `DiscordNative` — keyed as root plus one segment (`process.env`); deeper is noise. Companion to `requires` for the polyfill-retirement story, hence the shared report card. Sanity magnitudes on the 2026-07 corpus: `DiscordNative.clipboard` in 15 plugins, everything else in ≤4.
  - `react-hazards` (`src/ast/rules/reacthazards.ts`) counts React-upgrade breakage risk. It matches on the **owner segment** (`resolved[len-2] === "ReactDOM"`), not a fixed chain, so bare `ReactDOM.render`, `BdApi.ReactDOM.render`, and library-held `Internal.LibraryModules.ReactDOM.render` (BDFDB) all count — they are all the real ReactDOM. Bare identifiers count **only at call sites**, which picks up `const {createRoot} = ReactDOM; createRoot(el)` (4 of 12 corpus `createRoot` files) without double-counting the binding site. `createRoot` is tracked as the *healthy* signal (`ADOPTION`), so `isHazardMethod()` is what splits the report table. 2026-07: 10 createRoot, 9 getInternalInstance, and render/findDOMNode/unmountComponentAtNode only inside 0BDFDB.
  - `class-literals` (`src/ast/rules/classliterals.ts`) counts hardcoded hashed Discord classes per addon (a `number`, not a record). Plugins go through the AST branch (string literals + template quasis only); themes go through `visitText` on raw CSS. **Never scan plugin source as text** — bundler identifiers like `__nested_webpack_require_1306889__` match otherwise.
- **The hashed-class regex is tuned on evidence; re-verify before touching it.** Discord ships two styles and one element carries both (`class="name__2ea32 overflow_b0dfc2"`): `wrapper_a1b2c3` (single `_`, 6 hex) and `name__2ea32` (double `_`, 5-6 hex). On the 2026-07 corpus the double-underscore style is **over half** of all 2,139 tokens, so a single-underscore-only pattern misses most of the signal. Each constraint earns its place: lowercase-first drops URL paths (`/wiki/HD_175167`); hex-only suffix avoids ~400 snake_case false positives (`utm_source`, `node_modules`); 7-hex matches nothing and single-`_`+5-hex never occurs; boundary guards stop matches inside longer identifiers. All-letter hashes (`_eaaeee`, `_fedacc`) are real classes, so there is deliberately **no** "must contain a digit" rule. A third form exists — `f4758a8d6346d18b-nonVisualMediaItemContainer` (16-hex prefix + dash) — but lives in exactly 1 addon (10 occurrences) and is intentionally unmatched; revisit if it spreads.
- Fragility is concentrated, and the ranking is by *occurrences*: 16 addons hardcode classes at all, led by 7 ShadowDevilsAvenged themes (~1,700-1,900 each) and `KingGamingYT/ActivityFeed` (628), which vendors Discord's whole class-name map (`"newspaperIcon": "newspaperIcon__97b5e"`) into its source. Most plugins do the right thing — only 5 hardcode a single-underscore class at all.
- `debug/` and `notes/` are scratch/context folders, not part of the build (`tsconfig` only includes `src/`) and are gitignored. `notes/handoff-*.md` contains the planned-analysis backlog: `handoff-00-orientation.md` is the shared how-to-work-here guide; 01 (Discord internals coupling), 02 (environment/fragility signals), and 03 (meta validation + trend history) are independent, session-sized batches.
- Obfuscation detection (`src/ast/rules/obfuscation.ts`) is a heuristic scorer: per-signal presence flags aggregate as `obfuscation-signals`, and `obfuscated-plugins` counts those scoring >= 0.4. Entropy thresholds were tuned on the 2026-07 corpus (see the comment in the rule) — a "flagged" plugin means bundled/packed/worth-eyeballing, not malicious. The `require` analysis (`requires` key) exists to drive the require-polyfill removal: it counts which modules plugins request via the polyfilled `require()`.

## Conventions

- Bun + TypeScript, ESM, strict tsconfig with type-aware eslint (`@zerebos/eslint-config`); 4-space indent, double quotes. Run `bunx tsc --noEmit` and `bunx eslint src` before considering work done; an occasional targeted `// eslint-disable-next-line` with judgement is acceptable.
- Verify analysis changes empirically: run rules across `.cache/addons` and sanity-check counts against `grep -F` ground truth on a couple of specific files, plus a synthetic snippet for edge cases (see the expectations encoded above: parse errors should stay 0 across the corpus).
