import type {ESTree} from "meriyah";
import {Type} from "../../types";
import {memberChain, resolveChain, stripGlobal} from "../helpers";
import {type Rule, type RuleContext} from "../types";


// Plugins split into "call BdApi directly" and "call a library that calls BdApi". Only the
// first kind is measured accurately by every other rule in the repo — a plugin built on BDFDB
// or ZeresPluginLibrary routes its Discord access through the library object, so webpack-targets,
// patcher-targets, bdapi-usage and react-hazards attribute that usage to the library, not the
// plugin. This rule sizes that blind spot by counting the dependents themselves.
//
// The signal is a *global read* off the library object, NOT a string mention: every DevilBro
// plugin names "BDFDB" in changelog prose, and four ex-Zeres plugins carry "no longer relies on
// ZeresPluginLibrary!" changelogs — text grep counts those as dependents, which is exactly the
// trap this rule avoids. `Plugins.get("ZeresPluginLibrary")` (a delete-it warning) is a string
// argument too, so it is likewise not a read and correctly excluded.

// Global object names that are the library, mapped to its canonical name. ZLibrary /
// PluginLibrary / 0PluginLibrary are all the same deprecated library as ZeresPluginLibrary
// (maintainer, 2026-07) and report under the one canonical name. BDFDB is reached two ways:
// the `window.BDFDB_Global` object (the reliable signal — every dependent reads it) and the
// bare `BDFDB` closure parameter the DevilBro wrapper injects (which is a shadowed local, so
// the guards below drop it — BDFDB_Global carries the detection). `0PluginLibrary` is not a
// valid identifier so it can only be a filename/string, never a global root.
const LIBRARY_GLOBALS = new Map<string, string>([
    ["BDFDB", "BDFDB"],
    ["BDFDB_Global", "BDFDB"],
    ["ZeresPluginLibrary", "ZeresPluginLibrary"],
    ["ZLibrary", "ZeresPluginLibrary"],
    ["PluginLibrary", "ZeresPluginLibrary"],
]);

// The library's own store files must not count as dependents of themselves (handoff-06 trap):
// 0BDFDB.plugin.js reads window.BDFDB_Global throughout because it *is* BDFDB. The Zeres files
// are not in the store corpus, but exclude their names defensively for when they are.
const LIBRARY_FILES = new Set(["0BDFDB.plugin.js", "0PluginLibrary.plugin.js", "ZeresPluginLibrary.plugin.js"]);

// `global`/`self` are not stripped by stripGlobal (only window/globalThis are), but a library
// reached as `global.ZeresPluginLibrary` is the same global. Peel them here after guarding.
const GLOBAL_ROOTS = new Set(["global", "self"]);

interface LibraryUse {library: string; root: string;}

/**
 * Resolves a member expression to a read off a known library global, or null.
 *
 * Guards on the outer root the way `globals` does (both `declared` and `shadowed`), because
 * every library name here can plausibly be a local: `const Library = ...`, or the `BDFDB`
 * closure parameter. A file that binds the root locally is not reading the global, so it is
 * dropped rather than guessed at — undercount over miscount, per the repo's alias philosophy.
 */
function libraryUse(node: ESTree.Node, context: RuleContext): LibraryUse | null {
    const raw = memberChain(node);
    if (!raw) return null;

    const resolved = stripGlobal(resolveChain(stripGlobal(raw), context.aliases));
    const outer = resolved[0];
    if (context.declared.has(outer) || context.shadowed.has(outer)) return null;

    // Only MemberExpressions reach here, so a length-1 resolved chain always came from a
    // window./global. wrapper (`window.BDFDB_Global`, `!global.ZeresPluginLibrary`) — the
    // bootstrap-guard shape, which reads the library object with no further property. Keep it.
    const chain = GLOBAL_ROOTS.has(outer) ? resolved.slice(1) : resolved;
    const root = chain[0];
    if (!root) return null;

    const library = LIBRARY_GLOBALS.get(root);
    if (!library) return null;
    if (context.declared.has(root) || context.shadowed.has(root)) return null;

    return {library, root};
}

// A read sitting in a boolean-test position is the bootstrap guard (`if (!global.ZeresPluginLibrary)`,
// `!window.BDFDB_Global`) — the plugin declaring the dependency. Any other read is active use.
function signalFor(node: ESTree.Node, parent: ESTree.Node | null): "guard" | "read" {
    if (!parent) return "read";
    if (parent.type === "UnaryExpression" && parent.operator === "!") return "guard";
    if (parent.type === "IfStatement" && parent.test === node) return "guard";
    if (parent.type === "ConditionalExpression" && parent.test === node) return "guard";
    if (parent.type === "WhileStatement" && parent.test === node) return "guard";
    return "read";
}

export const libraryDepsRule: Rule = {
    name: "library-deps",
    appliesTo: [Type.Plugin],

    match(node, context, parent) {
        if (LIBRARY_FILES.has(context.file)) return false;
        // Outermost link only, so a chain reports once
        if (node.type !== "MemberExpression") return false;
        if (parent?.type === "MemberExpression" && parent.object === node) return false;
        return libraryUse(node, context) !== null;
    },

    report(node, context, parent) {
        const use = libraryUse(node, context);
        if (!use) return null;

        const signal = signalFor(node, parent);
        return {
            rule: "library-deps",
            file: context.file,
            message: `Library dependency (${signal}): ${use.library} via ${use.root}`,
            category: "api",
            severity: "info",
            details: {library: use.library, signal, root: use.root},
            loc: context.getLoc(node)
        };
    }
};
