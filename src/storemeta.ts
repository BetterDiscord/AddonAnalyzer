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
