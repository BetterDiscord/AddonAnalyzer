import fs from "fs/promises";
import path from "path";
import {lifecycleStatus} from "./ast/rules/lifecycle";
import {isKnownField, isRequiredField} from "./ast/rules/meta";
import {isHazardMethod} from "./ast/rules/reacthazards";
import {cacheFolder, resultsFolder} from "./constants";
import {discordVarCount, discordVarSource, isDiscordVariable} from "./discordvars";
import {DYNAMIC_SEGMENT} from "./evaluator/strings";
import {weekStart} from "./cache";
import {deriveKpis, METHODOLOGY, readHistory, type AddonsJson, type Kpis, type Snapshot, type SummaryJson} from "./history";
import {loadStoreMeta, monthsBetween, stalenessBucket, storeMetaKey, type Staleness} from "./storemeta";
import {declaredPaths, surface, unusedPaths} from "./surface";


type ResultValue = Record<string, number> | number | boolean | string[];

interface HostStats {refs: number; addons: Set<string>;}

interface StaleBucket {addons: number; downloads: number;}

function escapeHtml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmt(n: number): string {
    return n.toLocaleString("en-US");
}

// Human-readable byte size for the corpus-size tile (raw byte counts are unreadable at MB scale)
function humanBytes(n: number): string {
    if (n < 1024) return `${fmt(n)} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Download counts span 3 to 8 digits, so tables humanize them the same way bytes are
function humanCount(n: number): string {
    if (n < 1000) return fmt(n);
    if (n < 1e6) return `${(n / 1e3).toFixed(1)}K`;
    return `${(n / 1e6).toFixed(1)}M`;
}

// Weighted-column cell: null means the store metadata was unavailable for this run, which
// must read as "unknown", never as a zero-download claim
function dlCell(v: number | null): string {
    return v === null ? `<td class="num muted">&mdash;</td>` : `<td class="num muted">${humanCount(v)}</td>`;
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

    // Declared-but-uncalled members grouped by namespace, the phantom calls going the other
    // way, and the manifest provenance every number in that card depends on
    removals: Array<{namespace: string, members: Array<{name: string, deprecated: boolean}>}>;
    declaredApis: number;
    unusedApis: number;
    phantoms: Array<{path: string, calls: number, plugins: string[]}>;

    // Namespace-level chains whose member the AST could not resolve (`W[name]()`). These are
    // the only way the unused list could be wrong, so it names them instead of implying none.
    opaqueChains: string[];

    // Weighted columns (handoff-08 B2): `downloads` is the combined cumulative lifetime store
    // downloads of the plugins behind each row — installed base, never active users. Raw addon
    // counts stay primary and remain the sort key everywhere; the weighted reading sits beside
    // them. null (not 0) when the store metadata was unavailable for the whole run.
    lifecycle: Array<{member: string, plugins: number, status: "deprecated" | "candidate" | "current", downloads: number | null}>;
    namespaces: Array<{name: string, calls: number, plugins: number}>;
    apis: Array<{api: string, calls: number, plugins: number}>;
    requires: Array<{module: string, calls: number, plugins: string[], downloads: number | null}>;
    globals: Array<{name: string, calls: number, plugins: number}>;
    reactHazards: Array<{method: string, calls: number, plugins: number, hazard: boolean}>;
    // tokens = raw occurrences (total blast radius, the ranking key); perKb = occurrences per KB of
    // analyzed content (how riddled the addon is). For themes, "analyzed content" is store file +
    // remote @import CSS — the content class-literals actually counted — so import-only themes get an
    // honest density instead of a six-figure one against their ~1KB wrapper.
    fragile: Array<{name: string, tokens: number, perKb: number, type: "plugin" | "theme"}>;
    fragileAddons: number;

    // Attribute-substring class selectors ([class*= / [class^=): the churn-resilient counterpart
    // of `fragile`, counted over the same content (store file + remote @import CSS for themes,
    // string literals for plugins). Addon presence split by type, plus raw selector occurrences —
    // rendered as the healthy-pairing caption on the hardcoded-classes card.
    resilient: {themes: number, plugins: number, selectors: number};

    // CSS custom properties: the healthy counterpart to hardcoded classes. Consuming Discord's
    // variables survives class churn; defining (reskinning) Discord's own names is how themes
    // retheme but also how they break on a Discord rename. Counted over theme + embedded-CSS content.
    cssVars: {
        consumeDiscordAddons: number; // addons consuming >= 1 live Discord variable (health)
        defineAddons: number; // addons defining any custom property
        overlapAddons: number; // addons defining >= 1 live Discord variable name (reskin/overlap)
        outdatedAddons: number; // addons defining/consuming >= 1 removed Discord variable name
        definitionNames: number; // distinct property names defined across the corpus
        topConsumed: Array<{name: string, addons: number}>; // live Discord vars, by addon count
        topOverlap: Array<{name: string, addons: number}>; // reskinned Discord vars, by addon count
        topOutdated: Array<{name: string, addons: number}>; // removed Discord vars still in use, by addon count
    };
    webpackTargets: Array<{kind: string, value: string, calls: number, plugins: number}>;
    patcherTargets: Array<{method: string, calls: number, plugins: number}>;

    // Plugins routing Discord access through a library (BDFDB, ZeresPluginLibrary) instead of
    // BdApi — the size of the blind spot the internals numbers above undercount. `reads` is how
    // many of them actively call the library rather than only guarding for it.
    libraryDeps: Array<{library: string, plugins: number, reads: number, downloads: number | null}>;
    libraryDepTotal: number;
    libraryDepDownloads: number | null;

    // Combined cumulative downloads across the analyzed corpus — the denominator that turns
    // any weighted column into a share of the installed base
    corpusDownloads: number | null;

    // Staleness × fragility (handoff-08 B3): will the affected addons adapt, or simply break?
    // Buckets by last store release vs the data week (storemeta.stalenessBucket); "deprecated
    // surface" = get-family lifecycle ∪ outdated CSS variables ∪ old-old BdApi aliases. null
    // when store metadata is unavailable — the card is skipped rather than rendered empty.
    staleness: {
        dataDate: string;
        corpus: Record<Staleness, StaleBucket>;
        signals: Array<{label: string, buckets: Record<Staleness, StaleBucket>}>;
        outreach: Array<{name: string, downloads: number, lastRelease: string, surfaces: string[]}>;
        abandonedDeprecated: {addons: number, downloads: number, names: string[]};
        observer: Record<Staleness, number>;
        newcomers: {total: number, deprecated: number};
    } | null;

    // Style injection: the API (BdApi.DOM.addStyle) vs the hand-rolled <style> element. A rare
    // case where the API is winning, so the card presents it as the good news it is.
    rawStyle: {rawAddons: number, apiAddons: number};
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

    // Store metadata for the weighted readings; an empty map (unreadable cache file) makes
    // every weighted value null so the tables show "—" rather than claiming zero downloads
    const storeMeta = await loadStoreMeta();
    const hasStoreMeta = storeMeta.size > 0;

    // Staleness buckets compare release dates against the data week's Monday — the same key
    // the history snapshot carries — not the run date or the raw download timestamp
    const weekDate = weekStart(new Date(meta.lastUpdated));

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
    const libraryDepAddons = new Map<string, number>(); // library -> dependent addons
    const libraryReadAddons = new Map<string, number>(); // library -> addons that actively call it
    const libraryDepPlugins = new Set<string>(); // distinct plugins depending on any library
    let rawStyleAddons = 0; // plugins hand-rolling a <style> element
    let rawScriptAddons = 0; // plugins creating a <script> element
    const metaFieldAddons = new Map<string, number>();
    const metaProblemAddons = new Map<string, string[]>();
    const phantomPlugins = new Map<string, string[]>();
    const lifecyclePlugins = new Map<string, number>();
    const lifecycleDownloads = new Map<string, number>(); // member -> downloads of defining plugins
    const requireDownloads = new Map<string, number>(); // module -> downloads of requiring plugins
    const libraryDownloads = new Map<string, number>(); // library -> downloads of its dependents
    let libraryDepDownloads = 0; // downloads of distinct plugins depending on any library
    let corpusDownloads = 0;

    // Staleness × fragility (B3): per-bucket tallies for the whole corpus and per signal,
    // plus the conjunction readings (outreach, silently-degraded, observer, newcomers)
    const emptyBuckets = (): Record<Staleness, StaleBucket> => ({
        active: {addons: 0, downloads: 0}, aging: {addons: 0, downloads: 0}, abandoned: {addons: 0, downloads: 0}
    });
    const stalenessCorpus = emptyBuckets();
    const STALENESS_SIGNALS = [
        "Hardcoded Discord classes",
        "Outdated CSS variables",
        "Deprecated lifecycle (get-family)",
        "Legacy ReactDOM entry points",
        "require() polyfill"
    ] as const;
    const signalBuckets = new Map<string, Record<Staleness, StaleBucket>>(STALENESS_SIGNALS.map(label => [label, emptyBuckets()]));
    const outreach: Array<{name: string, downloads: number, lastRelease: string, surfaces: string[]}> = [];
    const abandonedDeprecated = {addons: 0, downloads: 0, names: [] as string[]};
    const observerBuckets: Record<Staleness, number> = {active: 0, aging: 0, abandoned: 0};
    const newcomers = {total: 0, deprecated: 0};
    const selfUpdaters: string[] = [];
    const fragile: ReportData["fragile"] = [];
    const resilient: ReportData["resilient"] = {themes: 0, plugins: 0, selectors: 0};
    const flagged: Array<{name: string, signals: string[]}> = [];

    // CSS-variable presence, counted per addon (a name defined 40× in one theme is one addon here)
    const consumedDiscord = new Map<string, number>(); // live Discord var -> addons consuming it
    const overlapDefs = new Map<string, number>(); // live Discord var -> addons defining (reskinning) it
    const outdatedUse = new Map<string, number>(); // removed Discord var -> addons still touching it
    const definitionNames = new Set<string>();
    let consumeDiscordAddons = 0;
    let defineAddons = 0;
    let overlapAddons = 0;
    let outdatedAddons = 0;

    for (const author of Object.keys(addons)) {
        for (const [file, results] of Object.entries(addons[author])) {
            const name = `${author} / ${file.replace(/\.(plugin\.js|theme\.css)$/, "")}`;
            if (file.endsWith(".plugin.js")) plugins++;
            else themes++;

            // Cumulative lifetime downloads of this addon — the installed-base weight behind
            // every per-addon count below. 0 for the (currently unseen) case of a disk file
            // the store response doesn't cover; it then counts raw but weighs nothing.
            const store = storeMeta.get(storeMetaKey(author, file));
            const downloads = store?.downloads ?? 0;
            corpusDownloads += downloads;

            for (const api of Object.keys(asRecord(results["bdapi-usage"]))) {
                apiPlugins.set(api, (apiPlugins.get(api) ?? 0) + 1);
            }
            for (const module of Object.keys(asRecord(results.requires))) {
                if (!requirePlugins.has(module)) requirePlugins.set(module, []);
                requirePlugins.get(module)!.push(name);
                requireDownloads.set(module, (requireDownloads.get(module) ?? 0) + downloads);
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
            const libs = Object.keys(asRecord(results["library-deps"]));
            if (libs.length) {
                libraryDepPlugins.add(name);
                libraryDepDownloads += downloads;
            }
            for (const lib of libs) {
                libraryDepAddons.set(lib, (libraryDepAddons.get(lib) ?? 0) + 1);
                libraryDownloads.set(lib, (libraryDownloads.get(lib) ?? 0) + downloads);
            }
            for (const sig of Object.keys(asRecord(results["library-dep-signals"]))) {
                if (!sig.endsWith(":read")) continue;
                const lib = sig.slice(0, -":read".length);
                libraryReadAddons.set(lib, (libraryReadAddons.get(lib) ?? 0) + 1);
            }
            const rawDomShapes = Object.keys(asRecord(results["raw-dom"]));
            if (rawDomShapes.includes("raw-style-element")) rawStyleAddons++;
            if (rawDomShapes.includes("raw-script-element")) rawScriptAddons++;
            for (const field of Object.keys(asRecord(results["meta-fields"]))) {
                metaFieldAddons.set(field, (metaFieldAddons.get(field) ?? 0) + 1);
            }
            for (const phantom of Object.keys(asRecord(results["phantom-apis"]))) {
                if (!phantomPlugins.has(phantom)) phantomPlugins.set(phantom, []);
                phantomPlugins.get(phantom)!.push(name);
            }
            for (const member of Object.keys(asRecord(results.lifecycle))) {
                lifecyclePlugins.set(member, (lifecyclePlugins.get(member) ?? 0) + 1);
                lifecycleDownloads.set(member, (lifecycleDownloads.get(member) ?? 0) + downloads);
            }
            for (const problem of Object.keys(asRecord(results["meta-problems"]))) {
                if (!metaProblemAddons.has(problem)) metaProblemAddons.set(problem, []);
                metaProblemAddons.get(problem)!.push(name);
            }
            if (results["self-updating"] === true) selfUpdaters.push(name);

            const tokens = results["class-literals"];
            if (typeof tokens === "number" && tokens > 0) {
                // Analyzed bytes = store file + remote @import CSS (the content the tokens were counted
                // over). This is bytes-based, so it stays honest for minified plugins where line counts
                // are a lie. Guard the divide: every addon has a size record, but never assume nonzero.
                const sz = asRecord(results.size);
                const analyzedBytes = (sz.bytes ?? 0) + (sz.remoteBytes ?? 0);
                const perKb = analyzedBytes > 0 ? tokens / (analyzedBytes / 1000) : 0;
                fragile.push({name, tokens, perKb, type: file.endsWith(".plugin.js") ? "plugin" : "theme"});
            }
            const substringSelectors = results["substring-selectors"];
            if (typeof substringSelectors === "number" && substringSelectors > 0) {
                resilient.selectors += substringSelectors;
                if (file.endsWith(".plugin.js")) resilient.plugins++;
                else resilient.themes++;
            }
            if (results["obfuscated-plugins"] === true) {
                flagged.push({name, signals: Object.keys(asRecord(results["obfuscation-signals"]))});
            }

            const usage = Object.keys(asRecord(results["css-var-usage"]));
            const defs = Object.keys(asRecord(results["css-var-definitions"]));
            const overlaps = Object.keys(asRecord(results["css-var-overlap"]));
            const outdated = Object.keys(asRecord(results["css-var-outdated"]));
            const discordConsumed = usage.filter(isDiscordVariable);
            if (discordConsumed.length) consumeDiscordAddons++;
            if (defs.length) defineAddons++;
            if (overlaps.length) overlapAddons++;
            if (outdated.length) outdatedAddons++;
            for (const nm of discordConsumed) consumedDiscord.set(nm, (consumedDiscord.get(nm) ?? 0) + 1);
            for (const nm of overlaps) overlapDefs.set(nm, (overlapDefs.get(nm) ?? 0) + 1);
            for (const nm of outdated) outdatedUse.set(nm, (outdatedUse.get(nm) ?? 0) + 1);
            for (const nm of defs) definitionNames.add(nm);

            // Staleness × fragility (B3): which maintenance bucket this addon's signals land
            // in, plus the conjunction readings the card calls out. "Deprecated surface" is
            // the same union the deprecatedSurfaceDownloads KPI uses: get-family lifecycle,
            // outdated CSS variables, old-old BdApi aliases.
            if (store) {
                const bucket = stalenessBucket(store.latestRelease, weekDate);
                stalenessCorpus[bucket].addons++;
                stalenessCorpus[bucket].downloads += downloads;

                const mark = (label: string, hit: boolean) => {
                    if (!hit) return;
                    const b = signalBuckets.get(label)![bucket];
                    b.addons++;
                    b.downloads += downloads;
                };
                const deprecatedLifecycle = Object.keys(asRecord(results.lifecycle)).filter(m => lifecycleStatus(m) === "deprecated");
                mark("Hardcoded Discord classes", typeof tokens === "number" && tokens > 0);
                mark("Outdated CSS variables", outdated.length > 0);
                mark("Deprecated lifecycle (get-family)", deprecatedLifecycle.length > 0);
                mark("Legacy ReactDOM entry points", Object.keys(asRecord(results["react-hazards"])).some(isHazardMethod));
                mark("require() polyfill", Object.keys(asRecord(results.requires)).length > 0);

                const surfaces: string[] = [];
                if (deprecatedLifecycle.length) surfaces.push("get-family lifecycle");
                if (outdated.length) surfaces.push("outdated CSS variables");
                if (Object.keys(asRecord(results["deprecated-apis"])).length) surfaces.push("legacy BdApi aliases");
                if (surfaces.length && bucket === "active") {
                    outreach.push({name, downloads, lastRelease: store.latestRelease.slice(0, 10), surfaces});
                }
                if (surfaces.length && bucket === "abandoned") {
                    abandonedDeprecated.addons++;
                    abandonedDeprecated.downloads += downloads;
                    abandonedDeprecated.names.push(name);
                }
                if (Object.hasOwn(asRecord(results.lifecycle), "observer")) observerBuckets[bucket]++;
                if (monthsBetween(store.initialRelease, weekDate) <= 12) {
                    newcomers.total++;
                    if (surfaces.length) newcomers.deprecated++;
                }
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
    // Detected by the raw-dom rule but classified with the code sinks: a <script> element loads
    // and executes code, same family as eval/Function/Worker (handoff-08 A3). The raw <style>
    // shape stays on the Environment coupling card via rawStyle below.
    const scriptElementUses = asRecord(summary["raw-dom"])["raw-script-element"] ?? 0;
    const signals = asRecord(summary["obfuscation-signals"]);
    const webpackCalls = asRecord(summary["webpack-targets"]);
    const patcherCalls = asRecord(summary["patcher-targets"]);

    // Unused-ness is a property of the corpus, not of any one addon, so it is derived here from
    // the manifest plus the summed summary rather than contorted into the per-addon Analysis
    // shape (where `Record<member, 0>` would aggregate into nonsense).
    const usedChains = Object.keys(apiCalls);
    const unused = unusedPaths(usedChains);
    const removalGroups = new Map<string, Array<{name: string, deprecated: boolean}>>();
    for (const entry of unused) {
        if (!removalGroups.has(entry.namespace)) removalGroups.set(entry.namespace, []);
        removalGroups.get(entry.namespace)!.push({name: entry.member || "(whole namespace)", deprecated: entry.deprecated});
    }

    // `BdApi.Patcher.*`-shaped chains: the member is computed, so no member of that namespace
    // can be credited and its unused rows are only as good as that blind spot.
    const opaqueChains = usedChains.filter(chain => chain.split(".").length === 3 && chain.endsWith(".*"));

    const phantomCalls = asRecord(summary["phantom-apis"]);
    const lifecycleCounts = asRecord(summary.lifecycle);

    const dataDate = meta.lastUpdated.slice(0, 10);

    // The newest snapshot is this run's own data; "previous" is the newest older dataDate.
    // Compare on the ISO-week Monday (weekDate) — the key snapshots are written under — not
    // the raw download date: a cache downloaded mid-week has raw date > its own snapshot's
    // Monday key, which made the strict < admit this week's snapshot as "previous" and
    // zeroed every delta on locally-downloaded caches.
    const history = await readHistory();
    const previous = history.filter(s => s.dataDate < weekDate).pop() ?? null;

    const kpis = deriveKpis(addons, summary, storeMeta, weekDate);

    // Last 12 snapshots, with the current data as the final point (replacing this
    // dataDate's own snapshot if one was written, so a stale file cannot disagree)
    let kpiSeries: ReportData["kpiSeries"] = null;
    const trail = history.filter(s => s.dataDate < weekDate).slice(-11);
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
        removals: [...removalGroups.entries()]
            .map(([namespace, members]) => ({namespace, members: members.sort((a, b) => a.name.localeCompare(b.name))}))
            .sort((a, b) => b.members.length - a.members.length || a.namespace.localeCompare(b.namespace)),
        declaredApis: declaredPaths().length,
        unusedApis: unused.length,
        phantoms: Object.entries(phantomCalls)
            .map(([p, calls]) => ({path: p, calls, plugins: (phantomPlugins.get(p) ?? []).sort()}))
            .sort((a, b) => b.calls - a.calls),
        opaqueChains,
        lifecycle: Object.entries(lifecycleCounts)
            .map(([member, count]) => ({member, plugins: count, status: lifecycleStatus(member), downloads: hasStoreMeta ? lifecycleDownloads.get(member) ?? 0 : null}))
            .sort((a, b) => {
                const rank = (s: string) => (s === "deprecated" ? 0 : s === "candidate" ? 1 : 2);
                return rank(a.status) - rank(b.status) || b.plugins - a.plugins;
            }),
        namespaces: [...namespaceStats.entries()]
            .map(([name, s]) => ({name, calls: s.calls, plugins: s.plugins.size}))
            .sort((a, b) => b.calls - a.calls),
        apis: Object.entries(apiCalls)
            .map(([api, calls]) => ({api, calls, plugins: apiPlugins.get(api) ?? 0}))
            .sort((a, b) => b.calls - a.calls),
        requires: Object.entries(requireCalls)
            .map(([module, calls]) => ({module, calls, plugins: (requirePlugins.get(module) ?? []).sort(), downloads: hasStoreMeta ? requireDownloads.get(module) ?? 0 : null}))
            .sort((a, b) => b.plugins.length - a.plugins.length),
        globals: Object.entries(globalCalls)
            .map(([name, calls]) => ({name, calls, plugins: globalPlugins.get(name) ?? 0}))
            .sort((a, b) => b.plugins - a.plugins || b.calls - a.calls),
        reactHazards: Object.entries(reactCalls)
            .map(([method, calls]) => ({method, calls, plugins: reactPlugins.get(method) ?? 0, hazard: isHazardMethod(method)}))
            .sort((a, b) => Number(b.hazard) - Number(a.hazard) || b.plugins - a.plugins),
        fragile: fragile.sort((a, b) => b.tokens - a.tokens),
        fragileAddons: fragile.length,
        resilient,
        cssVars: {
            consumeDiscordAddons,
            defineAddons,
            overlapAddons,
            outdatedAddons,
            definitionNames: definitionNames.size,
            topConsumed: [...consumedDiscord.entries()].map(([name, count]) => ({name, addons: count})).sort((a, b) => b.addons - a.addons),
            topOverlap: [...overlapDefs.entries()].map(([name, count]) => ({name, addons: count})).sort((a, b) => b.addons - a.addons),
            topOutdated: [...outdatedUse.entries()].map(([name, count]) => ({name, addons: count})).sort((a, b) => b.addons - a.addons),
        },
        webpackTargets: Object.entries(webpackCalls)
            .map(([key, calls]) => {
                const split = key.indexOf(":");
                return {kind: key.slice(0, split), value: key.slice(split + 1), calls, plugins: webpackPlugins.get(key) ?? 0};
            })
            .sort((a, b) => b.plugins - a.plugins || b.calls - a.calls),
        patcherTargets: Object.entries(patcherCalls)
            .map(([method, calls]) => ({method, calls, plugins: patcherPlugins.get(method) ?? 0}))
            .sort((a, b) => b.plugins - a.plugins || b.calls - a.calls),
        libraryDeps: [...libraryDepAddons.entries()]
            .map(([library, plugins]) => ({library, plugins, reads: libraryReadAddons.get(library) ?? 0, downloads: hasStoreMeta ? libraryDownloads.get(library) ?? 0 : null}))
            .sort((a, b) => b.plugins - a.plugins),
        libraryDepTotal: libraryDepPlugins.size,
        libraryDepDownloads: hasStoreMeta ? libraryDepDownloads : null,
        corpusDownloads: hasStoreMeta ? corpusDownloads : null,
        staleness: hasStoreMeta ? {
            dataDate: weekDate,
            corpus: stalenessCorpus,
            signals: STALENESS_SIGNALS.map(label => ({label, buckets: signalBuckets.get(label)!})),
            outreach: outreach.sort((a, b) => b.downloads - a.downloads),
            abandonedDeprecated: {...abandonedDeprecated, names: abandonedDeprecated.names.sort()},
            observer: observerBuckets,
            newcomers
        } : null,
        rawStyle: {rawAddons: rawStyleAddons, apiAddons: apiPlugins.get("BdApi.DOM.addStyle") ?? 0},
        hosts,
        sinks: Object.entries(injection).map(([name, count]) => ({name, count, plugins: sinkPlugins.get(name) ?? 0})).sort((a, b) => b.count - a.count),
        dynamicCode: [
            ...Object.entries(dynamic).map(([name, count]) => ({name, count, plugins: dynamicPlugins.get(name) ?? 0})),
            ...(scriptElementUses ? [{name: "createElement(\"script\")", count: scriptElementUses, plugins: rawScriptAddons}] : []),
        ].sort((a, b) => b.count - a.count),
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
// neutral (more plugins is not "good", so "none"), a dropping require count is the campaign
// working ("down") — and rising resilient-selector adoption is the one "up" KPI. Nothing is
// ever coloured red — this report is not a scoreboard.
function deltaLine(current: number, previous: number | undefined, since: string | undefined, goodDirection: "down" | "up" | "none", fallback = "", format: (n: number) => string = fmt): string {
    if (previous === undefined || since === undefined) return fallback ? `<div class="delta">${fallback}</div>` : "";
    const change = current - previous;
    if (change === 0) return `<div class="delta">no change since ${since}</div>`;
    const good = (goodDirection === "down" && change < 0) || (goodDirection === "up" && change > 0);
    return `<div class="delta${good ? " good" : ""}">${change > 0 ? "+" : "&minus;"}${format(Math.abs(change))} since ${since}</div>`;
}

// Tile sparkline: trend in the de-emphasis hue, the current value as an accent end-dot
// with a surface ring. Skipped for all-zero series — a flat floor line is noise, not trend.
function spark(values: number[] | undefined): string {
    if (!values || values.length < 3 || Math.max(...values) === 0) return "";
    // A KPI added after a snapshot was written is absent from it, which would otherwise put
    // NaN into the polyline and silently break the curve. No series until every point is real.
    if (values.some(v => !Number.isFinite(v))) return "";
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

// Addons ranked by hardcoded-class count, worst first. Split by type into its own column, so the
// per-column bar scale is independent (themes dwarf plugins) and the type chip is dropped as
// redundant — the column header carries it.
function fragileTable(rows: ReportData["fragile"], firstCol = "Addon", visible = 15): string {
    if (!rows.length) return `<p class="muted">none found</p>`;
    const max = rows[0]?.tokens ?? 0;
    // per KB alongside raw: raw ranks total blast radius (kept as the sort key and the bar), the
    // normalized column shows how riddled a given addon is regardless of its size.
    const row = (r: ReportData["fragile"][number]) =>
        `<tr><td>${escapeHtml(r.name)}</td><td class="bar-cell">${bar(r.tokens, max)}</td><td class="num">${fmt(r.tokens)}</td><td class="num muted">${r.perKb.toFixed(1)}</td></tr>`;
    const head = `<table><thead><tr><th>${escapeHtml(firstCol)}</th><th></th><th class="num">Hardcoded classes</th><th class="num">per KB</th></tr></thead><tbody>`;
    const rest = rows.slice(visible);
    const tail = rest.length
        ? `</tbody></table><details><summary>Show ${rest.length} more</summary><table><tbody>${rest.map(row).join("")}</tbody></table></details>`
        : "</tbody></table>";
    return head + rows.slice(0, visible).map(row).join("") + tail;
}

// CSS-variable names ranked by how many addons touch them, most-shared first
function cssVarTable(rows: Array<{name: string, addons: number}>, visible = 15): string {
    if (!rows.length) return `<p class="muted">none found</p>`;
    const max = rows[0]?.addons ?? 0;
    const row = (r: {name: string, addons: number}) =>
        `<tr><td><code>${escapeHtml(r.name)}</code></td><td class="bar-cell">${bar(r.addons, max)}</td><td class="num">${fmt(r.addons)}</td></tr>`;
    const head = `<table><thead><tr><th>Variable</th><th></th><th class="num">Addons</th></tr></thead><tbody>`;
    const rest = rows.slice(visible);
    const tail = rest.length
        ? `</tbody></table><details><summary>Show ${rest.length} more</summary><table><tbody>${rest.map(row).join("")}</tbody></table></details>`
        : "</tbody></table>";
    return head + rows.slice(0, visible).map(row).join("") + tail;
}

// ---- staleness × fragility (handoff-08 B3) ---------------------------------

function bucketCell(b: StaleBucket): string {
    return `<td class="num">${fmt(b.addons)} <span class="muted">&middot; ${humanCount(b.downloads)}</span></td>`;
}

// Actively-maintained addons still on a deprecated surface, ranked by installed base — the
// one table where downloads IS the sort key: it exists to order outreach by leverage.
function outreachTable(rows: NonNullable<ReportData["staleness"]>["outreach"], visible = 15): string {
    if (!rows.length) return `<p class="muted">&#10003; no actively-maintained addon touches a deprecated surface</p>`;
    const max = rows[0]?.downloads ?? 0;
    const row = (r: (typeof rows)[number]) =>
        `<tr><td>${escapeHtml(r.name)}</td><td class="bar-cell">${bar(r.downloads, max)}</td><td class="num">${humanCount(r.downloads)}</td><td class="num muted">${escapeHtml(r.lastRelease)}</td><td>${r.surfaces.map(s => `<span class="chip">${escapeHtml(s)}</span>`).join("")}</td></tr>`;
    const head = `<table><thead><tr><th>Addon</th><th></th><th class="num">Downloads</th><th class="num">Last release</th><th>Surface</th></tr></thead><tbody>`;
    const rest = rows.slice(visible);
    const tail = rest.length
        ? `</tbody></table><details><summary>Show ${rest.length} more</summary><table><tbody>${rest.map(row).join("")}</tbody></table></details>`
        : "</tbody></table>";
    return head + rows.slice(0, visible).map(row).join("") + tail;
}

