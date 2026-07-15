export interface PEScope {
    bindings: Map<string, PEValue>;
    parent?: PEScope;
}

export function createScope(parent?: PEScope): PEScope {
    return {bindings: new Map(), parent};
}

export function getBinding(scope: PEScope, name: string): PEValue {
    let cur: PEScope | undefined = scope;
    while (cur) {
        const v = cur.bindings.get(name);
        if (v) return v;
        cur = cur.parent;
    }
    return Unknown;
}

export function setBinding(scope: PEScope, name: string, value: PEValue) {
    scope.bindings.set(name, value);
}
