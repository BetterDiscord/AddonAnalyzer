import type {ESTree} from "meriyah";
import {Type} from "../../types";
import {calleeOf, memberChain, stripGlobal} from "../helpers";
import {type Rule} from "../types";


function isRequireCall(node: ESTree.Node): node is ESTree.CallExpression {
    if (node.type !== "CallExpression" || node.arguments.length === 0) return false;
    const chain = memberChain(calleeOf(node));
    return chain !== null && stripGlobal(chain).join(".") === "require";
}

// node:fs and fs are the same polyfill target
function moduleName(argument: ESTree.Node): string {
    if (argument.type === "Literal" && typeof argument.value === "string") {
        return argument.value.replace(/^node:/, "");
    }
    if (argument.type === "TemplateLiteral" && argument.expressions.length === 0) {
        return (argument.quasis[0]?.value.cooked ?? "").replace(/^node:/, "") || "(dynamic)";
    }
    return "(dynamic)";
}

export const requireRule: Rule = {
    name: "require",
    appliesTo: [Type.Plugin],

    match(node) {
        return isRequireCall(node);
    },

    report(node, context) {
        if (!isRequireCall(node)) return null;
        const module = moduleName(node.arguments[0]);

        return {
            rule: "require",
            file: context.file,
            message: `require("${module}") — served by the require polyfill`,
            category: "api",
            severity: "info",
            details: {module},
            loc: context.getLoc(node)
        };
    }
};
