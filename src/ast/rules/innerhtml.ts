import type {Rule} from "../engine";

export const innerHTMLRule: Rule = {
    name: "innerHTML",

    match(node) {
        return (
            node.type === "AssignmentExpression" &&
            node.left?.type === "MemberExpression" &&
            node.left.property?.type === "Identifier" &&
            node.left.property.value === "innerHTML"
        );
    },

    report(node, {file, plugin, getLoc}) {
        return {
            rule: "innerHTML",
            file,
            plugin,
            message: "Direct innerHTML assignment detected",
            category: "security",
            severity: "warning",
            details: {
                assignment: true,
            },
            loc: getLoc(node),
        };
    }
};
