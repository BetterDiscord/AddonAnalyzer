import fs from "fs/promises";
import path from "path";
import {isKnownField, isRequiredField} from "./ast/rules/meta";
import {isHazardMethod} from "./ast/rules/reacthazards";
import {cacheFolder, resultsFolder} from "./constants";
import {DYNAMIC_SEGMENT} from "./evaluator/strings";
import {deriveKpis, readHistory, type AddonsJson, type Kpis, type Snapshot, type SummaryJson} from "./history";


type ResultValue = Record<string, number> | number | boolean | string[];

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
    kpis: Kpis;

    // Second-newest distinct dataDate, or null on a first run / fresh checkout. Everything
    // delta-shaped must tolerate null: history is a bonus, never a precondition for rendering.
    previous: Snapshot | null;

    // Oldest-first KPI series for tile sparklines; null until >= 3 snapshots exist
    kpiSeries: Record<keyof Kpis, number[]> | null;
    corpus: number;
    metaFields: Array<{field: string, addons: number, known: boolean, required: boolean}>;
    metaProblems: Array<{problem: string, field: string, addons: string[]}>;
    selfUpdaters: string[];
    namespaces: Array<{name: string, calls: number, plugins: number}>;
    apis: Array<{api: string, calls: number, plugins: number}>;
    requires: Array<{module: string, calls: number, plugins: string[]}>;
    globals: Array<{name: string, calls: number, plugins: number}>;
    reactHazards: Array<{method: string, calls: number, plugins: number, hazard: boolean}>;
    fragile: Array<{name: string, tokens: number, type: "plugin" | "theme"}>;
    fragileAddons: number;
    webpackTargets: Array<{kind: string, value: string, calls: number, plugins: number}>;
    patcherTargets: Array<{method: string, calls: number, plugins: number}>;
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
    const webpackPlugins = new Map<string, number>();
    const patcherPlugins = new Map<string, number>();
    const globalPlugins = new Map<string, number>();
    const reactPlugins = new Map<string, number>();
    const metaFieldAddons = new Map<string, number>();
    const metaProblemAddons = new Map<string, string[]>();
    const selfUpdaters: string[] = [];
    const fragile: ReportData["fragile"] = [];
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
            for (const key of Object.keys(asRecord(results["webpack-targets"]))) {
                webpackPlugins.set(key, (webpackPlugins.get(key) ?? 0) + 1);
            }
            for (const method of Object.keys(asRecord(results["patcher-targets"]))) {
                patcherPlugins.set(method, (patcherPlugins.get(method) ?? 0) + 1);
            }
            for (const global of Object.keys(asRecord(results.globals))) {
                globalPlugins.set(global, (globalPlugins.get(global) ?? 0) + 1);
            }
            for (const method of Object.keys(asRecord(results["react-hazards"]))) {
                reactPlugins.set(method, (reactPlugins.get(method) ?? 0) + 1);
            }
            for (const field of Object.keys(asRecord(results["meta-fields"]))) {
                metaFieldAddons.set(field, (metaFieldAddons.get(field) ?? 0) + 1);
            }
            for (const problem of Object.keys(asRecord(results["meta-problems"]))) {
                if (!metaProblemAddons.has(problem)) metaProblemAddons.set(problem, []);
                metaProblemAddons.get(problem)!.push(name);
            }
            if (results["self-updating"] === true) selfUpdaters.push(name);

            const tokens = results["class-literals"];
            if (typeof tokens === "number" && tokens > 0) {
                fragile.push({name, tokens, type: file.endsWith(".plugin.js") ? "plugin" : "theme"});
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

    const globalCalls = asRecord(summary.globals);
    const reactCalls = asRecord(summary["react-hazards"]);
    const injection = asRecord(summary["html-injection"]);
    const dynamic = asRecord(summary["dynamic-code"]);
    const signals = asRecord(summary["obfuscation-signals"]);
    const webpackCalls = asRecord(summary["webpack-targets"]);
    const patcherCalls = asRecord(summary["patcher-targets"]);

    const dataDate = meta.lastUpdated.slice(0, 10);

    // The newest snapshot is this run's own data; "previous" is the newest older dataDate.
    // Comparing against a snapshot with the same dataDate would always show a delta of zero.
    const history = await readHistory();
    const previous = history.filter(s => s.dataDate < dataDate).pop() ?? null;

    const kpis = deriveKpis(addons, summary);

    // Last 12 snapshots, with the current data as the final point (replacing this
    // dataDate's own snapshot if one was written, so a stale file cannot disagree)
    let kpiSeries: ReportData["kpiSeries"] = null;
    const trail = history.filter(s => s.dataDate < dataDate).slice(-11);
    if (trail.length >= 2) {
        kpiSeries = Object.fromEntries(
            (Object.keys(kpis) as Array<keyof Kpis>).map(key => [key, [...trail.map(s => s.kpis[key]), kpis[key]]])
        ) as Record<keyof Kpis, number[]>;
    }

    return {
        generated: new Date().toISOString().slice(0, 10),
        dataDate,
        kpis,
        previous,
        kpiSeries,
        corpus: plugins + themes,
        metaFields: [...metaFieldAddons.entries()]
            .map(([field, count]) => ({field, addons: count, known: isKnownField(field), required: isRequiredField(field)}))
            .sort((a, b) => b.addons - a.addons),
        metaProblems: [...metaProblemAddons.entries()]
            .map(([key, list]) => {
                const split = key.indexOf(":");
                return split === -1
                    ? {problem: key, field: "", addons: list.sort()}
                    : {problem: key.slice(0, split), field: key.slice(split + 1), addons: list.sort()};
            })
            .sort((a, b) => b.addons.length - a.addons.length),
        selfUpdaters: selfUpdaters.sort(),
        namespaces: [...namespaceStats.entries()]
            .map(([name, s]) => ({name, calls: s.calls, plugins: s.plugins.size}))
            .sort((a, b) => b.calls - a.calls),
        apis: Object.entries(apiCalls)
            .map(([api, calls]) => ({api, calls, plugins: apiPlugins.get(api) ?? 0}))
            .sort((a, b) => b.calls - a.calls),
        requires: Object.entries(requireCalls)
            .map(([module, calls]) => ({module, calls, plugins: (requirePlugins.get(module) ?? []).sort()}))
            .sort((a, b) => b.plugins.length - a.plugins.length),
        globals: Object.entries(globalCalls)
            .map(([name, calls]) => ({name, calls, plugins: globalPlugins.get(name) ?? 0}))
            .sort((a, b) => b.plugins - a.plugins || b.calls - a.calls),
        reactHazards: Object.entries(reactCalls)
            .map(([method, calls]) => ({method, calls, plugins: reactPlugins.get(method) ?? 0, hazard: isHazardMethod(method)}))
            .sort((a, b) => Number(b.hazard) - Number(a.hazard) || b.plugins - a.plugins),
        fragile: fragile.sort((a, b) => b.tokens - a.tokens),
        fragileAddons: fragile.length,
        webpackTargets: Object.entries(webpackCalls)
            .map(([key, calls]) => {
                const split = key.indexOf(":");
                return {kind: key.slice(0, split), value: key.slice(split + 1), calls, plugins: webpackPlugins.get(key) ?? 0};
            })
            .sort((a, b) => b.plugins - a.plugins || b.calls - a.calls),
        patcherTargets: Object.entries(patcherCalls)
            .map(([method, calls]) => ({method, calls, plugins: patcherPlugins.get(method) ?? 0}))
            .sort((a, b) => b.plugins - a.plugins || b.calls - a.calls),
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

// Green is reserved for movement in a direction the maintainers actually want. Corpus growth is
// neutral (more plugins is not "good"), so it stays secondary ink; a dropping require count is
// the campaign working. Nothing is ever coloured red — this report is not a scoreboard.
function deltaLine(current: number, previous: number | undefined, since: string | undefined, lowerIsBetter: boolean, fallback = ""): string {
    if (previous === undefined || since === undefined) return fallback ? `<div class="delta">${fallback}</div>` : "";
    const change = current - previous;
    if (change === 0) return `<div class="delta">no change since ${since}</div>`;
    const good = lowerIsBetter && change < 0;
    return `<div class="delta${good ? " good" : ""}">${change > 0 ? "+" : "&minus;"}${fmt(Math.abs(change))} since ${since}</div>`;
}

// Tile sparkline: trend in the de-emphasis hue, the current value as an accent end-dot
// with a surface ring. Skipped for all-zero series — a flat floor line is noise, not trend.
function spark(values: number[] | undefined): string {
    if (!values || values.length < 3 || Math.max(...values) === 0) return "";
    const w = 72;
    const h = 20;
    const pad = 4;
    const max = Math.max(...values);
    const min = Math.min(...values);
    const x = (i: number) => pad + (i / (values.length - 1)) * (w - 2 * pad);
    const y = (v: number) => max === min ? h / 2 : pad + (1 - (v - min) / (max - min)) * (h - 2 * pad);
    const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    const endX = x(values.length - 1).toFixed(1);
    const endY = y(values[values.length - 1]).toFixed(1);
    return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="trend across ${values.length} snapshots">` + `<polyline points="${points}" fill="none" stroke="var(--muted)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>` + `<circle cx="${endX}" cy="${endY}" r="3.5" fill="var(--surface)"/>` + `<circle cx="${endX}" cy="${endY}" r="2.2" fill="var(--accent)"/>` + `</svg>`;
}

// Table cell version: blank when there is no history to compare against
function deltaCell(current: number, previous: number | undefined, lowerIsBetter: boolean): string {
    if (previous === undefined) return `<td class="num muted">&mdash;</td>`;
    const change = current - previous;
    if (change === 0) return `<td class="num muted">0</td>`;
    const good = lowerIsBetter && change < 0;
    return `<td class="num${good ? " good" : " muted"}">${change > 0 ? "+" : "&minus;"}${fmt(Math.abs(change))}</td>`;
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

// value/method rows ranked by plugin count, with an optional kind chip
function targetTable(rows: Array<{label: string, chip?: string, calls: number, plugins: number}>, labelHead: string, visible = 25): string {
    const max = rows[0]?.plugins ?? 0;
    const row = (r: {label: string, chip?: string, calls: number, plugins: number}) =>
        `<tr><td><code>${escapeHtml(r.label)}</code>${r.chip ? ` <span class="chip">${escapeHtml(r.chip)}</span>` : ""}</td><td class="bar-cell">${bar(r.plugins, max)}</td><td class="num">${fmt(r.plugins)}</td><td class="num muted">${fmt(r.calls)}</td></tr>`;
    const head = `<table><thead><tr><th>${labelHead}</th><th></th><th class="num">Plugins</th><th class="num">Calls</th></tr></thead><tbody>`;
    const shown = rows.slice(0, visible).map(row).join("");
    const rest = rows.slice(visible);
    const tail = rest.length
        ? `</tbody></table><details><summary>Show ${rest.length} more</summary><table><tbody>${rest.map(row).join("")}</tbody></table></details>`
        : "</tbody></table>";
    return head + shown + tail || `<p class="muted">none found</p>`;
}

// Addons ranked by hardcoded-class count, worst first
function fragileTable(rows: ReportData["fragile"], visible = 15): string {
    if (!rows.length) return `<p class="muted">none found</p>`;
    const max = rows[0]?.tokens ?? 0;
    const row = (r: ReportData["fragile"][number]) =>
        `<tr><td>${escapeHtml(r.name)} <span class="chip">${r.type}</span></td><td class="bar-cell">${bar(r.tokens, max)}</td><td class="num">${fmt(r.tokens)}</td></tr>`;
    const head = `<table><thead><tr><th>Addon</th><th></th><th class="num">Hardcoded classes</th></tr></thead><tbody>`;
    const rest = rows.slice(visible);
    const tail = rest.length
        ? `</tbody></table><details><summary>Show ${rest.length} more</summary><table><tbody>${rest.map(row).join("")}</tbody></table></details>`
        : "</tbody></table>";
    return head + rows.slice(0, visible).map(row).join("") + tail;
}

// Field coverage: how much of the corpus ships each meta field, required ones first
function metaFieldTable(rows: ReportData["metaFields"], corpus: number): string {
    const order = (r: ReportData["metaFields"][number]) => (r.required ? 0 : r.known ? 1 : 2);
    const sorted = rows.slice().sort((a, b) => order(a) - order(b) || b.addons - a.addons);
    const row = (r: ReportData["metaFields"][number]) => {
        const chip = r.required ? `<span class="chip">required</span>` : r.known ? "" : `<span class="chip">non-standard</span>`;
        return `<tr><td><code>@${escapeHtml(r.field)}</code> ${chip}</td><td class="bar-cell">${bar(r.addons, corpus)}</td><td class="num">${fmt(r.addons)}</td><td class="num muted">${((r.addons / corpus) * 100).toFixed(0)}%</td></tr>`;
    };
    return `<table class="meta-fields"><thead><tr><th>Field</th><th></th><th class="num">Addons</th><th class="num">% of corpus</th></tr></thead><tbody>${sorted.map(row).join("")}</tbody></table>`;
}

const PROBLEM_LABELS: Record<string, string> = {
    "no-meta-block": "No meta block on the first line",
    "missing": "Missing required field",
    "duplicate": "Field declared more than once",
    "empty": "Field present but empty",
    "invalid-version": "Version is not a version number",
    "invalid-url": "Link field is not an http(s) URL",
    "valueless-field": "Field written with no value"
};

function metaProblemTable(rows: ReportData["metaProblems"]): string {
    if (!rows.length) return `<p class="muted">&#10003; no malformed meta blocks in the corpus</p>`;
    return `<table><thead><tr><th>Problem</th><th class="num">Addons</th></tr></thead><tbody>
    ${rows.map(r => {
        const label = PROBLEM_LABELS[r.problem] ?? r.problem;
        const field = r.field ? ` <code>@${escapeHtml(r.field)}</code>` : "";
        return `<tr><td>${escapeHtml(label)}${field}</td><td class="num">${fmt(r.addons.length)}</td></tr>
        <tr><td colspan="2"><details><summary>Which addons</summary><ul>${r.addons.map(a => `<li>${escapeHtml(a)}</li>`).join("")}</ul></details></td></tr>`;
    }).join("")}
    </tbody></table>`;
}

function render(d: ReportData): string {
    const k = d.kpis;
    const series = d.kpiSeries;
    const p = d.previous?.kpis;
    const since = d.previous?.dataDate;
    const prevRequires = asRecord(d.previous?.summary.requires);
    const nsMax = d.namespaces[0]?.calls ?? 0;
    const prevApis = asRecord(d.previous?.summary["bdapi-usage"]);
    // Neutral direction: this table measures the blast radius of an API change, and a rising
    // call count is information, not a regression.
    const apiRow = (a: {api: string, calls: number, plugins: number}, max: number) =>
        `<tr><td><code>${escapeHtml(a.api)}</code></td><td class="bar-cell">${bar(a.calls, max)}</td><td class="num">${fmt(a.calls)}</td><td class="num muted">${fmt(a.plugins)}</td>${deltaCell(a.calls, prevApis[a.api], false)}</tr>`;
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
.tile .spark { display: block; margin-top: 6px; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 18px 20px; margin-bottom: 20px; }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
@media (max-width: 800px) { .cols { grid-template-columns: 1fr; } }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th { text-align: left; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); padding: 6px 8px; border-bottom: 1px solid var(--hairline); }
td { padding: 5px 8px; border-bottom: 1px solid var(--hairline); vertical-align: middle; }
tbody tr:hover { background: color-mix(in srgb, var(--accent) 6%, transparent); }
.num { font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
.muted { color: var(--muted); }
td.good { color: var(--good); }
th.num { text-align: right; }
.bar-cell { width: 34%; min-width: 90px; }
/* field + chip must stay on one line in the narrow two-column card, so the bar yields width */
.meta-fields td:first-child { white-space: nowrap; }
.meta-fields .bar-cell { width: 20%; min-width: 50px; }
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
    <div class="tile"><div class="label">Plugins analyzed</div><div class="value">${fmt(k.plugins)}</div>${deltaLine(k.plugins, p?.plugins, since, false)}${spark(series?.plugins)}</div>
    <div class="tile"><div class="label">Themes analyzed</div><div class="value">${fmt(k.themes)}</div>${deltaLine(k.themes, p?.themes, since, false)}${spark(series?.themes)}</div>
    <div class="tile"><div class="label">Authors</div><div class="value">${fmt(k.authors)}</div>${deltaLine(k.authors, p?.authors, since, false)}${spark(series?.authors)}</div>
    <div class="tile"><div class="label">Parse errors</div><div class="value">${fmt(k.parseErrors)}</div><div class="delta${k.parseErrors === 0 ? " good" : ""}">${k.parseErrors === 0 ? "&#10003; full AST coverage" : "plugins skipped"}</div>${spark(series?.parseErrors)}</div>
    <div class="tile"><div class="label">Legacy API uses</div><div class="value">${fmt(k.deprecatedUses)}</div><div class="delta${k.deprecatedUses === 0 ? " good" : ""}">${k.deprecatedUses === 0 ? "&#10003; old-old APIs are gone" : "see bdapi table"}</div>${spark(series?.deprecatedUses)}</div>
    <div class="tile"><div class="label">Using require()</div><div class="value">${fmt(k.requirePlugins)}</div>${deltaLine(k.requirePlugins, p?.requirePlugins, since, true, "plugins on the polyfill")}${spark(series?.requirePlugins)}</div>
    <div class="tile"><div class="label">Bundled / packed code</div><div class="value">${fmt(k.flagged)}</div>${deltaLine(k.flagged, p?.flagged, since, true, "plugins, by heuristic")}${spark(series?.flagged)}</div>
    <div class="tile"><div class="label">Hardcoding classes</div><div class="value">${fmt(k.fragileAddons)}</div>${deltaLine(k.fragileAddons, p?.fragileAddons, since, true, "addons breaking on class churn")}${spark(series?.fragileAddons)}</div>
    <div class="tile"><div class="label">Malformed meta</div><div class="value">${fmt(k.metaProblemAddons)}</div>${deltaLine(k.metaProblemAddons, p?.metaProblemAddons, since, true, "addons with meta problems")}${spark(series?.metaProblemAddons)}</div>
    <div class="tile"><div class="label">Self-installing</div><div class="value">${fmt(k.selfUpdating)}</div>${deltaLine(k.selfUpdating, p?.selfUpdating, since, true, "plugins writing plugin files")}${spark(series?.selfUpdating)}</div>
</div>

<div class="card">
    <h2>require() usage — polyfill retirement list</h2>
    <p class="note">BetterDiscord has no real <code>require</code>; these modules are served by the polyfill. Each list names the plugins to migrate before it can be removed. Plugins also reach the same environment without <code>require</code> &mdash; see Environment coupling below.</p>
    <table><thead><tr><th>Module</th><th></th><th class="num">Plugins</th><th class="num">Calls</th><th class="num">&Delta; calls</th></tr></thead><tbody>
    ${d.requires.map(r => `<tr><td><code>require("${escapeHtml(r.module)}")</code></td><td class="bar-cell">${bar(r.plugins.length, d.requires[0]?.plugins.length ?? 0)}</td><td class="num">${fmt(r.plugins.length)}</td><td class="num muted">${fmt(r.calls)}</td>${deltaCell(r.calls, prevRequires[r.module], true)}</tr>
    <tr><td colspan="5" style="border-bottom:1px solid var(--hairline)"><details><summary>Plugins requiring <code>${escapeHtml(r.module)}</code></summary><ul>${r.plugins.map(name => `<li>${escapeHtml(name)}</li>`).join("")}</ul></details></td></tr>`).join("")}
    </tbody></table>
    ${since ? `<p class="note">&Delta; compares against the ${since} snapshot.</p>` : `<p class="note">No earlier snapshot yet &mdash; deltas appear once a second data date is recorded in <code>history/</code>.</p>`}
</div>

<div class="card">
    <h2>Environment coupling</h2>
    <p class="note">The rest of what plugins reach for outside the addon sandbox: Node/Electron globals touched directly rather than through the <code>require</code> polyfill, and the React entry points that break on a Discord React bump.</p>
    <div class="cols">
        <div>
            <h2>Node/Electron globals</h2>
            <p class="note">Direct access to the bridged environment, shown as root plus one segment. A file that binds one of these names locally (<code>function f(process)</code>) is skipped entirely rather than guessed at, so these are floor values.</p>
            ${targetTable(d.globals.map(g => ({label: g.name, calls: g.calls, plugins: g.plugins})), "Global", 15)}
        </div>
        <div>
            <h2>React-upgrade hazards</h2>
            <p class="note">Entry points that break when Discord bumps React: <code>render</code>, <code>findDOMNode</code> and <code>unmountComponentAtNode</code> were removed in React 19, <code>hydrate</code> in 18. <code>createRoot</code> is the opposite signal &mdash; plugins already on the modern root API.</p>
            ${targetTable(d.reactHazards.map(r => ({label: r.method, chip: r.hazard ? "hazard" : "modern", calls: r.calls, plugins: r.plugins})), "Method", 15)}
        </div>
    </div>
</div>

<div class="card">
    <h2>BdApi usage by namespace</h2>
    <p class="note">Calls resolved through aliases, destructuring, and <code>new BdApi()</code> instances. Use this to weigh the impact of API changes.</p>
    <table><thead><tr><th>Namespace</th><th></th><th class="num">Calls</th><th class="num">Plugins</th></tr></thead><tbody>
    ${d.namespaces.map(n => `<tr><td><code>BdApi.${escapeHtml(n.name)}</code></td><td class="bar-cell">${bar(n.calls, nsMax)}</td><td class="num">${fmt(n.calls)}</td><td class="num muted">${fmt(n.plugins)}</td></tr>`).join("")}
    </tbody></table>
    <details><summary>Top individual APIs (${fmt(d.apis.length)} distinct)</summary>
    <table><thead><tr><th>API</th><th></th><th class="num">Calls</th><th class="num">Plugins</th><th class="num">&Delta;</th></tr></thead><tbody>
    ${topApis.map(a => apiRow(a, apiMax)).join("")}
    </tbody></table>
    ${restApis.length ? `<details><summary>Show all ${fmt(restApis.length)} remaining APIs</summary><table><tbody>${restApis.map(a => apiRow(a, apiMax)).join("")}</tbody></table></details>` : ""}
    </details>
</div>

<div class="card">
    <h2>Discord internals reliance</h2>
    <p class="note">What the ecosystem pulls out of Discord's webpack (module keys, exported strings, prototype keys, stores, display names) and which methods it patches. This is the surface that breaks on Discord updates &mdash; the highest-demand entries are candidates for a stable <code>CommonModules</code> offering. Undercounts plugins built on BDFDB or ZeresPluginLibrary, which route these lookups through the library rather than <code>BdApi</code> directly.</p>
    <div class="cols">
        <div><h2>Webpack lookup targets</h2>${targetTable(d.webpackTargets.map(t => ({label: t.value, chip: t.kind, calls: t.calls, plugins: t.plugins})), "Target")}</div>
        <div><h2>Patched methods</h2>${targetTable(d.patcherTargets.map(t => ({label: t.method, calls: t.calls, plugins: t.plugins})), "Method")}</div>
    </div>
</div>

<div class="card">
    <h2>Hardcoded Discord class names</h2>
    <p class="note">Discord ships hashed CSS classes in two styles &mdash; <code>wrapper_a1b2c3</code> and <code>name__2ea32</code> &mdash; and rehashes them on class churn. Every token counted here is a selector that silently stops matching when that happens; the fix is a class-module lookup such as <code>BdApi.Webpack.getByKeys(&hellip;)</code>. Counts are occurrences, not distinct classes: a vendored class-name map inflates a single addon fast.</p>
    ${fragileTable(d.fragile)}
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
    <h2>Meta health</h2>
    <p class="note">Every addon opens with a JSDoc meta block, parsed by BetterDiscord's <code>parseJsDoc</code>. This table is what BD itself sees: the same parser runs here, so a field listed as present is a field BD resolves. <code>@name</code>, <code>@author</code>, <code>@description</code> and <code>@version</code> are required; BD papers over the last three at load time with <code>Unknown Author</code> / <code>???</code> / <code>No description</code>, so a missing one degrades the UI rather than failing outright. Non-standard fields are author or library conventions BD ignores &mdash; they are listed for coverage, not judged.</p>
    <div class="cols">
        <div>
            <h2>Field coverage</h2>
            ${metaFieldTable(d.metaFields, d.corpus)}
        </div>
        <div>
            <h2>Problems (${fmt(d.metaProblems.reduce((a, r) => a + r.addons.length, 0))} across ${fmt(k.metaProblemAddons)} addons)</h2>
            <p class="note">Only fields BD consumes are validated. Duplicated <em>non-standard</em> fields are conventions (DevilBro's <code>@var</code> theme settings, <code>@changelog</code>) and are not counted as defects.</p>
            ${metaProblemTable(d.metaProblems)}
        </div>
    </div>
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
            <h2>Bundling / packing signals</h2>
            <table><thead><tr><th>Signal</th><th></th><th class="num">Plugins</th></tr></thead><tbody>
            ${d.obfuscationSignals.map(s => `<tr><td>${escapeHtml(s.name)}</td><td class="bar-cell">${bar(s.plugins, d.obfuscationSignals[0]?.plugins ?? 0)}</td><td class="num">${fmt(s.plugins)}</td></tr>`).join("")}
            </tbody></table>
        </div>
    </div>
    <h2 style="margin-top:16px">Self-installing plugins (${d.selfUpdaters.length})</h2>
    <p class="note">Plugins that both fetch a <code>.plugin.js</code> URL and write a <code>.plugin.js</code> path &mdash; they install executable code outside the store's review path, which is the supply-chain surface worth keeping a list of. Both signals are required: a <code>.plugin.js</code> URL on its own is usually just a <code>@source</code> link, and a write on its own is usually a data file. In this corpus the whole list is the BDFDB library downloader that every DevilBro addon ships, which fetches <code>0BDFDB.plugin.js</code> and writes it into <code>BdApi.Plugins.folder</code> &mdash; a library bootstrap rather than literal self-update.</p>
    ${d.selfUpdaters.length
        ? `<details><summary>Show all ${d.selfUpdaters.length}</summary><ul>${d.selfUpdaters.map(s => `<li>${escapeHtml(s)}</li>`).join("")}</ul></details>`
        : `<p class="muted">none found</p>`}

    <h2 style="margin-top:16px">Bundled / minified code (${d.flagged.length})</h2>
    <p class="note">Heuristic score &ge; 0.4 — code that resists reading because it is bundled, minified, or packed. This measures <em>readability, not safety</em>: every addon here passed the store's normal review, and build tooling is the usual cause.</p>
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
