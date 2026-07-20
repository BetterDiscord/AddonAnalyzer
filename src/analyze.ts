import fs from "fs/promises";
import path from "path";
import {addonFolder, resultsFolder} from "./constants";
import {loadImportGraph, loadRemoteCss, themeKey} from "./importcache";
import {type Results, type CachedAddon, Type, type AddonFilename, type Analysis} from "./types";
import * as Analyses from "./analyses";


type OverallResults = Record<CachedAddon["author"], Record<AddonFilename, Record<string, Results>>>;

export async function analyze() {
    const results: OverallResults = {};
    const importGraph = await loadImportGraph();

    const filesAndFolders = await fs.readdir(addonFolder);
    for (let f = 0; f < filesAndFolders.length; f++) {
        const author = filesAndFolders[f];
        const authorPath = path.join(addonFolder, author);
        if (!(await fs.stat(authorPath)).isDirectory()) continue;
        if (!results[author]) results[author] = {};

        const addonFiles = (await fs.readdir(authorPath)).filter(a => a.endsWith(".plugin.js") || a.endsWith(".theme.css"));
        for (let a = 0; a < addonFiles.length; a++) {
            const filename = addonFiles[a] as AddonFilename;
            if (!results[author][filename]) results[author][filename] = {};

            const file = path.join(authorPath, filename);
            const contents = (await fs.readFile(file)).toString();
            const type = filename.endsWith(".plugin.js") ? Type.Plugin : Type.Theme;
            const addon: CachedAddon = {
                file_content: contents,
                file_name: filename,
                author: author,
                type,
                remote_content: type === Type.Theme ? await loadRemoteCss(themeKey(author, filename), importGraph) : undefined
            };
            for (const name in Analyses) {
                const analysis: Analysis = Analyses[name as keyof typeof Analyses];
                if (!analysis.types.includes(addon.type)) continue;
                const post: Results = await analysis.run(addon);
                results[author][filename][analysis.key] = post;
            }
        }
    }

    await aggregate(results);
}

async function aggregate(results: OverallResults) {
    const byAuthor: Record<CachedAddon["author"], Record<string, Results>> = {};
    for (const author in results) {
        byAuthor[author] = aggregateAuthor(results[author]);
    }

    const summary: Record<string, Results> = {};
    for (const author in byAuthor) {
        for (const analysis in byAuthor[author]) {
            if (!(analysis in summary)) summary[analysis] = getMergableValue(byAuthor[author][analysis]);
            else summary[analysis] = mergeResults(summary[analysis], byAuthor[author][analysis]);
            // byAuthor[author] = aggregateAuthor(results[author]);
        }
    }

    // results/ is gitignored, so a fresh checkout (e.g. a CI runner) starts without it
    await fs.mkdir(resultsFolder, {recursive: true});
    await fs.writeFile(path.join(resultsFolder, "addons.json"), JSON.stringify(results, null, 4));
    await fs.writeFile(path.join(resultsFolder, "authors.json"), JSON.stringify(byAuthor, null, 4));
    await fs.writeFile(path.join(resultsFolder, "summary.json"), JSON.stringify(summary, null, 4));
}

function aggregateAuthor(results: OverallResults[string]): Record<string, Results> {
    const aggregated: Record<string, Results> = {};
    for (const filename in results) {
        for (const analysis in results[filename as AddonFilename]) {
            if (!(analysis in aggregated)) aggregated[analysis] = getMergableValue(results[filename as AddonFilename][analysis]);
            else aggregated[analysis] = mergeResults(aggregated[analysis], results[filename as AddonFilename][analysis]);
        }
    }
    return aggregated;
}

function getMergableValue(result: Results) {
    if (typeof result === "boolean") {
        if (result) return 1;
        return 0;
    }
    return result;
}

function mergeResults(original: Results, added: Results): Results {
    original = getMergableValue(original);
    added = getMergableValue(added);

    if (typeof original === "number") {
        if (typeof added !== "number") throw new Error(`Unexpected merging type ${typeof added}`);
        return original + added;
    }

    if (Array.isArray(original)) {
        if (!Array.isArray(added)) throw new Error(`Unexpected merging type ${typeof added}`);
        return [...original, ...added];
    }

    if (typeof original === "object") {
        if (typeof added !== "object") throw new Error(`Unexpected merging type ${typeof added}`);
        if (Array.isArray(added)) throw new Error(`Unexpected merging type ${typeof added}`);
        const res = Object.assign({}, original);
        for (const key in added) {
            if (res[key]) res[key] = res[key] + added[key];
            else res[key] = added[key];
        }
        return res;
    }

    throw new Error(`Unexpected merging type ${typeof original}`);
}
