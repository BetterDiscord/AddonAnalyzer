import fs from "fs/promises";
import path from "path";
import {addonFolder, resultsFolder} from "./constants";
import {type Results, type CachedAddon, Type, type AddonFilename} from "./types";
import * as Analyses from "./analyses";


type OverallResults = Record<CachedAddon["author"], Record<AddonFilename, Record<string, Results>>>;

export async function analyze() {
    const results: OverallResults = {};

    const filesAndFolders = await fs.readdir(addonFolder);
    for (let f = 0; f < filesAndFolders.length; f++) {
        const author = filesAndFolders[f];
        const authorPath = path.join(addonFolder, author);
        if (!(await fs.stat(authorPath)).isDirectory()) continue;
        if (!results[author]) results[author] = {};
        // console.log(`Processing addons by ${author}...`);

        const addonFiles = (await fs.readdir(authorPath)).filter(a => a.endsWith(".plugin.js") || a.endsWith(".theme.css"));
        for (let a = 0; a < addonFiles.length; a++) {
            const filename = addonFiles[a] as AddonFilename;
            if (!results[author][filename]) results[author][filename] = {};

            const file = path.join(authorPath, filename);
            const contents = (await fs.readFile(file)).toString();
            const addon: CachedAddon = {
                file_content: contents,
                file_name: filename,
                author: author,
                type: filename.endsWith(".plugin.js") ? Type.Plugin : Type.Theme
            };
            for (const name in Analyses) {
                const analysis = Analyses[name as keyof typeof Analyses];
                // if (!results[author][filename][analysis.key]) results[author][filename] = {};
                const post: Results = analysis.run(addon);
                results[author][filename][analysis.key] = post;
            }
        }
    }

    await aggregate(results);
    // console.log(results);
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


    return false;
}

await analyze();

// const bdGlobals = ["BDV2", "pluginModule", "PluginModule", "themeModule", "ThemeModule", "Utils", "BDEvents", "settingsPanel", "DataStore", "emoteModule", "EmoteModule",
//                    "ContentManager", "ClassNormalizer", "mainCore", "Core", "V2C", "minimumDiscordVersion", "currentDiscordVersion", "minSupportedVersion", "bbdVersion",
//                    "bbdChangelog", "window.settings", "defaultCookie", "settingsCookie", "bdpluginErrors", "bdthemeErrors", "bdConfig", "bemotes", "emotesFfz", "emotesBTTV",
//                    "emotesBTTV2", "emotesTwitch", "subEmotesTwitch", "bdEmotes", "bdEmoteSettingIDs", "bdthemes", "bdplugins", "pluginCookie", "themeCookie", "$(",
//                    "module.exports", "da-"];



// const bdGlobals = ["ZeresPluginLibrary"];

// const data = {};

// const reposPath = path.resolve(__dirname, "repos");
// const authors = fs.readdirSync(reposPath);
// let total = 0;
// for (const author of authors) {
//     if (author == "results.json") continue;
//     if (!data[author]) data[author] = {};
//     console.log("Processing plugins by: " + author);

//     let authorCount = 0;
//     const plugins = fs.readdirSync(path.resolve(reposPath, author));
//     for (const plugin of plugins) {
//         if (!plugin.endsWith(".plugin.js")) continue;
//         if (plugin == "repo.txt" || plugin == "results.json") continue;
//         if (!data[author][plugin]) data[author][plugin] = [];
//         const string = fs.readFileSync(path.resolve(reposPath, author, plugin)).toString();
//         let pluginCount = 0;
//         for (const bdGlobal of bdGlobals) {
//             if (!string.includes(bdGlobal)) continue;
//             data[author][plugin].push(bdGlobal);
//             pluginCount++;
//         }
//         console.log(plugin + ": " + pluginCount);
//         authorCount = authorCount + pluginCount;
//     }
//     data[author].count = authorCount;
//     console.log("Total: " + authorCount);
//     console.log("\n");


//     fs.writeFileSync(path.resolve(reposPath, author, "results.json"), JSON.stringify(data[author], null, 4));
//     total = total + authorCount;
// }

// data.count = total;
// fs.writeFileSync(path.resolve(reposPath, "results.json"), JSON.stringify(data, null, 4));

// console.log("Found a total of " + total + " globals used.");



// (async () => {

//     const listString = await new Promise(resolve => {request.get(listUrl, (err,resp,body) => {resolve(body);});});
//     const list = listString.split("\r\n");

//     let lastAuthor = null;
//     let authorPath = null;
//     let metaFile = null;
//     for (const url of list) {
//         const split = url.split("/");
//         const repo = split[4];
//         const author = split[3];
//         const plugin = split[split.length - 1];
//         if (author !== lastAuthor) {
//             lastAuthor = author;
//             authorPath = path.resolve(__dirname, "repos", author);
//             metaFile = path.resolve(authorPath, "repo.txt");
//             console.log("\n");
//             console.log("Downloading plugins by: " + author);
//         }
//         console.log(plugin);
//         if (!fs.existsSync(authorPath)) fs.mkdirSync(authorPath);
//         if (!fs.existsSync(metaFile)) fs.writeFileSync(metaFile, `https://github.com/${author}/${repo}`);
//         await new Promise(resolve => {
//             request.get(url, (err, resp, body) => {
//                 if (err) return console.log(err);
//                 fs.writeFileSync(path.resolve(authorPath, plugin), body);
//                 resolve();
//             });
//         });
//     }
// })();
