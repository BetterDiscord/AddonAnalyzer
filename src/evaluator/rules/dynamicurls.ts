import type {Rule} from "../engine";
import {evalExpr, createScope, PEValue} from "./partialEval";

export const dynamicUrlRule: Rule = {
    name: "dynamic-url",

    match(node) {
        return (
            node.type === "CallExpression" &&
            node.callee.type === "Identifier" &&
            node.callee.value === "fetch" &&
            node.arguments.length > 0
        );
    },

    report(node, {file, plugin, getLoc, scope}) {
        const arg = node.arguments[0]?.expression;
        if (!arg) return null;

        const v = evalExpr(arg as any, scope);
        if (v.kind === "string" && /^https?:\/\//.test(v.value)) {
            return {
                rule: "dynamic-url",
                file,
                plugin,
                message: `Resolved remote URL: ${v.value}`,
                category: "network",
                severity: "info",
                details: {url: v.value, resolved: true},
                loc: getLoc(node),
            };
        }

        return null;
    }
};
