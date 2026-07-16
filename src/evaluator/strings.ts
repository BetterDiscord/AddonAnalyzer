import type {ESTree} from "meriyah";
import {evalExpr} from "./core";
import type {PEScope} from "./model";


// Stands in for a segment that only exists at runtime, so a static prefix still survives
// eslint-disable-next-line no-template-curly-in-string
export const DYNAMIC_SEGMENT = "${…}";

export interface PartialString {
    text: string;

    // False once any segment degraded to DYNAMIC_SEGMENT
    exact: boolean;
}

// Best-effort string of an expression: unknown segments become ${…} so a static
// host prefix survives even when the path is computed at runtime
export function partialString(node: ESTree.Node, scope: PEScope): PartialString | null {
    const value = evalExpr(node, scope);
    if (value.kind === "string") return {text: value.value, exact: true};
    if (value.kind === "number" || value.kind === "boolean") return {text: String(value.value), exact: true};

    if (node.type === "TemplateLiteral") {
        let text = "";
        let exact = true;
        for (let i = 0; i < node.quasis.length; i++) {
            text += node.quasis[i].value.cooked ?? node.quasis[i].value.raw;
            const expression = node.expressions[i];
            if (expression) {
                const part = partialString(expression, scope);
                if (part) {
                    text += part.text;
                    exact &&= part.exact;
                }
                else {
                    text += DYNAMIC_SEGMENT;
                    exact = false;
                }
            }
        }
        return {text, exact};
    }

    if (node.type === "BinaryExpression" && node.operator === "+") {
        const left = partialString(node.left, scope);
        if (!left) return null;
        const right = partialString(node.right, scope) ?? {text: DYNAMIC_SEGMENT, exact: false};
        return {text: left.text + right.text, exact: left.exact && right.exact};
    }

    return null;
}
