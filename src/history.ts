import fs from "fs/promises";
import path from "path";
import {lifecycleStatus} from "./ast/rules/lifecycle";
import {readDownloadFailures, weekStart} from "./cache";
import {cacheFolder, historyFolder, resultsFolder} from "./constants";
import {loadStoreMeta, stalenessBucket, storeMetaKey, type StoreMetaMap} from "./storemeta";
import {unusedPaths} from "./surface";
import type {Results} from "./types";


export type AddonsJson = Record<string, Record<string, Record<string, Results>>>;
export type SummaryJson = Record<string, Results>;

// Bumped whenever a measurement change (not an ecosystem change) discontinuously shifts a KPI, so
// the report can neutralise the resulting delta instead of colouring it as a regression. History 2
// (2026-07): theme @import content is now analysed as first-class CSS, which jumps class-literals /
// css-urls hard for import-only themes. Snapshots predating this field are methodology 1.
export const METHODOLOGY = 2;

// KPIs whose value is not comparable across a methodology boundary. Only fragileAddons (class-literals
// based) moves with the remote-CSS change; corpus/plugin counts and plugin-only KPIs are unaffected.
export const METHODOLOGY_SENSITIVE: ReadonlyArray<keyof Kpis> = ["fragileAddons"];

// The report's headline numbers. Snapshots store them alongside summary.json because the
// interesting ones are per-addon counts ("how many plugins use require") that summary.json
// cannot express — it sums call counts, so 3 requires in 1 plugin and 1 each in 3 plugins are
// indistinguishable there. deriveKpis is the single definition, used both to write a snapshot
// and to compute the current values in report.ts, so a tile and its delta cannot disagree.
export interface Kpis {
    plugins: number;
    themes: number;
    authors: number;
    parseErrors: number;
    deprecatedUses: number;
    requirePlugins: number;
    flagged: number;
    fragileAddons: number;
    metaProblemAddons: number;
    selfUpdating: number;

    // Declared BdApi members no addon calls. Manifest-relative, so this moves when BD ships or
    // removes API as well as when the corpus adopts it — both are the point. Snapshots written
    // before this KPI existed simply lack it; the report falls back rather than inventing a delta.
    unusedApis: number;

    // Total store-file size of the corpus in bytes (handoff-07): the denominator that lets a
    // future snapshot tell corpus growth apart from behaviour change. Neutral context, never
    // coloured. Store files only (summed summary.size.bytes), so it excludes remote @import CSS.
    // Absent on snapshots predating this KPI; the report degrades rather than inventing a delta.
    corpusBytes: number;

    // Combined cumulative lifetime downloads of the analyzed corpus (handoff-08): the
    // installed-base denominator, as corpusBytes is the code-size one. Neutral context, never
    // coloured — but the snapshot-to-snapshot delta of this series is download *velocity*,
    // which is why it is recorded from day one. Absent on older snapshots; the report degrades.
    corpusDownloads: number;

    // Share (percent, one decimal) of addons whose latest store release is > 24 months before
    // the data date (storemeta.stalenessBucket). Context, not a defect count — a stable,
    // finished addon looks abandoned by this metric. Neutral ink. Absent on older snapshots.
    abandonedShare: number;

    // Combined downloads of addons touching >= 1 deprecated surface: a get-family lifecycle
    // member, an outdated (removed) Discord CSS variable, or an old-old deprecated BdApi
    // alias. The one download KPI with a direction — down means the migration campaigns are
    // working — so its delta may colour green. Absent on older snapshots; the report degrades.
    deprecatedSurfaceDownloads: number;

    // Addons using >= 1 attribute-substring class selector ([class*= / [class^=) — the
    // churn-resilient counterpart of fragileAddons, so its delta colours green when RISING
    // (adoption is the campaign working). Absent on older snapshots; the report degrades.
    resilientSelectorAddons: number;
}

export interface Snapshot {
    // Week of the addon data itself: the ISO-week Monday of the cache's lastUpdated, NOT the
    // run date — the series cadence is weekly, so any re-run within the same data week must
    // overwrite that week's snapshot rather than fabricate a second data point. The raw
    // download date is not preserved (an off-Monday date here only ever meant a mid-week
    // cache refresh, not different data worth a point of its own).
    dataDate: string;
    generated: string;

    // Measurement-methodology version this snapshot was produced under (see METHODOLOGY). Absent on
    // snapshots written before the field existed; readers treat missing as 1.
    methodology?: number;

    // Store addons that could not be downloaded for this data week and are therefore absent from
    // every number below (cache.ts records them; `kept` failures are excluded — a stale copy is
    // still counted). Absent on a complete corpus, which is the normal case. Recorded for the same
    // defensive reason as `methodology`: a dip caused by a download outage must stay traceable to
    // one instead of reading, years later, as an ecosystem change.
    missingAddons?: number;

    kpis: Kpis;
    summary: SummaryJson;
}