function stalenessCard(s: ReportData["staleness"]): string {
    if (!s) return ""; // no store metadata this run — skip the card rather than render empty buckets
    const observerTotal = s.observer.active + s.observer.aging + s.observer.abandoned;
    return `<div class="card">
    <h2>Maintenance state &times; fragility &mdash; will the affected addons adapt?</h2>
    <p class="note">Every removal decision above hinges on the same follow-up: do the affected addons still ship releases, or will they simply break? Addons bucket by last <em>store release</em> relative to the ${escapeHtml(s.dataDate)} data week: <strong>active</strong> &le; 6 months, <strong>aging</strong> 6&ndash;24 months, <strong>abandoned</strong> &gt; 24 months. A release date measures store activity, not author intent &mdash; a stable, finished addon looks abandoned here &mdash; so staleness is never treated as a defect on its own; the readings below are conjunctions with a fragile or deprecated surface. Cells read <em>addons &middot; cumulative downloads</em> (installed base, never active users).</p>
    <table><thead><tr><th>Signal</th><th class="num">Active &le; 6mo</th><th class="num">Aging 6&ndash;24mo</th><th class="num">Abandoned &gt; 24mo</th></tr></thead><tbody>
    <tr><td><strong>Whole corpus</strong></td>${bucketCell(s.corpus.active)}${bucketCell(s.corpus.aging)}${bucketCell(s.corpus.abandoned)}</tr>
    ${s.signals.map(sig => `<tr><td>${escapeHtml(sig.label)}</td>${bucketCell(sig.buckets.active)}${bucketCell(sig.buckets.aging)}${bucketCell(sig.buckets.abandoned)}</tr>`).join("")}
    </tbody></table>
    ${observerTotal ? `<p class="note"><strong>The <code>observer</code> memo sharpens:</strong> of the ${fmt(observerTotal)} plugins keeping core's document-wide MutationObserver alive, ${fmt(s.observer.abandoned)} ${s.observer.abandoned === 1 ? "is" : "are"} abandoned and ${fmt(s.observer.active)} active${s.observer.active === 0 ? " &mdash; the cost every user pays on every DOM change serves only plugins that will never update and never complain" : ""}.</p>` : ""}
    <p class="note">Of the ${fmt(s.newcomers.total)} addons first released within 12 months of the data date, ${fmt(s.newcomers.deprecated)} launched already touching a deprecated surface${s.newcomers.deprecated === 0 ? " &mdash; new addons are being written against the current surface, which is the ecosystem learning" : " &mdash; deprecated patterns are still being adopted, not merely inherited"}.</p>
    <div class="cols">
        <div>
            <h2>Outreach shortlist <span class="chip">active &and; deprecated surface</span></h2>
            <p class="note">Actively-maintained addons still on a deprecated surface: authors who plausibly respond, ranked by the installed base their fix would carry.</p>
            ${outreachTable(s.outreach)}
        </div>
        <div>
            <h2>Already silently degraded <span class="chip">abandoned &and; deprecated surface</span></h2>
            <p class="note"><strong>${fmt(s.abandonedDeprecated.addons)}</strong> addons (${humanCount(s.abandonedDeprecated.downloads)} cumulative downloads) have not shipped in over two years <em>and</em> sit on a surface that already resolves to nothing. Their styling or overrides are degraded for every current install today; removing the surface costs them nothing further.</p>
            ${s.abandonedDeprecated.names.length ? `<details><summary>Show all ${fmt(s.abandonedDeprecated.addons)}</summary><ul>${s.abandonedDeprecated.names.map(n => `<li>${escapeHtml(n)}</li>`).join("")}</ul></details>` : `<p class="muted">none found</p>`}
        </div>
    </div>
</div>`;
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

// Unused members grouped by the namespace they'd be removed from, biggest group first
function removalTable(rows: ReportData["removals"]): string {
    if (!rows.length) return `<p class="muted">&#10003; every declared member is called by at least one addon</p>`;
    const max = rows[0]?.members.length ?? 0;
    const row = (r: ReportData["removals"][number]) =>
        `<tr><td><code>BdApi.${escapeHtml(r.namespace)}</code></td>
        <td>${r.members.map(m => `<span class="chip">${escapeHtml(m.name)}${m.deprecated ? " &middot; deprecated" : ""}</span>`).join("")}</td>
        <td class="bar-cell">${bar(r.members.length, max)}</td><td class="num">${fmt(r.members.length)}</td></tr>`;
    return `<table><thead><tr><th>Namespace</th><th>Members nothing calls</th><th></th><th class="num">Count</th></tr></thead><tbody>${rows.map(row).join("")}</tbody></table>`;
}

