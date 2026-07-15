import type {ESTree} from "meriyah";
import {calleeOf} from "../helpers";
import {Type} from "../../types";
import {type Rule} from "../types";


function dynamicCodeKind(node: ESTree.Node): string | null {
    if (node.type !== "CallExpression" && node.type !== "NewExpression") return null;
    const callee = calleeOf(node);
    if (callee.type !== "Identifier") return null;
    if (callee.name === "eval" && node.type === "CallExpression") return "eval";
    if (callee.name === "Function") return "Function";
    return null;
}

export const evalRule: Rule = {
    name: "eval",
    appliesTo: [Type.Plugin],

    match(node) {
        return dynamicCodeKind(node) !== null;
    },

    report(node, context) {
        const kind = dynamicCodeKind(node);
        if (!kind) return null;

        return {
            rule: "eval",
            file: context.file,
            message: `Dynamic code execution via ${kind}`,
            category: "security",
            severity: "error",
            details: {kind},
            loc: context.getLoc(node)
        };
    }
};
