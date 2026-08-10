import fs from "fs/promises";
import path from "path";
import ky, {HTTPError} from "ky";
import type {APIAddon} from "./types";
import {addonFolder, cacheFolder} from "./constants";


const addonCacheJson = path.join(cacheFolder, "addons.json");
const cacheMetaJson = path.join(cacheFolder, "meta.json");


// A source URL that could not be fetched. `kept` separates the harmless case — a copy from a
// previous run is still on disk, so the addon stays in the corpus with possibly stale content —
// from a real hole in the denominator: no copy at all, so the addon is absent from every count
// the report publishes. Only the second kind counts against the tolerance below.
export interface DownloadFailure {
    addon: string; // "<author dir>/<file_name>", the key results/addons.json and storeMetaKey use
    url: string;
    reason: string;
    kept: boolean;
}

interface Metadata {
    lastUpdated: string;
    count: number;

    // Absent on caches written before download failures were recorded; readers treat that as
    // "no known gaps", which is what a run that could not have had any would have written.
    failures?: DownloadFailure[];
}

// One store fetch can hang indefinitely without a timeout, and the corpus is ~323 sequential
// requests. Three attempts absorbs a blip without turning a real outage into a ten-minute job.
const REQUEST_TIMEOUT = 30000;
const ATTEMPTS = 3;
const RETRY_BACKOFF = 500;

// A store response this much smaller than the one already cached is an API fault, not the store
// losing a third of its addons overnight — see fetchStoreList.
const MIN_LIST_RATIO = 0.5;

// Corpus gaps tolerated before the run refuses to publish (maintainer's call, 2026-08): fail when
// missing exceeds *either* bound, i.e. the stricter of the two. A suspended GitHub account costs
// one addon per week rather than a month of no data at all, but a broad outage is a data failure
// a human must look at, not a report quietly measuring a corpus with a chunk taken out of it.
const MAX_MISSING = 5;
const MAX_MISSING_SHARE = 0.02;

async function exists(location: string) {
    try {
        await fs.access(location);
        return true;
    }
    catch {
        return false;
    }
}

async function readJson<T>(file: string): Promise<T | null> {
    try {
        return JSON.parse(await fs.readFile(file, "utf8")) as T;
    }
    catch {
        return null;
    }
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}

function describeError(error: unknown): string {
    if (error instanceof HTTPError) return `HTTP ${error.response.status} ${error.response.statusText}`.trim();
    return error instanceof Error ? error.message : String(error);
}

// Only transport-level faults are worth another attempt. A 4xx is an answer: the case that
// motivated all of this — a suspended GitHub account 404ing its raw URLs — will answer the same
// way a second later, so retrying only delays recording the gap that the next run picks up.
function isRetryable(error: unknown): boolean {
    if (error instanceof HTTPError) {
        const status = error.response.status;
        return status === 408 || status === 429 || status >= 500;
    }
    return true; // timeouts, DNS failures, socket resets, an HTML error page failing to parse
}

async function withRetry<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
        try {
            return await operation();
        }
        catch (error) {
            if (attempt >= ATTEMPTS || !isRetryable(error)) throw error;
            await delay(RETRY_BACKOFF * 2 ** (attempt - 1));
        }
    }
}

// GitHub Actions annotations, so a tolerated failure surfaces on the run summary instead of
// being buried in a 323-line download log. `error` here annotates without failing the job —
// the run only fails by throwing, in reportFailures.
function annotate(level: "warning" | "error", message: string): void {
    if (process.env.GITHUB_ACTIONS) console.log(`::${level} title=Corpus download::${message}`);
    else console.warn(`${level}: ${message}`);
}

// Monday (UTC) of the ISO week containing `date`, as YYYY-MM-DD — the corpus cadence key.
// CI pins .cache per ISO week (`date -u +%G-%V`, weeks start Monday, same as the cron);
// staleness here and snapshot naming in history.ts key on the same boundary, so every run
// within one week — local or CI, whatever weekday — analyzes one corpus under one dataDate.
// A rolling seven-day window is NOT equivalent: a cache from last Monday is 7 days old on
// Tuesday, so a mid-week local refresh stamped an off-cadence date and history/ grew a
// second snapshot for the week.
export function weekStart(date: Date): string {
    const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
    return day.toISOString().slice(0, 10);
}

