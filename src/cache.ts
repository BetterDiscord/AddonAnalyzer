import fs from "fs/promises";
import path from "path";
import ky, {HTTPError} from "ky";
import type {APIAddon} from "./types";
import {addonFolder, cacheFolder} from "./constants";


const addonCacheJson = path.join(cacheFolder, "addons.json");
const cacheMetaJson = path.join(cacheFolder, "meta.json");


// A source URL that could not be fetched. Two flags carry the whole policy:
//
// `kept` separates the harmless case — a copy from a previous run is still on disk, so the addon
// stays in the corpus with possibly stale content — from a real hole in the denominator: no copy
// at all, so the addon is absent from every count the report publishes. Only the second kind
// counts against the tolerances below.
//
// `permanent` separates a source that is *gone* (404/410, or a listing with no URL at all) from a
// transport fault. Evidence for the split, 2026-08-10: ten addons across two authors 404'd because
// both authors' repositories were deleted outright — those URLs will 404 next week and the week
// after, so failing the run over them means never publishing again, while a burst of timeouts
// means this run's corpus is not representative and a re-run genuinely fixes it.
export interface DownloadFailure {
    addon: string; // "<author dir>/<file_name>", the key results/addons.json and storeMetaKey use
    url: string;
    reason: string;
    kept: boolean;
    permanent: boolean;
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

// Corpus gaps tolerated before the run refuses to publish (maintainer's call, 2026-08), per
// failure class and counting only addons with no copy on disk. Each pair fails when the count
// exceeds *either* bound, i.e. the stricter of the two.
//
// Permanent: generous, because failing changes nothing — a deleted repository answers 404 every
// week, so a strict bound here means the report simply stops publishing until the store delists
// the addon. The bound still exists to catch a mass-404 event (a CDN serving 404 for everything),
// which is a different thing wearing the same status code.
const MAX_GONE = 25;
const MAX_GONE_SHARE = 0.08;

// Transport: strict, because the corpus is only as good as the run that fetched it. A burst of
// timeouts means these numbers are an artifact of one bad ten minutes, and a re-run fixes it.
const MAX_UNREACHABLE = 5;
const MAX_UNREACHABLE_SHARE = 0.02;

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

// The source is gone rather than unreachable: 404 (deleted or renamed repo, force-pushed commit,
// suspended account) and 410. Deliberately NOT 403 — raw.githubusercontent answers 404 for private
// and deleted content, so a 403 there is rate limiting, which is a transport fault that clears.
function isPermanent(error: unknown): boolean {
    if (!(error instanceof HTTPError)) return false;
    return error.response.status === 404 || error.response.status === 410;
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

    await pruneOrphans(addons);

    // Written before the tolerance check on purpose: a run that fails there has still done the
    // downloading, so a rerun can fill the gaps instead of re-fetching the whole corpus. CI never
    // sees that path — actions/cache does not save on a failed job — but a local rerun does.
    await writeMeta({lastUpdated: new Date().toISOString(), count: addons.length, failures});
    reportFailures(failures, addons.length);
}

// Delete corpus files the store no longer lists. Without this an addon delisted mid-week is
// analyzed forever: nothing else ever removes a file, and CI now restores the previous week's
// corpus rather than starting empty, so it is no longer immune the way a from-scratch download was.
//
// Only ever called from refresh(), i.e. only after fetchStoreList() has vetted the response. That
// gating is the whole safety story — a truncated store payload reaching this function is a mass
// delete. Files that merely failed to download are still *listed*, so they are never orphans.
async function pruneOrphans(addons: APIAddon[]): Promise<void> {
    const listed = new Set(addons.map(addonKey));
    let removed = 0;

    for (const author of await fs.readdir(addonFolder)) {
        const authorPath = path.join(addonFolder, author);
        if (!(await fs.stat(authorPath)).isDirectory()) continue;

        const entries = await fs.readdir(authorPath);
        for (const entry of entries) {
            // Anything that is not an addon file was not put here by this pipeline — leave it alone
            if (!entry.endsWith(".plugin.js") && !entry.endsWith(".theme.css")) continue;
            if (listed.has(`${author}/${entry}`)) continue;
            await fs.rm(path.join(authorPath, entry));
            console.log(`pruned ${author}/${entry} (no longer in the store)`);
            removed++;
        }

        // An author whose every addon was delisted must lose the directory too: analyze() keys
        // results by directory, so an empty one becomes an author with no addons and inflates the
        // author count.
        if (!(await fs.readdir(authorPath)).length) {
            await fs.rmdir(authorPath);
            console.log(`pruned empty author folder ${author}`);
        }
    }

    if (removed) console.log(`pruned ${removed} delisted addon(s) from the corpus`);
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
    // lands in the same place — no file on disk — and no re-run will conjure a URL, so it is
    // recorded the same way a deleted repository is.
    if (!sourceUrl) return {addon: addonKey(addon), url: "", reason: "no source URL in the store listing", kept: await exists(file), permanent: true};

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
        return {addon: addonKey(addon), url: downloadUrl, reason: describeError(error), kept: await exists(file), permanent: isPermanent(error)};
    }
}

// Every failure is logged — a silent skip is the failure mode this whole path exists to prevent —
// and a corpus missing more than its class's tolerance stops being a measurement, so it throws.
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
    const gone = missing.filter(entry => entry.permanent).length;
    const unreachable = missing.length - gone;
    const goneLimit = Math.min(MAX_GONE, Math.floor(count * MAX_GONE_SHARE));
    const unreachableLimit = Math.min(MAX_UNREACHABLE, Math.floor(count * MAX_UNREACHABLE_SHARE));

    if (gone > goneLimit) {
        throw new Error(`${gone} of ${count} store addons no longer exist at their source URL (tolerance ${goneLimit}) — too much of the corpus is gone to analyze; check whether the store listing has gone stale or the host is serving 404 for everything`);
    }
    if (unreachable > unreachableLimit) {
        throw new Error(`${unreachable} of ${count} store addons could not be reached (tolerance ${unreachableLimit}) — this run's corpus is an artifact of a bad connection rather than a measurement; re-run`);
    }
}
