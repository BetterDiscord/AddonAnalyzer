import fs from "fs/promises";
import path from "path";
import {authorDirName} from "./cache";
import {cacheFolder} from "./constants";
import type {APIAddon} from "./types";


/**
 * Per-addon store metadata (downloads, likes, release dates), joined to analyzed files by
 * `<author dir>/<file_name>` — the same keying results/addons.json uses. The source is
 * `.cache/addons.json`, the full store API response cache.ts already persists for its count
 * check, so this costs zero extra requests and every valid cache carries it. This loader owns
 * every judgement against that file (type coercion, join keying), the same way surface.ts and
 * discordvars.ts own their manifests — nothing else reads the JSON directly.
 *
 * The join is at report/KPI time, never through the pipeline: download-weighted numbers are
 * per-addon metadata × per-addon results, and the summing `Results` shape must not change
 * (a summed weighted count is as meaningless as a summed ratio — handoff-07's argument).
 */

export interface StoreMeta {
    id: number;
    // Cumulative lifetime downloads — installed base, never active users. Captions must say
    // "cumulative downloads"; the history snapshot series is what yields velocity over time.
    downloads: number;
    likes: number;
    tags: string[];
    initialRelease: string;
    latestRelease: string;
}

export type StoreMetaMap = Map<string, StoreMeta>;

export function storeMetaKey(authorDir: string, fileName: string): string {
    return `${authorDir}/${fileName}`;
}

export type Staleness = "active" | "aging" | "abandoned";

// Mean Gregorian month; the bucket edges are months-scale, so calendar-exact math buys nothing
const MONTH_MS = 30.4375 * 24 * 60 * 60 * 1000;

export function monthsBetween(earlierIso: string, laterIso: string): number {
    return (Date.parse(laterIso) - Date.parse(earlierIso)) / MONTH_MS;
}

// Buckets by last *store release* relative to the corpus dataDate — never the run date, the
// same reasoning as history keying. Thresholds are the maintainer's call (2026-07): active
// <= 6 months, aging 6-24, abandoned > 24. A release date is a proxy for maintenance, not
// author activity — a stable, finished addon looks abandoned by this metric — so staleness
// must never be presented as a defect on its own, only in conjunction with a fragile or
// deprecated surface (see the report card).
export function stalenessBucket(latestRelease: string, dataDate: string): Staleness {
    const months = monthsBetween(latestRelease, dataDate);
    if (months <= 6) return "active";
    if (months <= 24) return "aging";
    return "abandoned";
}

export async function loadStoreMeta(): Promise<StoreMetaMap> {
    const map: StoreMetaMap = new Map();
    let addons: APIAddon[];
    try {
        addons = JSON.parse(await fs.readFile(path.join(cacheFolder, "addons.json"), "utf8")) as APIAddon[];
    }
    catch {
        // A cache without a readable store response still analyzes: weighted readings degrade
        // to zero and the report renders raw counts alone — same rule as missing history.
        return map;
    }

    for (const addon of addons) {
        map.set(storeMetaKey(authorDirName(addon.author.display_name), addon.file_name), {
            id: addon.id,
            downloads: addon.downloads,
            likes: Number(addon.likes) || 0,
            tags: addon.tags,
            initialRelease: addon.initial_release_date,
            latestRelease: addon.latest_release_date
        });
    }
    return map;
}
