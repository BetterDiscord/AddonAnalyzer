import fs from "fs/promises";
import path from "path";
import ky from "ky";
import type {APIAddon} from "./types";
import {addonFolder, cacheFolder} from "./constants";


const addonCacheJson = path.join(cacheFolder, "addons.json");
const cacheMetaJson = path.join(cacheFolder, "meta.json");


interface Metadata {
    lastUpdated: string;
    count: number;
}

async function exists(location: string) {
    try {
        await fs.access(location);
        return true;
    }
    catch {
        return false;
    }
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

export async function isInvalid() {
    if (!(await exists(cacheFolder))) return true;
    try {
        const metadata: Metadata = JSON.parse((await fs.readFile(cacheMetaJson)).toString()) as Metadata;
        if (weekStart(new Date(metadata.lastUpdated)) !== weekStart(new Date())) return true;
        const cached: APIAddon[] = JSON.parse((await fs.readFile(addonCacheJson)).toString()) as APIAddon[];
        if (cached.length != metadata.count) return true;
        return false;
    }
    catch {
        return true;
    }
}


async function ensureDirs() {
    if (!(await exists(cacheFolder))) await fs.mkdir(cacheFolder);
    if (!(await exists(addonFolder))) await fs.mkdir(addonFolder);
}


const API_URL = "https://api.betterdiscord.app/v3/store/addons";

export async function update() {
    if (!(await isInvalid())) return;
    await ensureDirs();

    const addons: APIAddon[] = await ky.get(API_URL).json();
    addons.sort((a, b) => a.author.display_name.localeCompare(b.author.display_name));
    await fs.writeFile(addonCacheJson, JSON.stringify(addons, null, 4));

    let author: string = "";
    let authorPath: string = "";
    for (let a = 0; a < addons.length; a++) {
        const addon = addons[a];
        if (addon.author.display_name !== author) {
            author = addon.author.display_name;
            authorPath = path.join(addonFolder, author.replace(/[/\\?%*:|"<>]/g, ""));
            if (!(await exists(authorPath))) await fs.mkdir(authorPath);

            console.log("");
            console.log(`Downloading addons by ${author}...`);
        }
        console.log(addon.file_name);
        await downloadAddon(addon, authorPath);
    }

    await fs.writeFile(cacheMetaJson, JSON.stringify({lastUpdated: new Date().toISOString(), count: addons.length}, null, 4));
}

async function downloadAddon(addon: APIAddon, location: string) {
    const sourceUrl = addon.latest_source_url;
    if (!sourceUrl) return;

    const authorPath = path.join(addonFolder, addon.author.display_name.replace(/[/\\?%*:|"<>]/g, ""));
    if (!(await exists(authorPath))) await fs.mkdir(authorPath);

    const downloadUrl = sourceUrl.replace("github.com", "raw.githubusercontent.com").replace("blob/", "");
    const code = await ky.get(downloadUrl).text();
    await fs.writeFile(path.resolve(location, addon.file_name), code);
}