import {type PEValue, Unknown} from "./types";

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

// Assignment rebinds where the name was declared, falling back to the current scope
export function assignBinding(scope: PEScope, name: string, value: PEValue) {
    let cur: PEScope | undefined = scope;
    while (cur) {
        if (cur.bindings.has(name)) {
            cur.bindings.set(name, value);
            return;
        }
        cur = cur.parent;
    }
    scope.bindings.set(name, value);
}