function phantomTable(rows: ReportData["phantoms"]): string {
    if (!rows.length) return `<p class="muted">&#10003; no addon calls a BdApi member that does not exist</p>`;
    return `<table><thead><tr><th>Called path</th><th class="num">Calls</th><th class="num">Plugins</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td><code>${escapeHtml(r.path)}</code></td><td class="num">${fmt(r.calls)}</td><td class="num muted">${fmt(r.plugins.length)}</td></tr>
    <tr><td colspan="3"><details><summary>Which plugins</summary><ul>${r.plugins.map(p => `<li>${escapeHtml(p)}</li>`).join("")}</ul></details></td></tr>`).join("")}
    </tbody></table>`;
}

const LIFECYCLE_CHIPS: Record<string, string> = {
    deprecated: "deprecated",
    candidate: "removal candidate",
    current: "current"
};

function lifecycleTable(rows: ReportData["lifecycle"]): string {
    if (!rows.length) return `<p class="muted">none found</p>`;
    const max = rows.reduce((a, r) => Math.max(a, r.plugins), 0);
    const row = (r: ReportData["lifecycle"][number]) =>
        `<tr><td><code>${escapeHtml(r.member)}</code></td><td><span class="chip">${LIFECYCLE_CHIPS[r.status]}</span></td><td class="bar-cell">${bar(r.plugins, max)}</td><td class="num">${fmt(r.plugins)}</td>${dlCell(r.downloads)}</tr>`;
    return `<table><thead><tr><th>Member</th><th>Status</th><th></th><th class="num">Plugins defining it</th><th class="num">Downloads</th></tr></thead><tbody>${rows.map(row).join("")}</tbody></table>`;
}

function render(d: ReportData): string {
    const k = d.kpis;
    const series = d.kpiSeries;
    const p = d.previous?.kpis;
    const since = d.previous?.dataDate;

    // The previous snapshot predates the remote-CSS methodology, so its class-literals-based
    // fragileAddons is not comparable — suppress that one tile's delta and sparkline (a fake jump
    // read as a regression otherwise) while every other KPI compares normally. See METHODOLOGY.
    const methodologyBreak = d.previous ? (d.previous.methodology ?? 1) !== METHODOLOGY : false;
    const fragilePrev = methodologyBreak ? undefined : p?.fragileAddons;
    const fragileSeries = methodologyBreak ? undefined : series?.fragileAddons;

    const prevRequires = asRecord(d.previous?.summary.requires);

    // @updateUrl convention size for the meta-card caption — live from the field coverage data
    // (the two case-variant strays, updateurl/updateURL, are left out of the convention count)
    const updateUrlAddons = d.metaFields.find(f => f.field === "updateUrl")?.addons ?? 0;
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
    <div class="tile"><div class="label">Plugins analyzed</div><div class="value">${fmt(k.plugins)}</div>${deltaLine(k.plugins, p?.plugins, since, "none")}${spark(series?.plugins)}</div>
    <div class="tile"><div class="label">Themes analyzed</div><div class="value">${fmt(k.themes)}</div>${deltaLine(k.themes, p?.themes, since, "none")}${spark(series?.themes)}</div>
    <div class="tile"><div class="label">Authors</div><div class="value">${fmt(k.authors)}</div>${deltaLine(k.authors, p?.authors, since, "none")}${spark(series?.authors)}</div>
    <div class="tile"><div class="label">Corpus size</div><div class="value">${humanBytes(k.corpusBytes)}</div>${deltaLine(k.corpusBytes, p?.corpusBytes, since, "none", "total store source", humanBytes)}${spark(series?.corpusBytes)}</div>
    <div class="tile"><div class="label">Cumulative downloads</div><div class="value">${humanCount(k.corpusDownloads)}</div>${deltaLine(k.corpusDownloads, p?.corpusDownloads, since, "none", "lifetime store downloads", humanCount)}${spark(series?.corpusDownloads)}</div>
    <div class="tile"><div class="label">Deprecated-surface downloads</div><div class="value">${humanCount(k.deprecatedSurfaceDownloads)}</div>${deltaLine(k.deprecatedSurfaceDownloads, p?.deprecatedSurfaceDownloads, since, "down", "installs on removed surfaces", humanCount)}${spark(series?.deprecatedSurfaceDownloads)}</div>
    <div class="tile"><div class="label">Abandoned share</div><div class="value">${k.abandonedShare.toFixed(1)}%</div>${deltaLine(k.abandonedShare, p?.abandonedShare, since, "none", "no release in over 2 years", n => `${n.toFixed(1)}pp`)}${spark(series?.abandonedShare)}</div>
    <div class="tile"><div class="label">Parse errors</div><div class="value">${fmt(k.parseErrors)}</div><div class="delta${k.parseErrors === 0 ? " good" : ""}">${k.parseErrors === 0 ? "&#10003; full AST coverage" : "plugins skipped"}</div>${spark(series?.parseErrors)}</div>
    <div class="tile"><div class="label">Legacy API uses</div><div class="value">${fmt(k.deprecatedUses)}</div><div class="delta${k.deprecatedUses === 0 ? " good" : ""}">${k.deprecatedUses === 0 ? "&#10003; old-old APIs are gone" : "see bdapi table"}</div>${spark(series?.deprecatedUses)}</div>
    <div class="tile"><div class="label">Uncalled API members</div><div class="value">${fmt(k.unusedApis)}</div>${deltaLine(k.unusedApis, p?.unusedApis, since, "down", `of ${fmt(d.declaredApis)} BdApi declares`)}${spark(series?.unusedApis)}</div>
    <div class="tile"><div class="label">Using require()</div><div class="value">${fmt(k.requirePlugins)}</div>${deltaLine(k.requirePlugins, p?.requirePlugins, since, "down", "plugins on the polyfill")}${spark(series?.requirePlugins)}</div>
    <div class="tile"><div class="label">Bundled / packed code</div><div class="value">${fmt(k.flagged)}</div>${deltaLine(k.flagged, p?.flagged, since, "down", "plugins, by heuristic")}${spark(series?.flagged)}</div>
    <div class="tile"><div class="label">Hardcoding classes</div><div class="value">${fmt(k.fragileAddons)}</div>${deltaLine(k.fragileAddons, fragilePrev, since, "down", methodologyBreak ? "remote CSS now measured" : "addons breaking on class churn")}${spark(fragileSeries)}</div>
    <div class="tile"><div class="label">Resilient selectors</div><div class="value">${fmt(k.resilientSelectorAddons)}</div>${deltaLine(k.resilientSelectorAddons, p?.resilientSelectorAddons, since, "up", "addons on substring selectors")}${spark(series?.resilientSelectorAddons)}</div>
    <div class="tile"><div class="label">Malformed meta</div><div class="value">${fmt(k.metaProblemAddons)}</div>${deltaLine(k.metaProblemAddons, p?.metaProblemAddons, since, "down", "addons with meta problems")}${spark(series?.metaProblemAddons)}</div>
    <div class="tile"><div class="label">Self-installing</div><div class="value">${fmt(k.selfUpdating)}</div>${deltaLine(k.selfUpdating, p?.selfUpdating, since, "down", "plugins writing plugin files")}${spark(series?.selfUpdating)}</div>
</div>

<div class="card">
    <h2>require() usage — polyfill retirement list</h2>
    <p class="note">BetterDiscord has no real <code>require</code>; these modules are served by the polyfill. Each list names the plugins to migrate before it can be removed. Plugins also reach the same environment without <code>require</code> &mdash; see Environment coupling below. <strong>Downloads</strong> is the combined <em>cumulative lifetime</em> store downloads of the plugins listed &mdash; the installed-base weight of each migration, not active users.</p>
    <table><thead><tr><th>Module</th><th></th><th class="num">Plugins</th><th class="num">Downloads</th><th class="num">Calls</th><th class="num">&Delta; calls</th></tr></thead><tbody>
    ${d.requires.map(r => `<tr><td><code>require("${escapeHtml(r.module)}")</code></td><td class="bar-cell">${bar(r.plugins.length, d.requires[0]?.plugins.length ?? 0)}</td><td class="num">${fmt(r.plugins.length)}</td>${dlCell(r.downloads)}<td class="num muted">${fmt(r.calls)}</td>${deltaCell(r.calls, prevRequires[r.module], true)}</tr>
    <tr><td colspan="6" style="border-bottom:1px solid var(--hairline)"><details><summary>Plugins requiring <code>${escapeHtml(r.module)}</code></summary><ul>${r.plugins.map(name => `<li>${escapeHtml(name)}</li>`).join("")}</ul></details></td></tr>`).join("")}
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
    <h2 style="margin-top:20px">Style injection &mdash; API vs hand-rolled <span class="chip">API winning</span></h2>
    <p class="note">The same question <code>createRoot</code> answers for React, for stylesheets: are plugins using the API BD offers, or doing it by hand? <code>BdApi.DOM.addStyle</code> injects a managed <code>&lt;style&gt;</code> that BD removes on unload; a hand-rolled <code>document.createElement("style")</code> is the plugin's own to clean up. Here the API is ahead &mdash; the healthy direction. (React's virtual <code>createElement("style")</code> is not counted; only a real DOM node is.)</p>
    <table><thead><tr><th>Approach</th><th></th><th class="num">Plugins</th></tr></thead><tbody>
    <tr><td><code>BdApi.DOM.addStyle</code> <span class="chip">API</span></td><td class="bar-cell">${bar(d.rawStyle.apiAddons, Math.max(d.rawStyle.apiAddons, d.rawStyle.rawAddons))}</td><td class="num">${fmt(d.rawStyle.apiAddons)}</td></tr>
    <tr><td><code>document.createElement("style")</code> <span class="chip">hand-rolled</span></td><td class="bar-cell">${bar(d.rawStyle.rawAddons, Math.max(d.rawStyle.apiAddons, d.rawStyle.rawAddons))}</td><td class="num">${fmt(d.rawStyle.rawAddons)}</td></tr>
    </tbody></table>
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
    <h2>Removal shortlist &mdash; ${fmt(d.unusedApis)} of ${fmt(d.declaredApis)} declared members go uncalled</h2>
    <p class="note">The usage table above measures how big a change's blast radius is; this one asks whether there is any blast radius at all. BdApi's declared surface comes from a manifest generated from BetterDiscord core (<strong>v${escapeHtml(surface.source.version)}</strong>, commit <code>${escapeHtml(surface.source.commit)}</code>, read ${escapeHtml(surface.source.generated)}) by <code>scripts/surface.ts</code>, and is diffed against what the corpus actually calls. Members are the names addons type, not the classes behind them &mdash; <code>AddonAPI</code> is exposed twice, as <code>BdApi.Plugins</code> and <code>BdApi.Themes</code>, and both are counted. Names outside BD's own classes (<code>BdApi.React</code>, <code>BdApi.ReactDOM</code>) are opaque and never judged here; their members are Discord's.</p>
    ${removalTable(d.removals)}
    <p class="note">Uncalled in the <em>store corpus</em> only &mdash; plugins outside the store, and the private plugins every user writes, are not visible to this analysis. Read it as "no store addon would notice", not "nothing would break". Two known blind spots keep this list honest: plugins built on BDFDB or ZeresPluginLibrary route calls through the library${d.opaqueChains.length ? `, and ${d.opaqueChains.map(c => `<code>${escapeHtml(c)}</code>`).join(", ")} ${d.opaqueChains.length === 1 ? "computes its member name at runtime, so no member of that namespace can be credited from it" : "compute their member names at runtime, so no member of those namespaces can be credited from them"}` : ""}.</p>

    <h2 style="margin-top:20px">Calls to members that do not exist</h2>
    <p class="note">The other direction: chains the corpus calls that BD core does not declare. This replaces a hand-maintained list, which could only ever drift out of sync with core.</p>
    ${phantomTable(d.phantoms)}
    <p class="note"><strong>This is dead code, not live breakage.</strong> All of it is one library &mdash; <code>DevilBro/0BDFDB</code> &mdash; and every call sits behind a feature-detection guard (<code>typeof BdApi.enableSetting == "function"</code>, or an is-array check for <code>BdApi.settings</code>), so the code path is simply never taken. Nothing is broken today and removing these names from core would change nothing. A headline of the form "N plugins call a removed API" would be wrong.</p>
</div>

<div class="card">
    <h2>Plugin shape &mdash; the v1 lifecycle BD still honors</h2>
    <p class="note">What plugins define, counted at definition sites via the AST rather than by name: <code>grep -l getName</code> finds 66 plugins, but 11 of those are <code>.getName()</code> <em>calls</em> on Discord modules, which are not plugin lifecycle at all. A plugin that defines a member on a nested helper class as well as on itself is counted once. <strong>Downloads</strong> weighs each member by the <em>cumulative lifetime</em> store downloads of its defining plugins &mdash; the installed base a removal would touch, not active users.</p>
    ${lifecycleTable(d.lifecycle)}
    <p class="note"><strong><code>observer</code> is the one to act on.</strong> To serve the ${fmt(d.lifecycle.find(r => r.member === "observer")?.plugins ?? 0)} plugins that define it, core constructs a document-wide <code>MutationObserver</code> (<code>observe(document, {childList: true, subtree: true})</code>) and dispatches every mutation to every loaded plugin &mdash; a cost every user pays on every DOM change, whether or not they run any of those ${fmt(d.lifecycle.find(r => r.member === "observer")?.plugins ?? 0)}. <code>observer</code>, <code>onSwitch</code> and <code>load</code> are marked <em>removal candidates</em>, not deprecated: BD has not deprecated them, and this report is not the place to announce that it has. (<code>load</code> is redundant &mdash; a plugin's code already runs at require/eval time and in its constructor, so anything it does can move there &mdash; but many plugins never migrated.) The <code>get</code>-family is genuinely deprecated &mdash; the meta block supersedes it, and core only consults these overrides if the instance defines them.</p>
</div>

<div class="card">
    <h2>Discord internals reliance</h2>
    <p class="note">What the ecosystem pulls out of Discord's webpack (module keys, exported strings, prototype keys, stores, display names) and which methods it patches. This is the surface that breaks on Discord updates &mdash; the highest-demand entries are candidates for a stable <code>CommonModules</code> offering.</p>
    <p class="note"><strong>These are floors, not totals.</strong> <strong>${fmt(d.libraryDepTotal)}</strong> of ${fmt(k.plugins)} plugins reach Discord through a library object rather than <code>BdApi</code> directly (${d.libraryDeps.map(l => `${escapeHtml(l.library)} ${fmt(l.plugins)}${l.downloads !== null ? ` &middot; ${humanCount(l.downloads)} downloads` : ""}`).join(", ")}) &mdash; their webpack lookups and patches are attributed to the library, so they are invisible to the tables below.${d.libraryDepDownloads !== null && d.corpusDownloads ? ` In installed-base terms the blind spot is <strong>${humanCount(d.libraryDepDownloads)}</strong> of the corpus's ${humanCount(d.corpusDownloads)} cumulative downloads &mdash; ${((d.libraryDepDownloads / d.corpusDownloads) * 100).toFixed(0)}% of every copy ever installed routes its Discord access through a library these tables cannot see into.` : ""} Detection is a runtime read of the library global, not a string mention: the four ex-dependents whose changelogs still say "no longer relies on ZeresPluginLibrary" are correctly excluded. Both libraries are unmaintained &mdash; ZeresPluginLibrary was deprecated over a year ago &mdash; so every dependent is also a plugin that will need rewriting when the library finally breaks.</p>
    <div class="cols">
        <div><h2>Webpack lookup targets</h2>${targetTable(d.webpackTargets.map(t => ({label: t.value, chip: t.kind, calls: t.calls, plugins: t.plugins})), "Target")}</div>
        <div><h2>Patched methods</h2>${targetTable(d.patcherTargets.map(t => ({label: t.method, calls: t.calls, plugins: t.plugins})), "Method")}</div>
    </div>
