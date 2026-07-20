import fs from "fs/promises";
import path from "path";
import {cacheFolder, historyFolder, resultsFolder} from "./constants";
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
}

export interface Snapshot {
    // Date of the addon data itself (cache lastUpdated), NOT the run date — re-running against
    // the same cache must overwrite its snapshot rather than fabricate a second data point.
    dataDate: string;
    generated: string;

    // Measurement-methodology version this snapshot was produced under (see METHODOLOGY). Absent on
    // snapshots written before the field existed; readers treat missing as 1.
    methodology?: number;

    kpis: Kpis;
    summary: SummaryJson;
}

function asRecord(value: Results | undefined): Record<string, number> {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function deriveKpis(addons: AddonsJson, summary: SummaryJson): Kpis {
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
        unusedApis: unusedPaths(Object.keys(asRecord(summary["bdapi-usage"]))).length
    };

    for (const author of Object.keys(addons)) {
        for (const [file, results] of Object.entries(addons[author])) {
            if (file.endsWith(".plugin.js")) kpis.plugins++;
            else kpis.themes++;

            if (Object.keys(asRecord(results.requires)).length) kpis.requirePlugins++;
            if (results["obfuscated-plugins"] === true) kpis.flagged++;
            if (typeof results["class-literals"] === "number" && results["class-literals"] > 0) kpis.fragileAddons++;
            if (Object.keys(asRecord(results["meta-problems"])).length) kpis.metaProblemAddons++;
            if (results["self-updating"] === true) kpis.selfUpdating++;
        }
    }

    return kpis;
}

async function readJson<T>(file: string): Promise<T> {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
}

export async function writeSnapshot(): Promise<Snapshot> {
    const summary = await readJson<SummaryJson>(path.join(resultsFolder, "summary.json"));
    const addons = await readJson<AddonsJson>(path.join(resultsFolder, "addons.json"));
    const meta = await readJson<{lastUpdated: string}>(path.join(cacheFolder, "meta.json"));

    const snapshot: Snapshot = {
        dataDate: meta.lastUpdated.slice(0, 10),
        generated: new Date().toISOString(),
        methodology: METHODOLOGY,
        kpis: deriveKpis(addons, summary),
        summary
    };

    await fs.mkdir(historyFolder, {recursive: true});
    const file = path.join(historyFolder, `${snapshot.dataDate}.json`);

    // An unchanged re-run must not dirty the file (or produce timestamp-only commits from CI):
    // when the data is identical, keep the existing snapshot and its original `generated`.
    try {
        const existing = JSON.parse(await fs.readFile(file, "utf8")) as Snapshot;
        if ((existing.methodology ?? 1) === snapshot.methodology
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
