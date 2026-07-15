import type {ESTree} from "meriyah";
import {propertyName} from "../helpers";
import {AddonType, type Finding, type Rule, type RuleContext} from "../types";


// Top-level legacy aliases superseded by the namespaced APIs (Data, Webpack, DOM, UI, Patcher)
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

// Builds the dotted path of a member chain, e.g. BdApi.Webpack.getModule -> ["BdApi", "Webpack", "getModule"].
// Dynamic segments become "*"; a leading window. is stripped. Returns null for non-identifier roots.
function memberChain(node: ESTree.Node): string[] | null {
    const parts: string[] = [];
    let current: ESTree.Node = node;

    while (current.type === "MemberExpression") {
        parts.unshift(propertyName(current) ?? "*");
        current = current.object;
    }

    if (current.type !== "Identifier") return null;
    parts.unshift(current.name);

    if (parts[0] === "window" || parts[0] === "globalThis") parts.shift();
    return parts;
}

function isBdApiChain(node: ESTree.Node): boolean {
    const chain = memberChain(node);
    return chain !== null && chain[0] === "BdApi" && chain.length > 1;
}

// References BdApi itself: the identifier or window.BdApi / globalThis.BdApi
function isBdApiRoot(node: ESTree.Node): boolean {
    if (node.type === "Identifier" && node.name === "BdApi") return true;
    const chain = memberChain(node);
    return chain !== null && chain.length === 1 && chain[0] === "BdApi";
}

function buildFinding(api: string, usage: "call" | "member" | "destructure", node: ESTree.Node, context: RuleContext): Finding {
    const deprecated = DEPRECATED.has(api);
    return {
        rule: "bdapi-usage",
        file: context.file,
        message: deprecated ? `Deprecated API used: ${api}` : `BdApi usage detected: ${api}`,
        category: deprecated ? "deprecated" : "api",
        severity: deprecated ? "warning" : "info",
        details: {api, usage, deprecated},
        loc: context.getLoc(node)
    };
}

export const bdApiRule: Rule = {
    name: "bdapi-usage",
    appliesTo: [AddonType.Plugin],

    match(node, _context, parent) {
        // Outermost link of a BdApi member chain; inner links are skipped so each chain reports once
        if (node.type === "MemberExpression" && isBdApiChain(node)) {
            return !(parent?.type === "MemberExpression" && parent.object === node);
        }

        // const {Webpack, Patcher} = BdApi;
        if (node.type === "VariableDeclarator" && node.id.type === "ObjectPattern" && node.init && isBdApiRoot(node.init)) {
            return true;
        }

        return false;
    },

    report(node, context, parent) {
        if (node.type === "MemberExpression") {
            const chain = memberChain(node);
            if (!chain) return null;
            const usage = parent?.type === "CallExpression" && parent.callee === node ? "call" : "member";
            return buildFinding(chain.join("."), usage, node, context);
        }

        if (node.type === "VariableDeclarator" && node.id.type === "ObjectPattern") {
            const findings: Finding[] = [];
            for (const property of node.id.properties) {
                if (property.type !== "Property") continue;
                if (property.key.type === "Identifier") {
                    findings.push(buildFinding(`BdApi.${property.key.name}`, "destructure", node, context));
                }
                else if (property.key.type === "Literal" && typeof property.key.value === "string") {
                    findings.push(buildFinding(`BdApi.${property.key.value}`, "destructure", node, context));
                }
            }
            return findings.length ? findings : null;
        }

        return null;
    }
};