function asRecord(value: Results | undefined): Record<string, number> {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

// `store`/`dataDate` feed the download KPIs: the store metadata map (empty when the cache
// file is unreadable — the KPIs then read 0) and the ISO-week Monday the staleness buckets
// compare release dates against. Both callers pass the same values, so a tile and the
// snapshot it is compared against cannot disagree.
export function deriveKpis(addons: AddonsJson, summary: SummaryJson, store: StoreMetaMap, dataDate: string): Kpis {
    const kpis: Kpis = {
        plugins: 0,
        themes: 0,
        authors: Object.keys(addons).length,
        parseErrors: typeof summary["parse-errors"] === "number" ? summary["parse-errors"] : 0,
        deprecatedUses: Object.values(asRecord(summary["deprecated-apis"])).reduce((a, b) => a + b, 0),
        requirePlugins: 0,
        flagged: 0,
        fragileAddons: 0,
        metaProblemAddons: 0,
        selfUpdating: 0,
        unusedApis: unusedPaths(Object.keys(asRecord(summary["bdapi-usage"]))).length,
        corpusBytes: Number(asRecord(summary.size).bytes ?? 0),
        corpusDownloads: 0,
        abandonedShare: 0,
        deprecatedSurfaceDownloads: 0,
        resilientSelectorAddons: 0
    };

    let withMeta = 0;
    let abandoned = 0;

    for (const author of Object.keys(addons)) {
        for (const [file, results] of Object.entries(addons[author])) {
            if (file.endsWith(".plugin.js")) kpis.plugins++;
            else kpis.themes++;

            if (Object.keys(asRecord(results.requires)).length) kpis.requirePlugins++;
            if (results["obfuscated-plugins"] === true) kpis.flagged++;
            if (typeof results["class-literals"] === "number" && results["class-literals"] > 0) kpis.fragileAddons++;
            if (typeof results["substring-selectors"] === "number" && results["substring-selectors"] > 0) kpis.resilientSelectorAddons++;
            if (Object.keys(asRecord(results["meta-problems"])).length) kpis.metaProblemAddons++;
            if (results["self-updating"] === true) kpis.selfUpdating++;

            const storeEntry = store.get(storeMetaKey(author, file));
            if (!storeEntry) continue;
            withMeta++;
            kpis.corpusDownloads += storeEntry.downloads;
            if (stalenessBucket(storeEntry.latestRelease, dataDate) === "abandoned") abandoned++;

            // Same union the report's staleness card uses for "deprecated surface" — keep
            // the two in sync or the tile and the card will tell different stories
            const getFamily = Object.keys(asRecord(results.lifecycle)).some(m => lifecycleStatus(m) === "deprecated");
            const outdatedVars = Object.keys(asRecord(results["css-var-outdated"])).length > 0;
            const legacyAliases = Object.keys(asRecord(results["deprecated-apis"])).length > 0;
            if (getFamily || outdatedVars || legacyAliases) kpis.deprecatedSurfaceDownloads += storeEntry.downloads;
        }
    }

    // One decimal is display precision; rounding here (not at render) keeps the snapshot
    // JSON stable so an unchanged re-run still hits writeSnapshot's no-op guard
    kpis.abandonedShare = withMeta ? Math.round((abandoned / withMeta) * 1000) / 10 : 0;

    return kpis;
}

async function readJson<T>(file: string): Promise<T> {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
}

export async function writeSnapshot(): Promise<Snapshot> {
    const summary = await readJson<SummaryJson>(path.join(resultsFolder, "summary.json"));
    const addons = await readJson<AddonsJson>(path.join(resultsFolder, "addons.json"));
    const meta = await readJson<{lastUpdated: string}>(path.join(cacheFolder, "meta.json"));

    const dataDate = weekStart(new Date(meta.lastUpdated));
    const snapshot: Snapshot = {
        dataDate,
        generated: new Date().toISOString(),
        methodology: METHODOLOGY,
        kpis: deriveKpis(addons, summary, await loadStoreMeta(), dataDate),
        summary
    };

    // Only failures with no copy on disk shift the numbers; a kept stale copy is still analyzed
    const missingAddons = (await readDownloadFailures()).filter(entry => !entry.kept).length;
    if (missingAddons) snapshot.missingAddons = missingAddons;

    await fs.mkdir(historyFolder, {recursive: true});
    const file = path.join(historyFolder, `${snapshot.dataDate}.json`);

    // An unchanged re-run must not dirty the file (or produce timestamp-only commits from CI):
    // when the data is identical, keep the existing snapshot and its original `generated`.
    try {
        const existing = JSON.parse(await fs.readFile(file, "utf8")) as Snapshot;
        if ((existing.methodology ?? 1) === snapshot.methodology
            && (existing.missingAddons ?? 0) === missingAddons
            && JSON.stringify([existing.kpis, existing.summary]) === JSON.stringify([snapshot.kpis, snapshot.summary])) {
            return existing;
        }
    }
    catch {
        // no snapshot for this dataDate yet, or an unreadable one — write fresh either way
    }

    await fs.writeFile(file, JSON.stringify(snapshot, null, 4));
    return snapshot;
}

// Every snapshot on disk, oldest first. A missing folder is normal (first run, fresh checkout).
export async function readHistory(): Promise<Snapshot[]> {
    let files: string[];
    try {
        files = await fs.readdir(historyFolder);
    }
    catch {
        return [];
    }

    const snapshots: Snapshot[] = [];
    for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
            const snapshot = await readJson<Snapshot>(path.join(historyFolder, file));
            if (snapshot.dataDate && snapshot.kpis) snapshots.push(snapshot);
        }
        catch {
            continue; // a corrupt or hand-edited snapshot must not break the report
        }
    }

    return snapshots.sort((a, b) => a.dataDate.localeCompare(b.dataDate));
}
