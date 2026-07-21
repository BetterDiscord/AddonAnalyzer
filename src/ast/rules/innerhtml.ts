import type {ESTree} from "meriyah";
import {calleeOf, propertyName} from "../helpers";
import {Type} from "../../types";
import {type Rule} from "../types";


const SINK_PROPERTIES = new Set(["innerHTML", "outerHTML"]);

// React's HTML sink is a prop name, not a member write. The name alone is the contract —
// React reads it wherever it appears — so the only receiver check possible is the node
// shape: an init property in an object *expression*. ObjectPattern also produces Property
// nodes (`const {dangerouslySetInnerHTML} = props` reads the prop rather than setting it),
// which is why the parent matters.
function isDangerousProp(node: ESTree.Node, parent: ESTree.Node | null): boolean {
    if (node.type !== "Property" || node.kind !== "init") return false;
    if (parent?.type !== "ObjectExpression") return false;
    const key = node.key;
    if (key.type === "Identifier") return key.name === "dangerouslySetInnerHTML";
    if (key.type === "Literal") return key.value === "dangerouslySetInnerHTML";
    return false;
}

function htmlSink(node: ESTree.Node, parent: ESTree.Node | null): string | null {
    if (node.type === "AssignmentExpression" && node.left.type === "MemberExpression") {
        const name = propertyName(node.left);
        if (name && SINK_PROPERTIES.has(name)) return name;
    }
    if (node.type === "CallExpression") {
        const callee = calleeOf(node);
        if (callee.type === "MemberExpression" && propertyName(callee) === "insertAdjacentHTML") return "insertAdjacentHTML";
    }
    if (isDangerousProp(node, parent)) return "dangerouslySetInnerHTML";
    return null;
}

export const innerHTMLRule: Rule = {
    name: "innerHTML",
    appliesTo: [Type.Plugin],

    match(node, _context, parent) {
        return htmlSink(node, parent) !== null;
    },

    report(node, context, parent) {
        const sink = htmlSink(node, parent);
        if (!sink) return null;

        return {
            rule: "innerHTML",
            file: context.file,
            message: sink === "insertAdjacentHTML" || sink === "dangerouslySetInnerHTML"
                ? `HTML injection via ${sink}`
                : `Direct ${sink} assignment detected`,
            category: "security",
            severity: "warning",
            details: {sink},
            loc: context.getLoc(node)
        };
    }
};
