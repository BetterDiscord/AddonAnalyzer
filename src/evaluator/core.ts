import type {ESTree} from "meriyah";
import {calleeOf, propertyName} from "../ast/helpers";
import {getBinding, type PEScope} from "./model";
import {Unknown, type PEValue} from "./types";


const str = (value: string): PEValue => ({kind: "string", value});
const num = (value: number): PEValue => ({kind: "number", value});
const bool = (value: boolean): PEValue => ({kind: "boolean", value});

function toStringValue(value: PEValue): string | null {
    if (value.kind === "string") return value.value;
    if (value.kind === "number" || value.kind === "boolean") return String(value.value);
    return null;
}

function truthiness(value: PEValue): boolean | null {
    switch (value.kind) {
        case "string": return value.value.length > 0;
        case "number": return value.value !== 0 && !Number.isNaN(value.value);
        case "boolean": return value.value;
        case "object":
        case "array": return true;
        default: return null;
    }
}

// String/global functions that are safe to fold when every input is known
function evalCall(node: ESTree.CallExpression, scope: PEScope): PEValue {
    const callee = calleeOf(node);
    const args = node.arguments.map(a => a.type === "SpreadElement" ? Unknown : evalExpr(a, scope));

    if (callee.type === "Identifier") {
        const first = args[0] ? toStringValue(args[0]) : null;
        if (first === null) return Unknown;
        switch (callee.name) {
            case "String": return str(first);
            case "encodeURIComponent": return str(encodeURIComponent(first));
            case "encodeURI": return str(encodeURI(first));
            case "decodeURIComponent": return str(decodeURIComponent(first));
            case "decodeURI": return str(decodeURI(first));
            default: return Unknown;
        }
    }

    if (callee.type !== "MemberExpression") return Unknown;
    const method = propertyName(callee);
    const receiver = evalExpr(callee.object, scope);

    if (receiver.kind === "array" && method === "join") {
        const parts = receiver.value.map(toStringValue);
        if (parts.some(p => p === null)) return Unknown;
        const separator = args.length ? toStringValue(args[0]) : ",";
        if (separator === null) return Unknown;
        return str(parts.join(separator));
    }

    if (receiver.kind !== "string") return Unknown;
    const self = receiver.value;
    const strings = args.map(toStringValue);
    const numbers = args.map(a => a.kind === "number" ? a.value : null);

    switch (method) {
        case "trim": return str(self.trim());
        case "toLowerCase": return str(self.toLowerCase());
        case "toUpperCase": return str(self.toUpperCase());
        case "toString": return str(self);
        case "concat":
            return strings.every(s => s !== null) ? str(self + strings.join("")) : Unknown;
        case "replace":
        case "replaceAll": {
            const [search, replacement] = strings;
            if (search === null || search === undefined || replacement === null || replacement === undefined) return Unknown;
            return str(method === "replace" ? self.replace(search, replacement) : self.replaceAll(search, replacement));
        }
        case "slice":
        case "substring": {
            if (numbers.some(n => n === null)) return Unknown;
            const start = numbers[0] ?? 0;
            const end = numbers[1] ?? undefined;
            return str(method === "slice" ? self.slice(start, end) : self.substring(start, end));
        }
        default: return Unknown;
    }
}

function evalMember(node: ESTree.MemberExpression, scope: PEScope): PEValue {
    const objectValue = evalExpr(node.object, scope);
    if (objectValue.kind === "unknown") return Unknown;

    let key: string | number | null = node.computed ? null : propertyName(node);
    if (node.computed) {
        const keyValue = evalExpr(node.property, scope);
        if (keyValue.kind === "string" || keyValue.kind === "number") key = keyValue.value;
    }
    if (key === null) return Unknown;

    if (key === "length") {
        if (objectValue.kind === "string") return num(objectValue.value.length);
        if (objectValue.kind === "array") return num(objectValue.value.length);
    }
    if (objectValue.kind === "object") return objectValue.value[String(key)] ?? Unknown;
    if (objectValue.kind === "array" && typeof key === "number") return objectValue.value[key] ?? Unknown;
    if (objectValue.kind === "string" && typeof key === "number") {
        const char = objectValue.value[key];
        return char === undefined ? Unknown : str(char);
    }
    return Unknown;
}

