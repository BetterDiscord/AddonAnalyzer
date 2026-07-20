import fs from "fs/promises";
import path from "path";
import ky from "ky";
import {IMPORT_PATTERN} from "./ast/rules/cssurls";
import {addonFolder, cacheFolder, importsFolder} from "./constants";


// Theme @import graphs run a few levels deep at most (theme -> library base -> shared partial);
// the cap is a cycle/runaway backstop, not a real limit anyone hits.
const MAX_DEPTH = 5;

// Themes are injected into discord.com, so a bare theme file resolves protocol- and
// root-relative @imports there; nested imports resolve against their own URL.
const THEME_BASE = "https://discord.com/";

const graphJson = path.join(importsFolder, "graph.json");
const importsMetaJson = path.join(importsFolder, "meta.json");
const addonMetaJson = path.join(cacheFolder, "meta.json");

export type ImportGraph = Record<string, string[]>;

interface ImportsMeta {
    dataDate: string; // the addon cache's lastUpdated, so imports refresh in lockstep with the corpus
    themes: number;
    urls: number;
}

// Key a theme's graph by "<author-folder>/<filename>", matching how analyze.ts walks the corpus.
export function themeKey(author: string, filename: string): string {
    return `${author}/${filename}`;
}

async function exists(location: string): Promise<boolean> {
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

// Resolve an @import reference against its base URL. Absolute URLs pass through; protocol- and
// root-relative refs resolve against the base (discord.com for a theme file, the parent URL for a
// nested import). var()/template noise and data: URIs are dropped, matching the css-url rule.
function resolveImport(ref: string, base: string): string | null {
    const cleaned = ref.replace(/\\/g, "").trim();
    if (!cleaned || cleaned.startsWith("data:") || cleaned.startsWith("#")) return null;
    if (/[({}$]/.test(cleaned)) return null;
    try {
        const url = new URL(cleaned, base);
        if (url.protocol !== "http:" && url.protocol !== "https:") return null;
        // Discord never serves addon CSS, so a discord.com host here is always a root-/bare-relative
        // ref resolved against THEME_BASE — i.e. regex noise from prose ("remove this @import if you
        // wish", "@import to enable"). Dropping it restores the old analysis's absolute-URL-only floor.
        if (url.hostname === "discord.com" || url.hostname === "discordapp.com") return null;
        return url.toString();
    }
    catch {
        return null;
    }
}

// Deterministic on-disk location for a fetched URL, so writing and reading agree without a lookup
// table. host + path, with a .css suffix and unsafe characters neutralised.
function cachePathForUrl(url: string): string {
    const u = new URL(url);
    let rel = u.hostname + u.pathname;
    if (rel.endsWith("/")) rel += "index";
    if (u.search) rel += "__" + u.search.slice(1);
    rel = rel.replace(/[^a-zA-Z0-9._/-]/g, "_");
    if (!rel.endsWith(".css")) rel += ".css";
    return path.join(importsFolder, rel);
}

interface Counters {
    fetched: number;
    skipped: number;
}

// Fetch a URL once per run (memoised across all themes — the mwittrien/ClearVision bases are
// shared by dozens of themes) and cache the body to disk. Returns null on any failure, logged.
async function fetchAndCache(url: string, memo: Map<string, string | null>, counters: Counters): Promise<string | null> {
    if (memo.has(url)) return memo.get(url) ?? null;
    try {
        const body = await ky.get(url, {timeout: 15000, retry: 0}).text();
        const file = cachePathForUrl(url);
        await fs.mkdir(path.dirname(file), {recursive: true});
        await fs.writeFile(file, body);
        memo.set(url, body);
        counters.fetched++;
        return body;
    }
    catch (error) {
        // A dead *.github.io must not fail the run, but a silent skip means under-reported CSP
        // hosts — the exact thing this cache exists to fix — so every skip is logged.
        console.warn(`imports: skipped ${url} (${error instanceof Error ? error.message : String(error)})`);
        memo.set(url, null);
        counters.skipped++;
        return null;
    }
}

// Depth-first walk of a theme's import graph with a per-theme visited set (so a URL shared by 12
// themes is counted under each of them — fragility is per-theme) and a depth cap for cycle safety.
async function collectGraph(
    css: string,
    base: string,
    depth: number,
    visited: Set<string>,
    out: string[],
    memo: Map<string, string | null>,
    counters: Counters
): Promise<void> {
    if (depth > MAX_DEPTH) return;
    for (const match of css.matchAll(IMPORT_PATTERN)) {
        const url = resolveImport(match[1], base);
        if (!url || visited.has(url)) continue;
        visited.add(url);
        out.push(url);
        const body = await fetchAndCache(url, memo, counters);
        if (body === null) continue;
        await collectGraph(body, url, depth + 1, visited, out, memo, counters);
    }
}

// Fetch and cache every theme's transitive @import graph, keyed by theme. Gated on the addon
// cache's dataDate: once populated for a corpus, a re-run against the same corpus makes zero
// network requests. On a fresh corpus it rebuilds from scratch (the couple-minute first run).
export async function updateImports(): Promise<void> {
    const addonMeta = await readJson<{lastUpdated: string}>(addonMetaJson);
    if (!addonMeta) return; // no corpus yet — nothing to resolve
    const dataDate = addonMeta.lastUpdated;

    const existing = await readJson<ImportsMeta>(importsMetaJson);
    if (existing && existing.dataDate === dataDate && await exists(graphJson)) return;

    await fs.mkdir(importsFolder, {recursive: true});
    const graph: ImportGraph = {};
    const memo = new Map<string, string | null>();
    const counters: Counters = {fetched: 0, skipped: 0};

    const authors = await fs.readdir(addonFolder);
    for (const author of authors) {
        const authorPath = path.join(addonFolder, author);
        if (!(await fs.stat(authorPath)).isDirectory()) continue;
        const themes = (await fs.readdir(authorPath)).filter(f => f.endsWith(".theme.css"));
        for (const theme of themes) {
            const css = await fs.readFile(path.join(authorPath, theme), "utf8");
            const out: string[] = [];
            await collectGraph(css, THEME_BASE, 1, new Set(), out, memo, counters);
            graph[themeKey(author, theme)] = out;
        }
    }

    const urls = Object.values(graph).reduce((n, list) => n + list.length, 0);
    await fs.writeFile(graphJson, JSON.stringify(graph, null, 4));
    await fs.writeFile(importsMetaJson, JSON.stringify({dataDate, themes: Object.keys(graph).length, urls} satisfies ImportsMeta, null, 4));
    console.log(`imports: cached ${counters.fetched} remote files (${counters.skipped} skipped) across ${Object.keys(graph).length} themes`);
}

let graphCache: ImportGraph | null = null;
export async function loadImportGraph(): Promise<ImportGraph> {
    if (!graphCache) graphCache = (await readJson<ImportGraph>(graphJson)) ?? {};
    return graphCache;
}

// The concatenated remote CSS for one theme, read from the on-disk cache. Failed fetches simply
// have no cache file and are skipped. Blank when the theme imports nothing (or the cache is cold).
export async function loadRemoteCss(key: string, graph: ImportGraph): Promise<string> {
    const urls = graph[key];
    if (!urls || !urls.length) return "";
    const parts: string[] = [];
    for (const url of urls) {
        try {
            parts.push(await fs.readFile(cachePathForUrl(url), "utf8"));
        }
        catch {
            continue; // dead/uncached URL — already logged at fetch time
        }
    }
    return parts.join("\n");
}
