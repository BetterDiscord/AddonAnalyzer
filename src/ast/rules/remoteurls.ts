import type {ESTree} from "meriyah";
import {DYNAMIC_SEGMENT} from "../../evaluator/strings";
import {Type} from "../../types";
import {type Rule} from "../types";


const URL_PATTERN = /^https?:\/\//;

function extractUrl(node: ESTree.Node): {url: string, exact: boolean} | null {
    if (node.type === "Literal" && typeof node.value === "string" && URL_PATTERN.test(node.value)) {
        return {url: node.value, exact: true};
    }

    // Template literals keep dynamic segments as ${…} so the static host is still visible
    if (node.type === "TemplateLiteral" && URL_PATTERN.test(node.quasis[0]?.value.cooked ?? "")) {
        const url = node.quasis.map(q => q.value.cooked ?? q.value.raw).join(DYNAMIC_SEGMENT);
        return {url, exact: node.expressions.length === 0};
    }

    return null;
}

export const remoteUrlRule: Rule = {
    name: "remote-url",
    appliesTo: [Type.Plugin],

    match(node) {
        return extractUrl(node) !== null;
    },

    report(node, context) {
        const extracted = extractUrl(node);
        if (!extracted) return null;

        return {
            rule: "remote-url",
            file: context.file,
            message: `Remote URL detected: ${extracted.url}`,
            category: "network",
            severity: "info",
            details: {...extracted},
            loc: context.getLoc(node)
        };
    }
};
