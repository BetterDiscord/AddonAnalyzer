/**
 * BdApi's declared public surface, and the classification of observed usage against it.
 *
 * This is the only place the analyzer knows what BD's API *is* rather than what addons
 * *use*, which is what makes "what can be deleted" answerable. The manifest is checked in
 * and generated offline by `scripts/surface.ts` from a BD checkout — the analyzer never
 * reads BD core, so CI needs no checkout and a stale manifest degrades gracefully.
 */

import raw from "./data/bdapi-surface.json";


export interface SurfaceNamespace {
    // BD class(es) behind the exposed name; both `Patcher` and `BoundPatcher` back `BdApi.Patcher`
    classes: string[];

    // True for names that are not BD-defined classes (React, ReactDOM, version). Their
    // members belong to Discord or are primitives, so they are never enumerated and
    // nothing under them can be judged unused or phantom.
    opaque: boolean;

    // Instance members, dotted one level deep for object-literal fields (`Filters.byKeys`)
    members: string[];
    deprecated: string[];
}

export interface Surface {
    source: {version: string, commit: string, generated: string};
    namespaces: Record<string, SurfaceNamespace>;
}

export const surface: Surface = raw;

// Chains reported by the bdapi-usage rule use "*" for a segment the AST cannot resolve
// (`W[name]()`); nothing about such a chain can be classified either way.
const DYNAMIC = "*";

/** Every declared API path, as the addon-facing chain: `BdApi.Webpack.getProxy`. */
export function declaredPaths(): Array<{path: string, namespace: string, member: string, deprecated: boolean}> {
    const paths: Array<{path: string, namespace: string, member: string, deprecated: boolean}> = [];
    for (const [namespace, ns] of Object.entries(surface.namespaces)) {
        // An opaque namespace is itself the smallest removable unit — there is no member
        // list to prune within `BdApi.version`.
        if (!ns.members.length) {
            paths.push({path: `BdApi.${namespace}`, namespace, member: "", deprecated: false});
            continue;
        }
        for (const member of ns.members) {
            paths.push({path: `BdApi.${namespace}.${member}`, namespace, member, deprecated: ns.deprecated.includes(member)});
        }
    }
    return paths;
}

/** Deprecated API paths as marked by `@deprecated` in BD core. */
export function deprecatedPaths(): string[] {
    return declaredPaths().filter(p => p.deprecated).map(p => p.path);
}

/**
 * Whether a declared path is exercised by an observed usage chain. Deeper chains count:
 * `BdApi.Webpack.Stores.UserStore` uses `BdApi.Webpack.Stores`, and dropping the member
 * would break it.
 */
function covers(usage: string, path: string): boolean {
    return usage === path || usage.startsWith(`${path}.`);
}

/** Declared paths that no observed chain touches — the removal shortlist. */
export function unusedPaths(used: Iterable<string>): Array<{path: string, namespace: string, member: string, deprecated: boolean}> {
    const chains = [...used];
    return declaredPaths().filter(p => !chains.some(chain => covers(chain, p.path)));
}

/**
 * The path an observed chain calls that BD core does not declare, or null when the chain
 * is fine (or unclassifiable).
 *
 * Judgement stops at the first segment below the namespace. `BdApi.Webpack.Filters.byX`
 * with an unknown `byX` reports nothing: `Filters` is real, and the manifest only records
 * one level of nesting, so a deeper miss is a limit of the manifest rather than evidence
 * about BD.
 */
export function phantomPath(chain: string): string | null {
    const segments = chain.split(".");
    if (segments[0] !== "BdApi" || segments.length < 2) return null;

    const [, namespace, member] = segments;
    if (namespace === DYNAMIC) return null;

    const ns = surface.namespaces[namespace];
    if (!ns) return `BdApi.${namespace}`;

    if (ns.opaque || !member || member === DYNAMIC) return null;
    if (ns.members.some(m => m === member || m.startsWith(`${member}.`))) return null;

    return `BdApi.${namespace}.${member}`;
}
