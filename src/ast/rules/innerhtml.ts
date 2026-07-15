import type {ESTree} from "meriyah";
import {calleeOf, propertyName} from "../helpers";
import {AddonType, type Rule} from "../types";


const SINK_PROPERTIES = new Set(["innerHTML", "outerHTML"]);

function htmlSink(node: ESTree.Node): string | null {
    if (node.type === "AssignmentExpression" && node.left.type === "MemberExpression") {
        const name = propertyName(node.left);
        if (name && SINK_PROPERTIES.has(name)) return name;
    }
    if (node.type === "CallExpression") {
        const callee = calleeOf(node);
        if (callee.type === "MemberExpression" && propertyName(callee) === "insertAdjacentHTML") return "insertAdjacentHTML";
    }
    return null;
}

export const innerHTMLRule: Rule = {
    name: "innerHTML",
    appliesTo: [AddonType.Plugin],

    match(node) {
        return htmlSink(node) !== null;
    },

    report(node, context) {
        const sink = htmlSink(node);
        if (!sink) return null;

        return {
            rule: "innerHTML",
            file: context.file,
            message: sink === "insertAdjacentHTML"
                ? "HTML injection via insertAdjacentHTML"
                : `Direct ${sink} assignment detected`,
            category: "security",
            severity: "warning",
            details: {sink},
            loc: context.getLoc(node)
        };
    }
};
