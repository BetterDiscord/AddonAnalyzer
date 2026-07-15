import type {Rule} from "../engine";

const DEPRECATED = new Set([
    "BdApi.getData",
    "BdApi.setData",
    "BdApi.loadData",
    "BdApi.saveData",
]);

export const bdApiRule: Rule = {
    name: "bdapi-usage",

    match(node) {
        return (
            node.type === "CallExpression" &&
            node.callee?.type === "MemberExpression" &&
            node.callee.object?.type === "Identifier" &&
            node.callee.object.value === "BdApi"
        );
    },

    report(node, {file, plugin, getLoc}) {
        const prop = node.callee.property;
        const name =
            prop.type === "Identifier" ? prop.value :
                prop.type === "StringLiteral" ? prop.value :
                    null;

        if (!name) return null;

        const api = `BdApi.${name}`;
        const deprecated = DEPRECATED.has(api);

        return {
            rule: "bdapi-usage",
            file,
            plugin,
            message: deprecated
                ? `Deprecated API used: ${api}`
                : `BdApi call detected: ${api}`,
            category: deprecated ? "deprecated" : "api",
            severity: deprecated ? "warning" : "info",
            details: {api, deprecated},
            loc: getLoc(node),
        };
    }
};
