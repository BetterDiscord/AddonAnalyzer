import fs from "fs";
import path from "path";

const pluginPath = path.resolve(__dirname, "repos");
const pluginAuthors = fs.readdirSync(pluginPath);

(async () => {

    for (const author of pluginAuthors) {
        if (author == "results.json") continue;
        const authorPath = path.join(pluginPath, author);

        const plugins = fs.readdirSync(authorPath).filter(m => m.endsWith(".plugin.js"));
        for (const plugin of plugins) {
            const pluginString = fs.readFileSync(path.join(authorPath, plugin)).toString();
            const isOldMeta = pluginString.startsWith("//META");
            if (isOldMeta) console.log(plugin);
        }

        // console.log("");
        // console.log("");
        // break;
    }


})();


const themePath = path.resolve(__dirname, "themes");
const themeAuthors = fs.readdirSync(themePath);

(async () => {

    for (const author of themeAuthors) {
        if (author == "results.json") continue;
        const authorPath = path.join(themePath, author);

        const themes = fs.readdirSync(authorPath).filter(m => m.endsWith(".theme.css"));
        for (const theme of themes) {
            const themeString = fs.readFileSync(path.join(authorPath, theme)).toString();
            const isOldMeta = themeString.startsWith("//META");
            if (isOldMeta) console.log(theme);
        }

        // console.log("");
        // console.log("");
        // break;
    }


})();