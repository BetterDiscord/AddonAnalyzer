import type {Rule} from "../engine";

export const evalRule: Rule = {
    name: "eval",

    match(node) {
        return (
            node.type === "CallExpression" &&
            node.callee?.type === "Identifier" &&
            node.callee.value === "eval"
        );
    },

    report(node, {file, plugin, getLoc}) {
        return {
            rule: "eval",
            file,
            plugin,
            message: "Use of eval detected",
            category: "security",
            severity: "error",
            details: {},
            loc: getLoc(node),
        };
    }
};
