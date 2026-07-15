import type * as swc from "@swc/core";

export function evalExpr(node: swc.Expression, scope: PEScope): PEValue {
    switch (node.type) {
        case "StringLiteral":
            return {kind: "string", value: node.value};

        case "NumericLiteral":
            return {kind: "number", value: node.value};

        case "BooleanLiteral":
            return {kind: "boolean", value: node.value};

        case "Identifier":
            return getBinding(scope, node.value);

        case "TemplateLiteral": {
            let out = "";
            for (let i = 0; i < node.quasis.length; i++) {
                const q = node.quasis[i];
                out += q.cooked ?? q.raw ?? "";
                const expr = node.expressions[i];
                if (expr) {
                    const v = evalExpr(expr as swc.Expression, scope);
                    if (v.kind !== "string" && v.kind !== "number" && v.kind !== "boolean") {
                        return Unknown;
                    }
                    out += String(v.value);
                }
            }
            return {kind: "string", value: out};
        }

        case "BinaryExpression": {
            if (node.operator !== "+") return Unknown;
            const left = evalExpr(node.left as swc.Expression, scope);
            const right = evalExpr(node.right as swc.Expression, scope);
            if (left.kind === "unknown" || right.kind === "unknown") return Unknown;

            // string concatenation or numeric addition
            if (left.kind === "string" || right.kind === "string") {
                return {kind: "string", value: String(left.value) + String(right.value)};
            }
            if (left.kind === "number" && right.kind === "number") {
                return {kind: "number", value: left.value + right.value};
            }
            return Unknown;
        }

        case "ObjectExpression": {
            const obj: Record<string, PEValue> = {};
            for (const prop of node.properties) {
                if (prop.type !== "KeyValueProperty") return Unknown;
                const keyNode = prop.key;
                let key: string | null = null;

                if (keyNode.type === "Identifier") key = keyNode.value;
                else if (keyNode.type === "StringLiteral") key = keyNode.value;
                else return Unknown;

                const val = evalExpr(prop.value as swc.Expression, scope);
                if (isUnknown(val)) return Unknown;
                obj[key] = val;
            }
            return {kind: "object", value: obj};
        }

        case "MemberExpression": {
            // obj.prop or obj["prop"]
            const objVal = evalExpr(node.object as swc.Expression, scope);
            if (objVal.kind !== "object") return Unknown;

            let key: string | null = null;
            if (node.property.type === "Identifier") key = node.property.value;
            else if (node.property.type === "StringLiteral") key = node.property.value;
            else return Unknown;

            const v = objVal.value[key];
            return v ?? Unknown;
        }

        default:
            return Unknown;
    }
}


export function evalVarDecl(decl: swc.VariableDeclaration, scope: PEScope) {
    for (const d of decl.declarations) {
        if (!d.id || d.id.type !== "Identifier" || !d.init) continue;
        const name = d.id.value;
        const value = evalExpr(d.init as swc.Expression, scope);
        if (!isUnknown(value)) {
            setBinding(scope, name, value);
        }
    }
}
