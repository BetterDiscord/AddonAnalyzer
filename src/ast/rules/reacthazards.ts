import type {ESTree} from "meriyah";
import {Type} from "../../types";
import {calleeOf, memberChain, resolveChain, stripGlobal} from "../helpers";
import {type Rule, type RuleContext} from "../types";


// Legacy ReactDOM entry points; render/findDOMNode/unmountComponentAtNode were removed
// in React 19, hydrate in 18. These break first when Discord bumps React.
const HAZARDS = new Set(["render", "findDOMNode", "unmountComponentAtNode", "hydrate"]);

// The segment that must own the method. Matching on the segment rather than the whole
// chain covers every way ReactDOM is reached: bare `ReactDOM.render` (webpack-obtained),
// `BdApi.ReactDOM.render`, and library-held ones like BDFDB's
// `Internal.LibraryModules.ReactDOM.render` — all of them are the real ReactDOM.
const OWNER = "ReactDOM";

// BD's own internal-instance accessors — same story, they track React's internals
const INTERNALS = new Set(["BdApi.getInternalInstance", "BdApi.ReactUtils.getInternalInstance"]);

// Counted as the healthy signal rather than a hazard: the React 18+ root API
const ADOPTION = new Set(["createRoot"]);

// Lets the report split hazards from adoption given only a method name from the summary
export function isHazardMethod(method: string): boolean {
    return !ADOPTION.has(method);
}

interface Target {method: string; chain: string; hazard: boolean;}

/**
 * Resolves a member expression to a tracked React entry point.
 *
 * The `shadowed` guard matters because `ReactDOM` is an ordinary local name: a param or
 * catch binding called ReactDOM is not React's. Note this checks `shadowed` but NOT
 * `declared` (as the globals rule does), because a file-local *declaration* is exactly
 * how a real ReactDOM arrives — `const ReactDOM = BdApi.Webpack.getModule(...)` — so
 * treating declarations as disqualifying would drop the main case this rule exists for.
 */
function reactTarget(node: ESTree.Node, context: RuleContext): Target | null {
    const raw = memberChain(node);
    if (!raw) return null;

    const resolved = stripGlobal(resolveChain(stripGlobal(raw), context.aliases));
    if (resolved.length < 2 || context.shadowed.has(resolved[0])) return null;

    const chain = resolved.join(".");
    const method = resolved[resolved.length - 1];
    if (INTERNALS.has(chain)) return {method, chain, hazard: true};

    if (resolved[resolved.length - 2] !== OWNER) return null;
    if (HAZARDS.has(method)) return {method, chain, hazard: true};
    if (ADOPTION.has(method)) return {method, chain, hazard: false};

    return null;
}

export const reactHazardsRule: Rule = {
    name: "react-hazards",
    appliesTo: [Type.Plugin],

    match(node, context, parent) {
        // Outermost link only, so a chain reports once
        if (node.type === "MemberExpression") {
            if (parent?.type === "MemberExpression" && parent.object === node) return false;
            return reactTarget(node, context) !== null;
        }

        // Destructured methods (`const {createRoot} = ReactDOM; createRoot(el)`), which the
        // alias tracker resolves back to the owner. Restricted to call sites so the binding
        // site itself isn't counted as a second usage.
        if (node.type === "Identifier") {
            if (parent?.type !== "CallExpression" || calleeOf(parent) !== node) return false;
            return reactTarget(node, context) !== null;
        }

        return false;
    },

    report(node, context) {
        const target = reactTarget(node, context);
        if (!target) return null;

        return {
            rule: "react-hazards",
            file: context.file,
            message: target.hazard
                ? `React-upgrade hazard: ${target.chain}`
                : `Modern React root API: ${target.chain}`,
            category: target.hazard ? "deprecated" : "api",
            severity: target.hazard ? "warning" : "info",
            details: {method: target.method, chain: target.chain, hazard: target.hazard},
            loc: context.getLoc(node)
        };
    }
};
