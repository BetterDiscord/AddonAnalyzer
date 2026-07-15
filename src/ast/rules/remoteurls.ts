import type {Rule} from "../engine";

export const remoteUrlRule: Rule = {
    name: "remote-url",

    match(node) {
        return (
            node.type === "StringLiteral" &&
            /^https?:\/\//.test(node.value)
        );
    },

    report(node, {file, plugin, getLoc}) {
        return {
            rule: "remote-url",
            file,
            plugin,
            message: `Remote URL detected: ${node.value}`,
            category: "network",
            severity: "info",
            details: {
                url: node.value,
            },
            loc: getLoc(node),
        };
    }
};