export function evalExpr(node: ESTree.Node, scope: PEScope): PEValue {
    switch (node.type) {
        case "Literal": {
            if (typeof node.value === "string") return str(node.value);
            if (typeof node.value === "number") return num(node.value);
            if (typeof node.value === "boolean") return bool(node.value);
            return Unknown;
        }

        case "Identifier":
            return getBinding(scope, node.name);

        case "TemplateLiteral": {
            let out = "";
            for (let i = 0; i < node.quasis.length; i++) {
                out += node.quasis[i].value.cooked ?? node.quasis[i].value.raw;
                const expression = node.expressions[i];
                if (expression) {
                    const piece = toStringValue(evalExpr(expression, scope));
                    if (piece === null) return Unknown;
                    out += piece;
                }
            }
            return str(out);
        }

        case "BinaryExpression": {
            if (node.operator !== "+") return Unknown;
            const left = evalExpr(node.left, scope);
            const right = evalExpr(node.right, scope);
            if (left.kind === "number" && right.kind === "number") return num(left.value + right.value);
            const leftString = toStringValue(left);
            const rightString = toStringValue(right);
            if (leftString !== null && rightString !== null) return str(leftString + rightString);
            return Unknown;
        }

        case "LogicalExpression": {
            const left = evalExpr(node.left, scope);
            const leftTruthy = truthiness(left);
            if (leftTruthy === null) return Unknown;
            if (node.operator === "&&") return leftTruthy ? evalExpr(node.right, scope) : left;
            // ?? behaves like || here: any known value is non-nullish
            return leftTruthy || node.operator === "??" ? left : evalExpr(node.right, scope);
        }

        case "ConditionalExpression": {
            const test = truthiness(evalExpr(node.test, scope));
            if (test === null) return Unknown;
            return evalExpr(test ? node.consequent : node.alternate, scope);
        }

        case "UnaryExpression": {
            const argument = evalExpr(node.argument, scope);
            if (node.operator === "!") {
                const truthy = truthiness(argument);
                return truthy === null ? Unknown : bool(!truthy);
            }
            if (argument.kind !== "number") return Unknown;
            if (node.operator === "-") return num(-argument.value);
            if (node.operator === "+") return num(argument.value);
            return Unknown;
        }

        case "ObjectExpression": {
            const object: Record<string, PEValue> = {};
            for (const property of node.properties) {
                if (property.type === "SpreadElement") {
                    const spread = evalExpr(property.argument, scope);
                    if (spread.kind !== "object") return Unknown;
                    Object.assign(object, spread.value);
                    continue;
                }
                if (property.type !== "Property" || property.kind !== "init") return Unknown;
                let key: string | null = !property.computed && property.key.type === "Identifier" ? property.key.name : null;
                if (key === null && property.key.type === "Literal") key = String(property.key.value);
                if (key === null && property.computed) {
                    const keyValue = evalExpr(property.key, scope);
                    key = toStringValue(keyValue);
                }
                if (key === null) return Unknown;
                object[key] = evalExpr(property.value, scope);
            }
            return {kind: "object", value: object};
        }

        case "ArrayExpression": {
            const elements: PEValue[] = [];
            for (const element of node.elements) {
                if (!element || element.type === "SpreadElement") return Unknown;
                elements.push(evalExpr(element, scope));
            }
            return {kind: "array", value: elements};
        }

        case "MemberExpression":
            return evalMember(node, scope);

        case "CallExpression":
            return evalCall(node, scope);

        case "SequenceExpression":
            return evalExpr(node.expressions[node.expressions.length - 1], scope);

        case "ChainExpression":
            return evalExpr(node.expression, scope);

        case "AssignmentExpression":
            // The interpreter handles the binding side effect; the expression's value is the RHS
            return node.operator === "=" ? evalExpr(node.right, scope) : Unknown;

        default:
            return Unknown;
    }
}
