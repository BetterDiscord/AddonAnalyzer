import type {ESTree} from "meriyah";


// meriyah types CallExpression.callee as `any`
export function calleeOf(node: ESTree.CallExpression | ESTree.NewExpression): ESTree.Node {
    return node.callee as ESTree.Node;
}

// Static name of a member access: foo.bar and foo["bar"] both yield "bar", dynamic keys yield null
export function propertyName(member: ESTree.MemberExpression): string | null {
    if (!member.computed && member.property.type === "Identifier") return member.property.name;
    if (member.property.type === "Literal" && typeof member.property.value === "string") return member.property.value;
    return null;
}

// Dotted path of a member chain, e.g. BdApi.Webpack.getModule -> ["BdApi", "Webpack", "getModule"].
// Dynamic segments become "*". Returns null unless the chain is rooted in a plain identifier.
export function memberChain(node: ESTree.Node): string[] | null {
    const parts: string[] = [];
    let current: ESTree.Node = node;

    while (current.type === "MemberExpression") {
        parts.unshift(propertyName(current) ?? "*");
        current = current.object;
    }

    if (current.type !== "Identifier") return null;
    parts.unshift(current.name);
    return parts;
}

// Drops a leading window./globalThis. so chains compare against their canonical root
export function stripGlobal(chain: string[]): string[] {
    return (chain[0] === "window" || chain[0] === "globalThis") ? chain.slice(1) : chain;
}

// Substitutes alias roots until a fixed point, e.g. with W -> ["BdApi", "Webpack"],
// ["W", "getModule"] resolves to ["BdApi", "Webpack", "getModule"]. Hop-limited against cycles.
export function resolveChain(chain: string[], aliases: ReadonlyMap<string, string[]>): string[] {
    let resolved = chain;
    for (let hops = 0; hops < 10; hops++) {
        const target = aliases.get(resolved[0]);
        if (!target || target[0] === resolved[0]) break;
        resolved = [...target, ...resolved.slice(1)];
    }
    return resolved;
}
