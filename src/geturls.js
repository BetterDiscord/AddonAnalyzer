const fs = require("fs");
const path = require("path");
const request = require("request");

const importRegex = /@import url\((.+)\);/g;
const urlRegex = /^[\s]*[A-Za-z-]+[\s]*:.*url\(['"]?((?:data|\/\/|http).+)['"]?\)/gm;
const themePath = path.resolve(__dirname, "themes");
const authors = fs.readdirSync(themePath);
const styleUrls = new Map();
const otherUrls = new Map();

function cleanUrl(url) {
    let cleaned = url.replace(/'/g, () => "").replace(/"/g, () => "").replace(/\\/g, () => "");
    if (cleaned.startsWith("//")) cleaned = "https:" + cleaned;
    else if (cleaned.startsWith("/")) cleaned = "https://discord.com" + cleaned;
    return cleaned.trim();
}

(async () => {

for (const author of authors) {
    if (author == "results.json") continue;
    const authorPath = path.join(themePath, author);
    const importPath = path.join(authorPath, "imports");
    if (!fs.existsSync(importPath)) fs.mkdirSync(importPath);

    console.log("Starting on " + author);

    const themes = fs.readdirSync(authorPath).filter(m => m.endsWith(".theme.css"));
    for (const theme of themes) {
        const themeString = fs.readFileSync(path.join(authorPath, theme)).toString();
        const imports = [...themeString.matchAll(importRegex)].map(i => cleanUrl(i[1]));
        for (const match of imports) {
            const importUrl = new URL(match);
            if (!styleUrls.has(importUrl.hostname)) styleUrls.set(importUrl.hostname, 1);
            else styleUrls.set(importUrl.hostname, styleUrls.get(importUrl.hostname) + 1);
            if (match.includes("fonts.googleapis.com")) continue;
            await new Promise(resolve => {
                request.get(match, (err, resp, body) => {
                    if (err) return console.log(err);
                    const split = match.split("/");
                    const filename = split[split.length - 1];
                    fs.writeFileSync(path.resolve(importPath, filename), body);
                    resolve();
                });
            });
        }
    }

    console.log("Checking imports for URLs for " + author);

    const imports = fs.readdirSync(importPath);
    for (const file of imports) {
        console.log("Checking " + file);
        const importString = fs.readFileSync(path.join(importPath, file)).toString();
        let matches = [...importString.matchAll(importRegex)].map(i => cleanUrl(i[1]));
        for (const match of matches) {
            if (!match.startsWith("http")) {
                console.log("SOMETHING WENT WRONG WITH " + match);
                continue;
            }
            const parsedUrl = new URL(match);
            // styleUrls.add(parsedUrl.hostname);
            if (!styleUrls.has(parsedUrl.hostname)) styleUrls.set(parsedUrl.hostname, 1);
            else styleUrls.set(parsedUrl.hostname, styleUrls.get(parsedUrl.hostname) + 1);
        }



        matches = [...importString.matchAll(urlRegex)].map(i => cleanUrl(i[1]));
        for (const match of matches) {
            if (match.startsWith("data:")) continue;
            if (!match.startsWith("http")) {
                console.log("SOMETHING WENT WRONG WITH " + match);
                continue;
            }
            const parsedUrl = new URL(match);
            // otherUrls.add(parsedUrl.hostname);
            if (!otherUrls.has(parsedUrl.hostname)) otherUrls.set(parsedUrl.hostname, 1);
            else otherUrls.set(parsedUrl.hostname, otherUrls.get(parsedUrl.hostname) + 1);
        }
    }

    console.log("");
    console.log("");
    // break;
}

const cleanedUrls = new Map();

console.log("");
console.log(styleUrls);

console.log("");
console.log(otherUrls);

for (const url of styleUrls.keys()) {
    if (url.includes(".github.io")) continue;
    cleanedUrls.set(url, styleUrls.get(url));
}

cleanedUrls.set("*.github.io", "*");

fs.writeFileSync(path.join(__dirname, "styleurls.json"), JSON.stringify(Array.from(cleanedUrls).sort((a,b) => a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0).reverse(), null, 4));
fs.writeFileSync(path.join(__dirname, "otherurls.json"), JSON.stringify(Array.from(otherUrls).sort((a,b) => a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0).reverse(), null, 4));

})();