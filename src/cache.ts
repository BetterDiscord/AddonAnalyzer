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

const MILLISECONDS_PER_DAY = 1000 * 60 * 60 * 24;
function dateDiffInDays(a: Date, b: Date) {

    // Discard the time and time-zone information.
    const utc1 = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
    const utc2 = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());

    return Math.floor((utc2 - utc1) / MILLISECONDS_PER_DAY);
}

export async function isInvalid() {
    if (!(await fs.exists(cacheFolder))) return true;
    try {
        const metadata: Metadata = JSON.parse((await fs.readFile(cacheMetaJson)).toString());
        const lastUpdated = new Date(metadata.lastUpdated);
        if (dateDiffInDays(lastUpdated, new Date()) >= 7) return true;
        const cached: APIAddon[] = JSON.parse((await fs.readFile(addonCacheJson)).toString());
        if (cached.length != metadata.count) return true;
        return false;
    }
    catch {
        return true;
    }
}


async function ensureDirs() {
    if (!(await fs.exists(cacheFolder))) await fs.mkdir(cacheFolder);
    if (!(await fs.exists(addonFolder))) await fs.mkdir(addonFolder);
}


const API_URL = "https://api.betterdiscord.app/v3/store/addons";

export async function update() {
    if (!isInvalid()) return;
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
            if (!(await fs.exists(authorPath))) await fs.mkdir(authorPath);

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
    if (!(await fs.exists(authorPath))) await fs.mkdir(authorPath);

    const downloadUrl = sourceUrl.replace("github.com", "raw.githubusercontent.com").replace("blob/", "");
    const code = await ky.get(downloadUrl).text();
    await fs.writeFile(path.resolve(location, addon.file_name), code);
}