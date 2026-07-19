import type {ESTree} from "meriyah";
import {Type} from "../../types";
import {type Rule} from "../types";


type Status = "deprecated" | "candidate" | "current";

/**
 * The v1-era plugin shape BD core still honors, and what it costs to keep honoring it.
 *
 * `deprecated` is only what BD has *actually* deprecated. `observer` and `onSwitch` are
 * removal candidates on the strength of these numbers, but calling them deprecated in the
 * report would publish a deprecation BD has not made — so they carry their own status.
 *
 * Where core honors them (modules/pluginmanager.ts): the get-family at :127-130, `load` at
 * :143, `onSwitch` on the navigate event at :225-238, `observer` at :45 + :250, `start`/`stop`
 * at :174/:203. Every tracked name must be one core actually dispatches — `unload` was never
 * one (it appears nowhere in core), which is why it is deliberately absent here.
 *
 * A Map, not an object literal: plugins really do define `toString()`, and `"toString" in
 * {...}` is true through Object.prototype, which quietly made every such plugin report a
 * lifecycle member whose status was Function.prototype.toString.
 */
const MEMBERS = new Map<string, Status>(Object.entries({
    // Superseded by the meta block: BD reads @name/@author/@version/@description and only
    // falls back to these overrides if the instance defines them.
    getName: "deprecated",
    getAuthor: "deprecated",
    getVersion: "deprecated",
    getDescription: "deprecated",

    // Core runs a document-wide MutationObserver and dispatches every mutation to every
    // loaded plugin, so this one's cost is paid by all users to serve its definers.
    observer: "candidate",
    onSwitch: "candidate",

    // Redundant since a plugin's code already runs at require/eval time and in its
    // constructor, so anything `load` does can move there — but many plugins never migrated.
    // Still dispatched by core (:143), hence a candidate rather than deprecated.
    load: "candidate",

    start: "current",
    stop: "current",
    getSettingsPanel: "current"
} as Record<string, Status>));

// Null for anything that isn't a plain literal name: computed keys, and `#private` methods,
// which are unreachable from BD's `plugin.observer(...)` dispatch by definition
function keyName(key: ESTree.PrivateIdentifier | ESTree.Expression | null, computed: boolean): string | null {
    if (!key || computed) return null;
    if (key.type === "Identifier") return key.name;
    if (key.type === "Literal" && typeof key.value === "string") return key.value;
    return null;
}

/**
 * The tracked member a node *defines*, or null.
 *
 * Definition sites only — a definition is the thing BD dispatches to, and call sites are a
 * different question entirely. `getName` is the case that proves it: `grep -l getName`
 * finds 66 plugins, but 11 of those are `.getName()` calls on Discord modules, which are
 * not plugin lifecycle at all.
 *
 * The shape also excludes the dominant false positive by construction: `observer` is the
 * usual local name for a MutationObserver, but `this.observer = new MutationObserver(...)`
 * is a property *assignment*, not a method definition, so it never reaches here.
 */
function definedMember(node: ESTree.Node): string | null {
    // class Plugin { start() {} }
    if (node.type === "MethodDefinition") {
        if (node.kind !== "method" || node.static) return null;
        return keyName(node.key, node.computed);
    }

    // module.exports = {start: function() {}, stop: () => {}}
    if (node.type === "Property") {
        // `kind` must be checked before the value: an object-literal accessor (`get observer()
        // {return this._observer ??= new MutationObserver(...)}`) also holds a FunctionExpression,
        // but BD sees the *returned* value, so `typeof plugin.observer` is "object" and BD never
        // calls it. That is the MutationObserver collision again, wearing a getter — and it is
        // real: it costs programmer2514/CollapsibleUI a false `observer` without this check.
        if (node.kind !== "init") return null;
        const value = node.value;
        if (value.type !== "FunctionExpression" && value.type !== "ArrowFunctionExpression") return null;
        return keyName(node.key, node.computed);
    }

    return null;
}

export const lifecycleRule: Rule = {
    name: "lifecycle",
    appliesTo: [Type.Plugin],

    match(node) {
        const member = definedMember(node);
        return member !== null && MEMBERS.has(member);
    },

    report(node, context) {
        const member = definedMember(node);
        if (!member) return null;
        const status = MEMBERS.get(member);
        if (!status) return null;

        return {
            rule: "lifecycle",
            file: context.file,
            message: status === "deprecated"
                ? `Deprecated plugin lifecycle member: ${member}`
                : `Plugin lifecycle member: ${member}`,
            category: status === "deprecated" ? "deprecated" : "api",
            severity: status === "deprecated" ? "warning" : "info",
            details: {member, status},
            loc: context.getLoc(node)
        };
    }
};

// Lets the report label rows given only a member name from the summary
export function lifecycleStatus(member: string): Status {
    return MEMBERS.get(member) ?? "current";
}
