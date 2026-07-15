import type {ESTree} from "meriyah";
import {Type} from "../../types";
import {memberChain, resolveChain, stripGlobal} from "../helpers";
import {type Rule, type RuleContext} from "../types";


// Roots of the bridged/polyfilled environment. The `require` rule covers require();
// these are the globals plugins reach for directly. DiscordNative is Discord's own
// native bridge rather than a BD polyfill, but it retires the same way.
const ROOTS = new Set(["process", "Buffer", "__dirname", "__filename", "global", "DiscordNative"]);

/**
 * Root plus at most one segment of a tracked global: `process.env`,
 * `DiscordNative.clipboard`, bare `__dirname`. Deeper segments are noise.
 *
 * Unlike `BdApi`, every one of these is a plausible local name, so a file that binds
 * the root anywhere — `function f(process)`, `const global = {}` — makes every
 * reference to it untrustworthy and the whole file's hits for that root are dropped.
 * The tracker is scope-blind, so this undercounts rather than guesses.
 */
function canonical(node: ESTree.Node, context: RuleContext): string[] | null {
    const raw = memberChain(node);
    if (!raw) return null;

    const resolved = stripGlobal(resolveChain(stripGlobal(raw), context.aliases));
    const root = resolved[0];
    if (!ROOTS.has(root)) return null;
    if (context.declared.has(root) || context.shadowed.has(root)) return null;

    return resolved.slice(0, 2);
}

// True when an identifier is a real reference rather than a binding site or a
// property/key that merely shares the name (`obj.process`, `{process: 1}`).
function isReference(node: ESTree.Node, parent: ESTree.Node | null): boolean {
    if (!parent) return true;
    switch (parent.type) {
        // The object side is reported by the MemberExpression branch; the property side
        // (`foo.process`) is not a root at all.
        case "MemberExpression":
            return false;
        case "Property":
            return parent.computed || parent.value === node;
        case "VariableDeclarator":
            return parent.id !== node;
        case "MethodDefinition":
        case "PropertyDefinition":
            return parent.computed || parent.key !== node;
        // Params and ids are bindings. An arrow's expression body is the one child of
        // these nodes that is a genuine reference (`() => process`).
        case "ArrowFunctionExpression":
            return parent.body === node;
        case "FunctionDeclaration":
        case "FunctionExpression":
        case "ClassDeclaration":
        case "ClassExpression":
        case "CatchClause":
            return false;
        case "LabeledStatement":
        case "BreakStatement":
        case "ContinueStatement":
            return false;
        default:
            return true;
    }
}

export const globalsRule: Rule = {
    name: "globals",
    appliesTo: [Type.Plugin],

    match(node, context, parent) {
        // Outermost link only, so process.env.NODE_ENV reports once
        if (node.type === "MemberExpression") {
            if (parent?.type === "MemberExpression" && parent.object === node) return false;
            return canonical(node, context) !== null;
        }
        // Bare references: __dirname, `typeof process`, `new Buffer()`
        if (node.type === "Identifier") {
            return isReference(node, parent) && canonical(node, context) !== null;
        }
        return false;
    },

    report(node, context) {
        const chain = canonical(node, context);
        if (!chain) return null;
        const name = chain.join(".");

        return {
            rule: "globals",
            file: context.file,
            message: `Node/Electron environment access: ${name}`,
            category: "api",
            severity: "info",
            details: {global: name, root: chain[0]},
            loc: context.getLoc(node)
        };
    }
};
