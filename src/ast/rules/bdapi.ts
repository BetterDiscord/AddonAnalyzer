import type {ESTree} from "meriyah";
import {deprecatedPaths} from "../../surface";
import {Type} from "../../types";
import {memberChain, resolveChain, stripGlobal} from "../helpers";
import {type Finding, type Rule, type RuleContext} from "../types";


// Currently-deprecated APIs, read from the generated surface manifest rather than listed
// here: `@deprecated` in BD core is the fact, and a copy of it drifts the moment core
// deprecates something else. Regenerate with `bun run scripts/surface.ts <bd-path>`.
const DEPRECATED_CURRENT = deprecatedPaths();

// Deprecated options of otherwise-fine calls: api -> which argument and which property
const DEPRECATED_OPTIONS: Record<string, {index: number, option: string}> = {
    "BdApi.DOM.createElement": {index: 1, option: "target"},
};

// Old-old deprecations kept as a sanity check; the current store corpus should report zero of these
const DEPRECATED = new Set([
    ...DEPRECATED_CURRENT,
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

// Non-computed properties of an object literal argument
function literalOptionNames(argument: ESTree.Node | undefined): string[] {
    if (!argument || argument.type !== "ObjectExpression") return [];
    const names: string[] = [];
    for (const property of argument.properties) {
        if (property.type !== "Property") continue;
        if (!property.computed && property.key.type === "Identifier") names.push(property.key.name);
        else if (property.key.type === "Literal" && typeof property.key.value === "string") names.push(property.key.value);
    }
    return names;
}

function buildFinding(api: string, usage: "call" | "member" | "destructure", viaAlias: boolean, node: ESTree.Node, context: RuleContext, forceDeprecated = false): Finding {
    const deprecated = forceDeprecated || DEPRECATED.has(api);
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
            const api = resolved.chain.join(".");
            const usage = parent?.type === "CallExpression" && parent.callee === node ? "call" : "member";
            const findings = [buildFinding(api, usage, resolved.viaAlias, node, context)];

            // e.g. the deprecated `target` option of BdApi.DOM.createElement
            const optionSpec = DEPRECATED_OPTIONS[api];
            if (optionSpec && usage === "call" && parent?.type === "CallExpression"
                && literalOptionNames(parent.arguments[optionSpec.index]).includes(optionSpec.option)) {
                findings.push(buildFinding(`${api}({${optionSpec.option}})`, usage, resolved.viaAlias, node, context, true));
            }
            return findings;
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
