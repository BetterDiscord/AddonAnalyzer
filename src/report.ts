import fs from "fs/promises";
import path from "path";
import {DYNAMIC_SEGMENT} from "./ast/rules/remoteurls";
import {cacheFolder, resultsFolder} from "./constants";


type ResultValue = Record<string, number> | number | boolean | string[];
type SummaryJson = Record<string, ResultValue>;
type AddonsJson = Record<string, Record<string, Record<string, ResultValue>>>;

interface HostStats {refs: number; addons: Set<string>;}

function escapeHtml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmt(n: number): string {
    return n.toLocaleString("en-US");
}

function asRecord(value: ResultValue | undefined): Record<string, number> {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

// ---- data assembly ---------------------------------------------------------

interface ReportData {
    generated: string;
    dataDate: string;
    authors: number;
    plugins: number;
    themes: number;
    parseErrors: number;
    deprecatedUses: number;
    namespaces: Array<{name: string, calls: number, plugins: number}>;
    apis: Array<{api: string, calls: number, plugins: number}>;
    requires: Array<{module: string, calls: number, plugins: string[]}>;
    hosts: Record<"network-urls" | "css-urls" | "remote-urls", Array<{host: string, refs: number, addons: number}>>;
    sinks: Array<{name: string, count: number, plugins: number}>;
    dynamicCode: Array<{name: string, count: number, plugins: number}>;
    obfuscationSignals: Array<{name: string, plugins: number}>;
    flagged: Array<{name: string, signals: string[]}>;
}

async function assemble(): Promise<ReportData> {
    const summary = JSON.parse(await fs.readFile(path.join(resultsFolder, "summary.json"), "utf8")) as SummaryJson;
    const addons = JSON.parse(await fs.readFile(path.join(resultsFolder, "addons.json"), "utf8")) as AddonsJson;
    const meta = JSON.parse(await fs.readFile(path.join(cacheFolder, "meta.json"), "utf8")) as {lastUpdated: string};

    let plugins = 0;
    let themes = 0;
    const apiPlugins = new Map<string, number>();
    const requirePlugins = new Map<string, string[]>();
    const hostStats: Record<string, Map<string, HostStats>> = {"network-urls": new Map(), "css-urls": new Map(), "remote-urls": new Map()};
    const sinkPlugins = new Map<string, number>();
    const dynamicPlugins = new Map<string, number>();
    const flagged: Array<{name: string, signals: string[]}> = [];

    for (const author of Object.keys(addons)) {
        for (const [file, results] of Object.entries(addons[author])) {
            const name = `${author} / ${file.replace(/\.(plugin\.js|theme\.css)$/, "")}`;
            if (file.endsWith(".plugin.js")) plugins++;
            else themes++;

            for (const api of Object.keys(asRecord(results["bdapi-usage"]))) {
                apiPlugins.set(api, (apiPlugins.get(api) ?? 0) + 1);
            }
            for (const module of Object.keys(asRecord(results.requires))) {
                if (!requirePlugins.has(module)) requirePlugins.set(module, []);
                requirePlugins.get(module)!.push(name);
            }
            for (const key of Object.keys(hostStats)) {
                for (const [host, refs] of Object.entries(asRecord(results[key]))) {
                    const stats = hostStats[key].get(host) ?? {refs: 0, addons: new Set<string>()};
                    stats.refs += refs;
                    stats.addons.add(name);
                    hostStats[key].set(host, stats);
                }
            }
            for (const sink of Object.keys(asRecord(results["html-injection"]))) {
                sinkPlugins.set(sink, (sinkPlugins.get(sink) ?? 0) + 1);
            }
            for (const kind of Object.keys(asRecord(results["dynamic-code"]))) {
                dynamicPlugins.set(kind, (dynamicPlugins.get(kind) ?? 0) + 1);
            }
            if (results["obfuscated-plugins"] === true) {
                flagged.push({name, signals: Object.keys(asRecord(results["obfuscation-signals"]))});
            }
        }
    }

    const apiCalls = asRecord(summary["bdapi-usage"]);
    const namespaceStats = new Map<string, {calls: number, plugins: Set<string>}>();
    for (const [api, calls] of Object.entries(apiCalls)) {
        const segment = api.split(".")[1] ?? "(root)";
        const namespace = segment === "*" ? "(dynamic)" : segment;
        const stats = namespaceStats.get(namespace) ?? {calls: 0, plugins: new Set<string>()};
        stats.calls += calls;
        namespaceStats.set(namespace, stats);
    }
    // plugin counts per namespace need per-addon keys, not the summed summary
    for (const author of Object.keys(addons)) {
        for (const [file, results] of Object.entries(addons[author])) {
            for (const api of Object.keys(asRecord(results["bdapi-usage"]))) {
                const segment = api.split(".")[1] ?? "(root)";
                namespaceStats.get(segment === "*" ? "(dynamic)" : segment)?.plugins.add(`${author}/${file}`);
            }
        }
    }

    const requireCalls = asRecord(summary.requires);
    const hosts = {} as ReportData["hosts"];
    for (const key of ["network-urls", "css-urls", "remote-urls"] as const) {
        hosts[key] = [...hostStats[key].entries()]
            .map(([host, s]) => ({host, refs: s.refs, addons: s.addons.size}))
            .sort((a, b) => b.addons - a.addons || b.refs - a.refs);
    }

    const injection = asRecord(summary["html-injection"]);
    const dynamic = asRecord(summary["dynamic-code"]);
    const signals = asRecord(summary["obfuscation-signals"]);

    return {
        generated: new Date().toISOString().slice(0, 10),
        dataDate: meta.lastUpdated.slice(0, 10),
        authors: Object.keys(addons).length,
        plugins,
        themes,
        parseErrors: typeof summary["parse-errors"] === "number" ? summary["parse-errors"] : 0,
        deprecatedUses: Object.values(asRecord(summary["deprecated-apis"])).reduce((a, b) => a + b, 0),
        namespaces: [...namespaceStats.entries()]
            .map(([name, s]) => ({name, calls: s.calls, plugins: s.plugins.size}))
            .sort((a, b) => b.calls - a.calls),
        apis: Object.entries(apiCalls)
            .map(([api, calls]) => ({api, calls, plugins: apiPlugins.get(api) ?? 0}))
            .sort((a, b) => b.calls - a.calls),
        requires: Object.entries(requireCalls)
            .map(([module, calls]) => ({module, calls, plugins: (requirePlugins.get(module) ?? []).sort()}))
            .sort((a, b) => b.plugins.length - a.plugins.length),
        hosts,
        sinks: Object.entries(injection).map(([name, count]) => ({name, count, plugins: sinkPlugins.get(name) ?? 0})).sort((a, b) => b.count - a.count),
        dynamicCode: Object.entries(dynamic).map(([name, count]) => ({name, count, plugins: dynamicPlugins.get(name) ?? 0})).sort((a, b) => b.count - a.count),
        obfuscationSignals: Object.entries(signals).map(([name, count]) => ({name, plugins: count})).sort((a, b) => b.plugins - a.plugins),
        flagged: flagged.sort((a, b) => b.signals.length - a.signals.length),
    };
}

// ---- rendering -------------------------------------------------------------

function bar(value: number, max: number): string {
    const width = max === 0 ? 0 : Math.max(1.5, (value / max) * 100);
    return `<div class="bar" style="width:${width.toFixed(1)}%"></div>`;
}

function hostTable(rows: Array<{host: string, refs: number, addons: number}>, addonLabel: string, visible = 25): string {
    const max = rows[0]?.addons ?? 0;
    const row = (r: {host: string, refs: number, addons: number}) =>
        `<tr><td>${escapeHtml(r.host)}</td><td class="bar-cell">${bar(r.addons, max)}</td><td class="num">${fmt(r.addons)}</td><td class="num muted">${fmt(r.refs)}</td></tr>`;
    const head = `<table><thead><tr><th>Host</th><th></th><th class="num">${addonLabel}</th><th class="num">Refs</th></tr></thead><tbody>`;
    const shown = rows.slice(0, visible).map(row).join("");
    const rest = rows.slice(visible);
    const tail = rest.length
        ? `</tbody></table><details><summary>Show ${rest.length} more hosts</summary><table><tbody>${rest.map(row).join("")}</tbody></table></details>`
        : "</tbody></table>";
    return head + shown + tail;
}

function render(d: ReportData): string {
    const nsMax = d.namespaces[0]?.calls ?? 0;
    const apiRow = (a: {api: string, calls: number, plugins: number}, max: number) =>
        `<tr><td><code>${escapeHtml(a.api)}</code></td><td class="bar-cell">${bar(a.calls, max)}</td><td class="num">${fmt(a.calls)}</td><td class="num muted">${fmt(a.plugins)}</td></tr>`;
    const apiMax = d.apis[0]?.calls ?? 0;
    const topApis = d.apis.slice(0, 30);
    const restApis = d.apis.slice(30);

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BetterDiscord Addon Analysis — ${d.generated}</title>
<style>
:root {
    color-scheme: light dark;
    --page: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
    --hairline: #e1e0d9; --border: rgba(11,11,11,0.10); --accent: #2a78d6; --good: #006300;
}
@media (prefers-color-scheme: dark) {
    :root {
        --page: #0d0d0d; --surface: #1a1a19; --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
        --hairline: #2c2c2a; --border: rgba(255,255,255,0.10); --accent: #3987e5; --good: #0ca30c;
    }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--ink); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
.wrap { max-width: 1080px; margin: 0 auto; padding: 32px 20px 60px; }
h1 { font-size: 22px; margin: 0 0 4px; }
h2 { font-size: 16px; margin: 0 0 2px; }
.sub { color: var(--ink-2); font-size: 13px; margin: 0 0 24px; }
.note { color: var(--ink-2); font-size: 13px; margin: 2px 0 14px; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 24px; }
.tile { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; }
.tile .label { font-size: 12px; color: var(--ink-2); }
.tile .value { font-size: 26px; font-weight: 600; margin: 2px 0; }
.tile .delta { font-size: 12px; color: var(--ink-2); }
.tile .delta.good { color: var(--good); }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 18px 20px; margin-bottom: 20px; }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
@media (max-width: 800px) { .cols { grid-template-columns: 1fr; } }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th { text-align: left; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); padding: 6px 8px; border-bottom: 1px solid var(--hairline); }
td { padding: 5px 8px; border-bottom: 1px solid var(--hairline); vertical-align: middle; }
tbody tr:hover { background: color-mix(in srgb, var(--accent) 6%, transparent); }
.num { font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
.muted { color: var(--muted); }
th.num { text-align: right; }
.bar-cell { width: 34%; min-width: 90px; }
.bar { height: 12px; background: var(--accent); border-radius: 0 4px 4px 0; }
code { font-family: ui-monospace, "Cascadia Code", Menlo, monospace; font-size: 12px; }
.chip { display: inline-block; font-size: 11px; color: var(--ink-2); border: 1px solid var(--hairline); border-radius: 999px; padding: 1px 8px; margin: 1px 2px 1px 0; }
details { margin-top: 8px; }
summary { cursor: pointer; font-size: 13px; color: var(--ink-2); }
details ul { columns: 2; font-size: 13px; color: var(--ink-2); margin: 8px 0; padding-left: 20px; }
footer { color: var(--muted); font-size: 12px; }
footer ul { padding-left: 18px; }
</style>
</head>
<body>
<div class="wrap">
<h1>BetterDiscord Addon Analysis</h1>
<p class="sub">Official store corpus &middot; report generated ${d.generated} &middot; addon data updated ${d.dataDate}</p>

<div class="kpis">
    <div class="tile"><div class="label">Plugins analyzed</div><div class="value">${fmt(d.plugins)}</div></div>
    <div class="tile"><div class="label">Themes analyzed</div><div class="value">${fmt(d.themes)}</div></div>
    <div class="tile"><div class="label">Authors</div><div class="value">${fmt(d.authors)}</div></div>
    <div class="tile"><div class="label">Parse errors</div><div class="value">${fmt(d.parseErrors)}</div><div class="delta${d.parseErrors === 0 ? " good" : ""}">${d.parseErrors === 0 ? "&#10003; full AST coverage" : "plugins skipped"}</div></div>
    <div class="tile"><div class="label">Legacy API uses</div><div class="value">${fmt(d.deprecatedUses)}</div><div class="delta${d.deprecatedUses === 0 ? " good" : ""}">${d.deprecatedUses === 0 ? "&#10003; old-old APIs are gone" : "see bdapi table"}</div></div>
    <div class="tile"><div class="label">Using require()</div><div class="value">${fmt(new Set(d.requires.flatMap(r => r.plugins)).size)}</div><div class="delta">plugins on the polyfill</div></div>
    <div class="tile"><div class="label">Flagged for review</div><div class="value">${fmt(d.flagged.length)}</div><div class="delta">bundled / packed code</div></div>
</div>

<div class="card">
    <h2>require() usage — polyfill retirement list</h2>
    <p class="note">BetterDiscord has no real <code>require</code>; these modules are served by the polyfill. Each list names the plugins to migrate before it can be removed.</p>
    <table><thead><tr><th>Module</th><th></th><th class="num">Plugins</th><th class="num">Calls</th></tr></thead><tbody>
    ${d.requires.map(r => `<tr><td><code>${escapeHtml(r.module)}</code></td><td class="bar-cell">${bar(r.plugins.length, d.requires[0]?.plugins.length ?? 0)}</td><td class="num">${fmt(r.plugins.length)}</td><td class="num muted">${fmt(r.calls)}</td></tr>
    <tr><td colspan="4" style="border-bottom:1px solid var(--hairline)"><details><summary>Plugins requiring <code>${escapeHtml(r.module)}</code></summary><ul>${r.plugins.map(p => `<li>${escapeHtml(p)}</li>`).join("")}</ul></details></td></tr>`).join("")}
    </tbody></table>
</div>

<div class="card">
    <h2>BdApi usage by namespace</h2>
    <p class="note">Calls resolved through aliases, destructuring, and <code>new BdApi()</code> instances. Use this to weigh the impact of API changes.</p>
    <table><thead><tr><th>Namespace</th><th></th><th class="num">Calls</th><th class="num">Plugins</th></tr></thead><tbody>
    ${d.namespaces.map(n => `<tr><td><code>BdApi.${escapeHtml(n.name)}</code></td><td class="bar-cell">${bar(n.calls, nsMax)}</td><td class="num">${fmt(n.calls)}</td><td class="num muted">${fmt(n.plugins)}</td></tr>`).join("")}
    </tbody></table>
    <details><summary>Top individual APIs (${fmt(d.apis.length)} distinct)</summary>
    <table><thead><tr><th>API</th><th></th><th class="num">Calls</th><th class="num">Plugins</th></tr></thead><tbody>
    ${topApis.map(a => apiRow(a, apiMax)).join("")}
    </tbody></table>
    ${restApis.length ? `<details><summary>Show all ${fmt(restApis.length)} remaining APIs</summary><table><tbody>${restApis.map(a => apiRow(a, apiMax)).join("")}</tbody></table></details>` : ""}
    </details>
</div>

<div class="card">
    <h2>Network hosts — CSP planning</h2>
    <p class="note">Sorted by how many addons reference each host. "Runtime calls" are URLs statically resolved into network sinks (<code>connect-src</code> candidates); CSS references cover <code>@import</code> and <code>url()</code> (<code>style/img/font-src</code>).</p>
    <div class="cols">
        <div><h2>Runtime network calls</h2>${hostTable(d.hosts["network-urls"], "Plugins")}</div>
        <div><h2>CSS references</h2>${hostTable(d.hosts["css-urls"], "Addons")}</div>
    </div>
    <details><summary>All string-literal URLs in plugin code (context — includes changelogs, docs links, embedded data)</summary>
    ${hostTable(d.hosts["remote-urls"], "Plugins")}
    </details>
</div>

<div class="card">
    <h2>Security signals</h2>
    <div class="cols">
        <div>
            <h2>HTML injection sinks</h2>
            <table><thead><tr><th>Sink</th><th class="num">Uses</th><th class="num">Plugins</th></tr></thead><tbody>
            ${d.sinks.map(s => `<tr><td><code>${escapeHtml(s.name)}</code></td><td class="num">${fmt(s.count)}</td><td class="num muted">${fmt(s.plugins)}</td></tr>`).join("") || `<tr><td colspan="3" class="muted">none found</td></tr>`}
            </tbody></table>
            <h2 style="margin-top:16px">Dynamic code execution</h2>
            <table><thead><tr><th>Kind</th><th class="num">Uses</th><th class="num">Plugins</th></tr></thead><tbody>
            ${d.dynamicCode.map(s => `<tr><td><code>${escapeHtml(s.name)}</code></td><td class="num">${fmt(s.count)}</td><td class="num muted">${fmt(s.plugins)}</td></tr>`).join("") || `<tr><td colspan="3" class="muted">none found</td></tr>`}
            </tbody></table>
        </div>
        <div>
            <h2>Obfuscation signals</h2>
            <table><thead><tr><th>Signal</th><th></th><th class="num">Plugins</th></tr></thead><tbody>
            ${d.obfuscationSignals.map(s => `<tr><td>${escapeHtml(s.name)}</td><td class="bar-cell">${bar(s.plugins, d.obfuscationSignals[0]?.plugins ?? 0)}</td><td class="num">${fmt(s.plugins)}</td></tr>`).join("")}
            </tbody></table>
        </div>
    </div>
    <h2 style="margin-top:16px">Flagged for manual review (${d.flagged.length})</h2>
    <p class="note">Heuristic score &ge; 0.4 — indicates bundled, minified, or packed code worth a manual look, <em>not</em> malice.</p>
    <table><thead><tr><th>Plugin</th><th>Signals</th></tr></thead><tbody>
    ${d.flagged.map(f => `<tr><td>${escapeHtml(f.name)}</td><td>${f.signals.map(s => `<span class="chip">${escapeHtml(s)}</span>`).join("")}</td></tr>`).join("")}
    </tbody></table>
</div>

<footer>
    <ul>
        <li>Static analysis over the official store corpus (meriyah AST + constant-folding evaluator). Runtime-computed values that cannot be resolved statically are excluded or shown as <code>${DYNAMIC_SEGMENT}</code> / (dynamic).</li>
        <li>"Legacy API uses" checks the old-old top-level aliases (getData, findModuleByProps, monkeyPatch, &hellip;) as a sanity baseline.</li>
        <li>Host counts prefer distinct addons over raw reference counts; one addon embedding a large URL dataset cannot skew the ranking.</li>
        <li>Generated by AddonAnalyzer &middot; <code>bun run report</code></li>
    </ul>
</footer>
</div>
</body>
</html>`;
}

export async function generateReport() {
    const data = await assemble();
    await fs.writeFile(path.join(resultsFolder, "report.html"), render(data));
    console.log("Report written to results/report.html");
}

if (import.meta.main) await generateReport();
