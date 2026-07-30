import type {ESTree} from "meriyah";
import {calleeOf, memberChain, resolveChain, stripGlobal} from "../helpers";
import {Type} from "../../types";
import {type Rule, type RuleContext} from "../types";


/**
 * Canonical name of a dynamic-code sink, or null.
 *
 * The callee is resolved the same way every other call-site rule resolves one, so
 * `window.eval(src)` and `const F = Function; F(src)` count alongside the bare forms.
 * Both roots are ordinary shadowable names — `function f(Function) {...}` — so a
 * shadowed root disqualifies, matching `react-hazards`. `declared` is deliberately
 * NOT checked: `const Function = ...` at file scope is not a thing real code does,
 * while `const F = Function` (a declaration of the alias) is exactly what should match.
 */
function dynamicCodeKind(node: ESTree.Node, context: RuleContext): string | null {
    if (node.type !== "CallExpression" && node.type !== "NewExpression") return null;

    const raw = memberChain(calleeOf(node));
    if (!raw) return null;

    const resolved = stripGlobal(resolveChain(stripGlobal(raw), context.aliases));
    if (resolved.length !== 1 || context.shadowed.has(resolved[0])) return null;

    // `new eval()` is a TypeError, so eval only counts as a call
    if (resolved[0] === "eval" && node.type === "CallExpression") return "eval";
    if (resolved[0] === "Function") return "Function";
    // A worker script is fetched and executed, so it belongs with the code sinks; `Worker(...)`
    // without `new` throws, and bundled gif.js code aliases the name (Worker2, GifWorker), which
    // the exact-name match already excludes
    if (resolved[0] === "Worker" && node.type === "NewExpression") return "Worker";
    return null;
}

export const evalRule: Rule = {
    name: "eval",
    appliesTo: [Type.Plugin],

    match(node, context) {
        return dynamicCodeKind(node, context) !== null;
    },

    report(node, context) {
        const kind = dynamicCodeKind(node, context);
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
