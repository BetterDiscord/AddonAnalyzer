import type {ESTree} from "meriyah";


function hasKey<T extends object>(
    obj: T,
    key: PropertyKey
): obj is T & Record<PropertyKey, unknown> {
    return key in obj;
}


export function walk(node: ESTree.Node, visit: (n: ESTree.Node, parent: ESTree.Node | null) => void) {
    const stack: Array<{node: ESTree.Node; parent: ESTree.Node | null;}> = [{node, parent: null}];

    while (stack.length) {
        const {node: cur, parent} = stack.pop()!;
        if (!cur || typeof cur !== "object") continue;

        visit(cur, parent);

        for (const key of Object.keys(cur)) {
            if (!hasKey(cur, key)) continue;
            const val = cur[key];
            if (Array.isArray(val)) {
                for (const child of val) {
                    if (child && typeof child === "object") {
                        stack.push({node: child as ESTree.Node, parent: cur});
                    }
                }
            }
            else if (val && typeof val === "object") {
                stack.push({node: val as ESTree.Node, parent: cur});
            }
        }
    }
}
