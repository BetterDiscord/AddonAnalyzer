const fs = require("fs");
const path = require("path");

const bdGlobals = [".da-"];



const data = {};

const reposPath = path.resolve(__dirname, "themes");
const authors = fs.readdirSync(reposPath);
let total = 0;
for (const author of authors) {
    if (author == "results.json") continue;
    if (!data[author]) data[author] = {};
    console.log("Processing plugins by: " + author);

    let authorCount = 0;
    const themes = fs.readdirSync(path.resolve(reposPath, author));
    for (const theme of themes) {
        if (theme == "repo.txt" || theme == "results.json") continue;
        if (!data[author][theme]) data[author][theme] = [];
        const string = fs.readFileSync(path.resolve(reposPath, author, theme)).toString();
        let themeCount = 0;
        for (const bdGlobal of bdGlobals) {
            if (!string.includes(bdGlobal)) continue;
            data[author][theme].push(bdGlobal);
            themeCount++;
        }
        console.log(theme + ": " + themeCount);
        authorCount = authorCount + themeCount;
    }
    data[author].count = authorCount;
    console.log("Total: " + authorCount);
    console.log("\n");


    fs.writeFileSync(path.resolve(reposPath, author, "results.json"), JSON.stringify(data[author], null, 4));
    total = total + authorCount;
}

data.count = total;
fs.writeFileSync(path.resolve(reposPath, "results.json"), JSON.stringify(data, null, 4));

console.log("Found a total of " + total + " normalized classes used.");



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
