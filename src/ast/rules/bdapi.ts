import type {ESTree} from "meriyah";
import {Type} from "../../types";
import {memberChain, resolveChain, stripGlobal} from "../helpers";
import {type Finding, type Rule, type RuleContext} from "../types";


// Old-old deprecations kept as a sanity check; the current store corpus should report zero of these
const DEPRECATED = new Set([
    "BdApi.getData",
    "BdApi.setData",
    "BdApi.loadData",
    "BdApi.saveData",
    "BdApi.deleteData",
    "BdApi.findModule",
    "BdApi.findAllModules",
    "BdApi.findModuleByProps",
    "BdApi.findModuleByPrototypes",
    "BdApi.findModuleByDisplayName",
    "BdApi.injectCSS",
    "BdApi.clearCSS",
    "BdApi.linkJS",
    "BdApi.unlinkJS",
    "BdApi.monkeyPatch",
    "BdApi.getInternalInstance",
    "BdApi.onRemoved",
    "BdApi.alert",
    "BdApi.showConfirmationModal",
    "BdApi.showToast",
    "BdApi.showNotice",
    "BdApi.openDialog",
]);

// Canonical BdApi path of an expression, following aliases: with `const W = BdApi.Webpack`,
// W.getModule resolves to ["BdApi", "Webpack", "getModule"]. Null when not BdApi-rooted.
function resolveBdApi(node: ESTree.Node, context: RuleContext): {chain: string[], viaAlias: boolean} | null {
    const raw = memberChain(node);
    if (!raw) return null;

    const direct = stripGlobal(raw);
    const resolved = stripGlobal(resolveChain(direct, context.aliases));
    if (resolved[0] !== "BdApi") return null;

    return {chain: resolved, viaAlias: direct[0] !== "BdApi"};
}

function buildFinding(api: string, usage: "call" | "member" | "destructure", viaAlias: boolean, node: ESTree.Node, context: RuleContext): Finding {
    const deprecated = DEPRECATED.has(api);
    return {
        rule: "bdapi-usage",
        file: context.file,
        message: deprecated ? `Deprecated API used: ${api}` : `BdApi usage detected: ${api}`,
        category: deprecated ? "deprecated" : "api",
        severity: deprecated ? "warning" : "info",
        details: {api, usage, deprecated, viaAlias},
        loc: context.getLoc(node)
    };
}

export const bdApiRule: Rule = {
    name: "bdapi-usage",
    appliesTo: [Type.Plugin],

    match(node, context, parent) {
        // Outermost link of a BdApi member chain; inner links are skipped so each chain reports once
        if (node.type === "MemberExpression") {
            if (parent?.type === "MemberExpression" && parent.object === node) return false;
            const resolved = resolveBdApi(node, context);
            return resolved !== null && resolved.chain.length > 1;
        }

        // const {Webpack, Patcher} = BdApi; also through aliases and deeper chains
        if (node.type === "VariableDeclarator" && node.id.type === "ObjectPattern" && node.init) {
            return resolveBdApi(node.init, context) !== null;
        }

        return false;
    },

    report(node, context, parent) {
        if (node.type === "MemberExpression") {
            const resolved = resolveBdApi(node, context);
            if (!resolved) return null;
            const usage = parent?.type === "CallExpression" && parent.callee === node ? "call" : "member";
            return buildFinding(resolved.chain.join("."), usage, resolved.viaAlias, node, context);
        }

        if (node.type === "VariableDeclarator" && node.id.type === "ObjectPattern" && node.init) {
            const resolved = resolveBdApi(node.init, context);
            if (!resolved) return null;

            const findings: Finding[] = [];
            for (const property of node.id.properties) {
                if (property.type !== "Property") continue;
                let key: string | null = null;
                if (property.key.type === "Identifier") key = property.key.name;
                else if (property.key.type === "Literal" && typeof property.key.value === "string") key = property.key.value;
                if (key) findings.push(buildFinding([...resolved.chain, key].join("."), "destructure", resolved.viaAlias, node, context));
            }
            return findings.length ? findings : null;
        }

        return null;
    }
};
