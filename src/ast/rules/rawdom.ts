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

// document.createElement("style"|"script") — raw element injection. Rooted at `document`
// (after window/globalThis stripping) so React's virtual createElement, e.g.
// BDFDB.ReactUtils.createElement("style", {...}), is NOT matched — that builds a React element,
// not a DOM node. `doc.createElement`/`context.document.createElement` (an iframe document held
// in a local, or a minified module root like `n.default.document`) resolve to a different root
// and are undercounted, per undercount > miscount.
const CREATE_ELEMENT = "document.createElement";

// The two shapes classify differently: a raw <style> is a hand-rolled-vs-API story (Environment
// coupling card), a <script> element loads and executes code, so it reports as a security
// finding beside eval/Function/Worker. A Map because the key is source-derived (never an object
// literal: `"toString" in obj` is true through Object.prototype).
const TRACKED_TAGS = new Map<string, {shape: string, category: "api" | "security", severity: "info" | "warning", message: string}>([
    ["style", {shape: "raw-style-element", category: "api", severity: "info", message: "Raw style injection: document.createElement(\"style\")"}],
    ["script", {shape: "raw-script-element", category: "security", severity: "warning", message: "Script element creation: document.createElement(\"script\")"}],
]);

function trackedTag(node: ESTree.Node, context: RuleContext) {
    if (node.type !== "CallExpression") return null;
    const raw = memberChain(calleeOf(node));
    if (!raw) return null;
    if (stripGlobal(resolveChain(stripGlobal(raw), context.aliases)).join(".") !== CREATE_ELEMENT) return null;
    const first = node.arguments[0];
    if (!first || first.type === "SpreadElement") return null;
    const tag = evalExpr(first, createScope());
    if (tag.kind !== "string") return null;
    return TRACKED_TAGS.get(tag.value.toLowerCase()) ?? null;
}

export const rawDomRule: Rule = {
    name: "raw-dom",
    appliesTo: [Type.Plugin],

    match(node, context) {
        return trackedTag(node, context) !== null;
    },

    report(node, context) {
        const tracked = trackedTag(node, context);
        if (!tracked) return null;
        return {
            rule: "raw-dom",
            file: context.file,
            message: tracked.message,
            category: tracked.category,
            severity: tracked.severity,
            details: {shape: tracked.shape},
            loc: context.getLoc(node)
        };
    }
};
