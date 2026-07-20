import type {ESTree} from "meriyah";
import {evalExpr} from "../../evaluator/core";
import {createScope} from "../../evaluator/model";
import {Type} from "../../types";
import {calleeOf, memberChain, resolveChain, stripGlobal} from "../helpers";
import {type Rule, type RuleContext} from "../types";


// Plugins doing by hand what BdApi offers. Same question createRoot-vs-render answers for React:
// is the API winning? The clearest pair is style injection — BdApi.DOM.addStyle/removeStyle vs a
// hand-rolled <style> element. This rule counts only the hand-rolled side; the BdApi.DOM.addStyle
// side is already counted by bdapi-usage, so the report reads the comparison number from there
// rather than double-counting it here.

// document.createElement("style") — the canonical raw <style> injection. Rooted at `document`
// (after window/globalThis stripping) so React's virtual createElement, e.g.
// BDFDB.ReactUtils.createElement("style", {...}), is NOT matched — that builds a React element,
// not a DOM node. `doc.createElement`/`context.document.createElement` (an iframe document held
// in a local) resolve to a different root and are undercounted, per undercount > miscount.
const CREATE_ELEMENT = "document.createElement";

function canonicalCallee(node: ESTree.CallExpression, context: RuleContext): string {
    const raw = memberChain(calleeOf(node));
    if (!raw) return "";
    return stripGlobal(resolveChain(stripGlobal(raw), context.aliases)).join(".");
}

export const rawDomRule: Rule = {
    name: "raw-dom",
    appliesTo: [Type.Plugin],

    match(node, context) {
        if (node.type !== "CallExpression") return false;
        if (canonicalCallee(node, context) !== CREATE_ELEMENT) return false;
        const first = node.arguments[0];
        if (!first || first.type === "SpreadElement") return false;
        const tag = evalExpr(first, createScope());
        return tag.kind === "string" && tag.value.toLowerCase() === "style";
    },

    report(node, context) {
        return {
            rule: "raw-dom",
            file: context.file,
            message: "Raw style injection: document.createElement(\"style\")",
            category: "api",
            severity: "info",
            details: {shape: "raw-style-element"},
            loc: context.getLoc(node)
        };
    }
};