</div>

<div class="card">
    <h2>Hardcoded Discord class names</h2>
    <p class="note">Discord ships hashed CSS classes in two styles &mdash; <code>wrapper_a1b2c3</code> and <code>name__2ea32</code> &mdash; and rehashes them on class churn. Every token counted here is a selector that silently stops matching when that happens; the fix is a class-module lookup such as <code>BdApi.Webpack.getByKeys(&hellip;)</code>. Counts are occurrences, not distinct classes: a vendored class-name map inflates a single addon fast.</p>
    <p class="note"><strong>Remote CSS is now counted.</strong> Most themes are a thin <code>@import</code> wrapper whose real CSS lives on a host like <code>*.github.io</code>; that content is fetched, cached, and analysed here, attributed to the importing theme &mdash; so shared remote CSS imported by N themes counts under each of the N. This lands a one-time jump in these totals versus older snapshots: a measurement change, not the ecosystem regressing, which is why the tile's delta is neutralised for this data date.</p>
    <p class="note">The two columns read differently: <strong>Hardcoded classes</strong> is raw occurrences &mdash; the total blast radius, and the ranking key &mdash; while <strong>per KB</strong> normalizes against analyzed size (store file plus the theme's remote CSS, the same content the tokens were counted over) to show how riddled an addon is regardless of how big it is. A small theme with a handful of hardcoded classes can be denser per KB than a large one that merely vendors a whole class map.</p>
    <p class="note"><strong>The resilient counterpart within selectors:</strong> <strong>${fmt(d.resilient.themes)}</strong> themes and <strong>${fmt(d.resilient.plugins)}</strong> plugins instead target classes by stable prefix &mdash; attribute-substring selectors (<code>[class*="wrapper_"]</code>, <code>[class^=</code>; ${fmt(d.resilient.selectors)} selectors in all) that match the name and ignore the hash, so they survive rehashing. Counted over the same content as the tables above: store file plus remote <code>@import</code> CSS attributed per importing theme, and for plugins string literals only (embedded CSS and <code>querySelector</code> arguments), never raw JS text. The other class-attribute operators (<code>$=</code>, <code>~=</code>, <code>|=</code>) are deliberately excluded &mdash; in this corpus they are code-block language matching (<code>[class$="python" i]</code>), not churn resilience.</p>
    <div class="cols">
        <div><h2>Themes</h2>${fragileTable(d.fragile.filter(f => f.type === "theme"), "Theme")}</div>
        <div><h2>Plugins</h2>${fragileTable(d.fragile.filter(f => f.type === "plugin"), "Plugin")}</div>
    </div>
</div>

<div class="card">
    <h2>CSS custom properties &mdash; the resilient counterpart</h2>
    <p class="note">The healthy inverse of hardcoded classes. A theme built on Discord's CSS variables (<code>var(--background-base-low)</code>) rides out class churn; one built on <code>.wrapper_a1b2c3</code> does not. <strong>${fmt(d.cssVars.consumeDiscordAddons)}</strong> addons consume at least one of Discord's ${fmt(discordVarCount)} live variables; <strong>${fmt(d.cssVars.overlapAddons)}</strong> define (reskin) one of those names, and ${fmt(d.cssVars.defineAddons)} define custom properties at all (${fmt(d.cssVars.definitionNames)} distinct names &mdash; overwhelmingly their own palettes). Consumption and definition are measured from the corpus; the overlap column is diffed against a checked-in manifest of Discord's current variables${discordVarSource?.generated ? ` (captured ${escapeHtml(discordVarSource.generated)})` : ""}.</p>
    <div class="cols">
        <div>
            <h2>Consuming Discord variables <span class="chip">resilient</span></h2>
            <p class="note">Live Discord custom properties read via <code>var()</code>, by addon. These survive class-name rehashing.</p>
            ${cssVarTable(d.cssVars.topConsumed)}
        </div>
        <div>
            <h2>Reskinning Discord variables <span class="chip">overlap</span></h2>
            <p class="note">Addons that <em>define</em> a name Discord also ships &mdash; the mechanism themes use to retheme Discord, and the thing that breaks silently when Discord renames or drops the variable.</p>
            ${cssVarTable(d.cssVars.topOverlap)}
        </div>
    </div>
    <p class="note">Overlap is against Discord's <em>current</em> variables, so it measures live reskins. Using a variable Discord has since <em>renamed or removed</em> (<code>--text-normal</code> &rarr; <code>--text-default</code>) is the separate fragility signal below.</p>
    <h2 style="margin-top:20px">Outdated variables <span class="chip">breaks silently</span></h2>
    <p class="note">The CSS-variable analog of a stale hardcoded class. <strong>${fmt(d.cssVars.outdatedAddons)}</strong> addons still define or read a name from Discord's former semantic layer (<code>--background-primary</code>, <code>--text-normal</code>, <code>--interactive-normal</code>, the <code>--brand-experiment-*</code> scale&hellip;) &mdash; each now resolves to nothing, so the styling is dead. Matched against the manifest's <code>deprecated</code> list of Discord's removed names, never inferred from the corpus.</p>
    ${cssVarTable(d.cssVars.topOutdated)}
</div>

${stalenessCard(d.staleness)}

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
    <p class="note">Every addon opens with a JSDoc meta block, parsed by BetterDiscord's <code>parseJsDoc</code>. This table is what BD itself sees: the same parser runs here, so a field listed as present is a field BD resolves. <code>@name</code>, <code>@author</code>, <code>@description</code> and <code>@version</code> are required; BD papers over the last three at load time with <code>Unknown Author</code> / <code>???</code> / <code>No description</code>, so a missing one degrades the UI rather than failing outright. Non-standard fields are author or library conventions BD ignores &mdash; they are listed for coverage, not judged. The largest such convention is <code>@updateUrl</code>: ${fmt(updateUrlAddons)} addons (${((updateUrlAddons / d.corpus) * 100).toFixed(0)}%) carry a field BD never reads &mdash; de-facto demand evidence for a first-party update mechanism. Nearly nothing fetches it today (a 2026-07 probe put the hosts at <code>mwittrien.github.io</code> 54, <code>raw.githubusercontent.com</code> 28, then singletons; the one remaining ZeresPluginLibrary dependent is the only self-rolled reader), so these URLs stay advisory and are deliberately excluded from the CSP host inventories.</p>
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

    <h2 style="margin-top:16px">Checked and absent</h2>
    <p class="note">Sinks probed across every plugin (2026-07) and found nowhere in the store corpus &mdash; a clean probe is a finding about store health, so it is cited rather than silently lacking a rule: <code>child_process</code> (no shell execution at all), string-argument <code>setTimeout</code>/<code>setInterval</code>, <code>document.write</code>, auth-token webpack lookups (<code>getToken</code>), dynamic <code>import()</code> of remote URLs, and hardcoded Discord REST paths (the three plugins matching <code>/api/vN</code> call third-party APIs &mdash; translation, game stores &mdash; and the lone <code>discord.com</code> network sink is an asset fetch). Raw <code>localStorage</code> appears in one plugin, on a dead code path.</p>
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
