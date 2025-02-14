import fs from "fs";
import path from "path";
import request from "request";
import type {Addon} from "./types";

const listUrl = "https://api.betterdiscord.app/v3/store/plugins";



(async () => {

    const pluginList: Addon[] = await new Promise(resolve => {request.get(listUrl, (_, __, body: string) => {resolve(JSON.parse(body));});});
    pluginList.sort((a, b) => a.author.display_name.localeCompare(b.author.display_name));
    fs.writeFileSync(path.resolve(__dirname, "PluginList.json"), JSON.stringify(pluginList, null, 4));
    if (!fs.existsSync(path.resolve(__dirname, "repos"))) fs.mkdirSync(path.resolve(__dirname, "repos"));

    let lastUser: string = "";
    let authorPath: string = "";
    let metaFile: string = "";
    for (const plugin of pluginList) {
        const url = plugin.latest_source_url;
        if (!url) continue;
        const split = url.split("/");
        const repo = split[4];
        const githubUser = split[3];
        const filename = split[split.length - 1];
        if (githubUser !== lastUser) {
            lastUser = githubUser;
            authorPath = path.resolve(__dirname, "repos", plugin.author.display_name.replace(/[/\\?%*:|"<>]/g, ""));
            metaFile = path.resolve(authorPath, "repo.txt");
            console.log("\n");
            console.log("Downloading plugins by: " + plugin.author.display_name);
        }
        console.log(filename);
        if (!fs.existsSync(authorPath)) fs.mkdirSync(authorPath);
        if (!fs.existsSync(metaFile)) fs.writeFileSync(metaFile, `https://github.com/${githubUser}/${repo}`);

        const downloadUrl = url.replace("github.com", "raw.githubusercontent.com").replace("blob/", "");
        await new Promise(resolve => {
            request.get(downloadUrl, (err, resp, body: string) => {
                if (err) return console.log(err);
                fs.writeFileSync(path.resolve(authorPath, filename), body);
                resolve();
            });
        });
    }
})();

/*
deprecateGlobal("BDV2", BDV2);
deprecateGlobal("pluginModule", pluginModule);
deprecateGlobal("themeModule", themeModule);
deprecateGlobal("Utils", Utils);
deprecateGlobal("BDEvents", BDEvents);
deprecateGlobal("settingsPanel", settingsPanel);
deprecateGlobal("DataStore", DataStore);
deprecateGlobal("emoteModule", emoteModule);
deprecateGlobal("ContentManager", ContentManager);
deprecateGlobal("ClassNormalizer", ClassNormalizer);
mainCore
Core
V2C
0: "minimumDiscordVersion"
1: "currentDiscordVersion"
2: "minSupportedVersion"
3: "bbdVersion"
4: "bbdChangelog"
5: "settings"
6: "defaultCookie"
7: "settingsCookie"
8: "bdpluginErrors"
9: "bdthemeErrors"
10: "bdConfig"
11: "bemotes"
12: "emotesFfz"
13: "emotesBTTV"
14: "emotesBTTV2"
15: "emotesTwitch"
16: "subEmotesTwitch"
17: "bdEmotes"
18: "bdEmoteSettingIDs"
19: "bdthemes"
20: "bdplugins"
21: "pluginCookie"
22: "themeCookie"
*/
// https://github.com/ordinall/BetterDiscord-Stuff/blob/d48cd9540a0373bd28a480845edc8893e1c0fe2e/Plugins/DisableStickerSuggestions/DisableStickerSuggestions.plugin.js
// https://raw.githubusercontent.com/ordinall/BetterDiscord-Stuff/d48cd9540a0373bd28a480845edc8893e1c0fe2e/Plugins/DisableStickerSuggestions/DisableStickerSuggestions.plugin.js
// https://raw.githubusercontent.com/ordinall/BetterDiscord-Stuff/d48cd9540a0373bd28a480845edc8893e1c0fe2e/Plugins/DisableStickerSuggestions/DisableStickerSuggestions.plugin.js