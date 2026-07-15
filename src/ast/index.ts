import {bdApiRule} from "./rules/bdapi";
import {evalRule} from "./rules/eval";
import {remoteUrlRule} from "./rules/remoteurls";
import {innerHTMLRule} from "./rules/innerhtml";
import {analyzeAddon} from "./meriyah";
import {AddonType, type Rule} from "./types";

const rules = [
    bdApiRule,
    evalRule,
    innerHTMLRule,
    remoteUrlRule,
] as Rule[];

async function main() {
    const glob = new Bun.Glob("**/*.js");

    for await (const file of glob.scan({cwd: "plugins"})) {
        const path = `plugins/${file}`;
        const code = await Bun.file(path).text();

        const findings = analyzeAddon(path, code, AddonType.Plugin, rules);

        console.log(`\n=== ${path} ===`);
        for (const f of findings) {
            console.log(`- [${f.rule}]`, f);
        }
    }
}

void main();