// The on-disk author directory name: display_name stripped of filesystem-hostile characters.
// Also the join-key prefix storemeta.ts uses to attach store metadata to analyzed files —
// results/addons.json is keyed by these directory names, so the two must never drift.
export function authorDirName(displayName: string): string {
    return displayName.replace(/[/\\?%*:|"<>]/g, "");
}

function addonKey(addon: APIAddon): string {
    return `${authorDirName(addon.author.display_name)}/${addon.file_name}`;
}

export async function isInvalid() {
    if (!(await exists(cacheFolder))) return true;
    const metadata = await readJson<Metadata>(cacheMetaJson);
    if (!metadata) return true;
    const updated = new Date(metadata.lastUpdated);
    if (Number.isNaN(updated.getTime())) return true;
    if (weekStart(updated) !== weekStart(new Date())) return true;
    const cached = await readJson<APIAddon[]>(addonCacheJson);
    if (!cached || cached.length !== metadata.count) return true;
    return false;
}

// The corpus gap as of the last download pass, for the consumers that must state it rather than
// publish silently shrunken numbers (the report's data-quality note, the history snapshot).
// cache.ts owns what "incomplete" means; nothing else reads meta.json's failure list.
export async function readDownloadFailures(): Promise<DownloadFailure[]> {
    return (await readJson<Metadata>(cacheMetaJson))?.failures ?? [];
}


async function ensureDirs() {
    if (!(await exists(cacheFolder))) await fs.mkdir(cacheFolder);
    if (!(await exists(addonFolder))) await fs.mkdir(addonFolder);
}

async function writeMeta(metadata: Metadata) {
    await fs.writeFile(cacheMetaJson, JSON.stringify(metadata, null, 4));
}


const API_URL = "https://api.betterdiscord.app/v3/store/addons";

export async function update() {
    if (await isInvalid()) {
        await ensureDirs();
        await refresh();
        return;
    }
    await fillGaps();
}

// Full weekly refresh: pull the store list, then every addon source. Individual sources may fail
// (recorded, not thrown); the list itself may not — without it there is nothing to download and
// no honest way to tell a truncated response from a shrinking store.
async function refresh(): Promise<void> {
    const addons = await fetchStoreList();
    addons.sort((a, b) => a.author.display_name.localeCompare(b.author.display_name));
    await fs.writeFile(addonCacheJson, JSON.stringify(addons, null, 4));

    const failures: DownloadFailure[] = [];
    let author: string = "";
    for (const addon of addons) {
        if (addon.author.display_name !== author) {
            author = addon.author.display_name;
            console.log("");
            console.log(`Downloading addons by ${author}...`);
        }
        console.log(addon.file_name);
        const failure = await downloadAddon(addon);
        if (failure) failures.push(failure);
    }

    // Written before the tolerance check on purpose: a run that fails there has still done the
    // downloading, so a rerun can fill the gaps instead of re-fetching the whole corpus. CI never
    // sees that path — actions/cache does not save on a failed job — but a local rerun does.
    await writeMeta({lastUpdated: new Date().toISOString(), count: addons.length, failures});
    reportFailures(failures, addons.length);
}

// A corpus stays fresh for the whole ISO week, so an addon that failed to download on Monday
// would otherwise stay missing until the next Monday. Re-runs within the week retry exactly the
// files with no copy on disk — nothing else touches the network — and deliberately leave
// `lastUpdated` alone: bumping it moves the data week and mints a second history snapshot for
// one recovered addon.
async function fillGaps(): Promise<void> {
    const metadata = await readJson<Metadata>(cacheMetaJson);
    const gaps = metadata?.failures?.filter(entry => !entry.kept) ?? [];
    if (!metadata || !gaps.length) return;

    const addons = await readJson<APIAddon[]>(addonCacheJson);
    if (!addons) return;
    const byKey = new Map(addons.map(addon => [addonKey(addon), addon]));

    console.log(`Retrying ${gaps.length} addon(s) missing from the cached corpus...`);
    const failures = metadata.failures?.filter(entry => entry.kept) ?? [];
    for (const gap of gaps) {
        const addon = byKey.get(gap.addon);
        if (!addon) continue; // dropped from the store since the refresh — no longer a gap
        const failure = await downloadAddon(addon);
        if (failure) failures.push(failure);
        else console.log(`recovered ${gap.addon}`);
    }

    await writeMeta({...metadata, failures});
    reportFailures(failures, addons.length);
}

async function fetchStoreList(): Promise<APIAddon[]> {
    const addons = await withRetry(() => ky.get(API_URL, {timeout: REQUEST_TIMEOUT, retry: 0}).json<APIAddon[]>());
    if (!Array.isArray(addons) || !addons.length) throw new Error("store API returned no addons — refusing to overwrite the corpus");

    // The corpus is the denominator for every number this project publishes, and the trend
    // series it feeds is committed. Once a truncated response has overwritten addons.json it is
    // indistinguishable from the store actually losing addons, so it must abort the run instead.
    const previous = await readJson<APIAddon[]>(addonCacheJson);
    if (previous && Array.isArray(previous) && addons.length < previous.length * MIN_LIST_RATIO) {
        throw new Error(`store API returned ${addons.length} addons, down from ${previous.length} cached — refusing to overwrite the corpus`);
    }
    return addons;
}

// Returns null on success, or the failure to record. Never throws: one dead source URL must not
// cost the other 322 addons, the report, and the week's history snapshot.
async function downloadAddon(addon: APIAddon): Promise<DownloadFailure | null> {
    const authorPath = path.join(addonFolder, authorDirName(addon.author.display_name));
    const file = path.resolve(authorPath, addon.file_name);
    const sourceUrl = addon.latest_source_url;

    // A listing with no source URL is a store-data problem rather than a transport one, but it
    // lands in the same place — no file on disk — so it is recorded the same way.
    if (!sourceUrl) return {addon: addonKey(addon), url: "", reason: "no source URL in the store listing", kept: await exists(file)};

    const downloadUrl = sourceUrl.replace("github.com", "raw.githubusercontent.com").replace("blob/", "");
    try {
        const code = await withRetry(() => ky.get(downloadUrl, {timeout: REQUEST_TIMEOUT, retry: 0}).text());
        // An empty body is never a valid addon (BD requires a meta block) and writing it would
        // quietly erase a good cached copy, so it is treated as a failed fetch.
        if (!code.trim()) throw new Error("empty response body");
        await fs.mkdir(authorPath, {recursive: true});
        await fs.writeFile(file, code);
        return null;
    }
    catch (error) {
        return {addon: addonKey(addon), url: downloadUrl, reason: describeError(error), kept: await exists(file)};
    }
}

// Every failure is logged — a silent skip is the failure mode this whole path exists to prevent —
// and a corpus missing more than the tolerance stops being a measurement, so it throws.
function reportFailures(failures: DownloadFailure[], count: number): void {
    const missing = failures.filter(entry => !entry.kept);
    const kept = failures.length - missing.length;

    console.log("");
    console.log(`corpus: ${count - missing.length}/${count} store addons on disk${kept ? `, ${kept} kept from an earlier run after a failed refresh` : ""}`);
    for (const entry of failures) {
        const where = entry.url ? ` (${entry.url})` : "";
        annotate(entry.kept ? "warning" : "error", `${entry.kept ? "could not refresh" : "missing"} ${entry.addon}: ${entry.reason}${where}`);
    }

    if (!missing.length) return;
    const limit = Math.min(MAX_MISSING, Math.floor(count * MAX_MISSING_SHARE));
    if (missing.length > limit) {
        throw new Error(`${missing.length} of ${count} store addons could not be downloaded (tolerance ${limit}) — refusing to analyze a corpus this incomplete`);
    }
}
