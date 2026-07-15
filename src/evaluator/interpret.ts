import type {ESTree} from "meriyah";
import {evalExpr} from "./core";
import {assignBinding, createScope, setBinding, type PEScope} from "./model";
import {Unknown} from "./types";


export type CallVisitor = (node: ESTree.CallExpression | ESTree.NewExpression, scope: PEScope) => void;

/**
 * Walks a program in source order maintaining real nested scopes and folding
 * constant bindings, invoking the visitor at every call/new expression with
 * the scope in effect there. Source order approximates execution order —
 * good enough for the URL-inventory use case, not a real interpreter.
 */
export function interpretProgram(ast: ESTree.Program, visitCall: CallVisitor): void {
    const root = createScope();
    for (const statement of ast.body) traverse(statement, root, visitCall);
}

function isNode(value: unknown): value is ESTree.Node {
    return typeof value === "object" && value !== null && typeof(value as {type?: unknown}).type === "string";
}

// Binds every name introduced by a pattern; destructured props of known objects keep their values
function bindPattern(pattern: ESTree.Node, scope: PEScope, source = Unknown) {
    switch (pattern.type) {
        case "Identifier":
            setBinding(scope, pattern.name, source);
            break;
        case "ObjectPattern":
            for (const property of pattern.properties) {
                if (property.type === "Property") {
                    const key = !property.computed && property.key.type === "Identifier" ? property.key.name
                        : property.key.type === "Literal" ? String(property.key.value)
                            : null;
                    const value = source.kind === "object" && key !== null ? source.value[key] ?? Unknown : Unknown;
                    bindPattern(property.value, scope, value);
                }
                else if ("argument" in property) {
                    bindPattern(property.argument, scope);
                }
            }
            break;
        case "ArrayPattern":
            for (const element of pattern.elements) {
                if (element) bindPattern(element, scope);
            }
            break;
        case "AssignmentPattern":
            bindPattern(pattern.left, scope, source);
            break;
        case "RestElement":
            bindPattern(pattern.argument, scope);
            break;
        default:
            break;
    }
}

function traverseFunction(node: ESTree.FunctionDeclaration | ESTree.FunctionExpression | ESTree.ArrowFunctionExpression, scope: PEScope, visitCall: CallVisitor) {
    const functionScope = createScope(scope);
    if ("id" in node && node.id) setBinding(functionScope, node.id.name, Unknown);
    for (const param of node.params) bindPattern(param, functionScope);
    if (node.body) traverse(node.body, functionScope, visitCall);
}

function traverseChildren(node: ESTree.Node, scope: PEScope, visitCall: CallVisitor) {
    for (const key of Object.keys(node)) {
        if (key === "loc" || key === "range") continue;
        const value = (node as unknown as Record<string, unknown>)[key];
        if (Array.isArray(value)) {
            for (const child of value) {
                if (isNode(child)) traverse(child, scope, visitCall);
            }
        }
        else if (isNode(value)) {
            traverse(value, scope, visitCall);
        }
    }
}

function traverse(node: ESTree.Node, scope: PEScope, visitCall: CallVisitor) {
    switch (node.type) {
        case "BlockStatement": {
            const blockScope = createScope(scope);
            for (const statement of node.body) traverse(statement, blockScope, visitCall);
            break;
        }

        case "VariableDeclaration":
            for (const declarator of node.declarations) {
                if (declarator.init) traverse(declarator.init, scope, visitCall);
                const value = declarator.init ? evalExpr(declarator.init, scope) : Unknown;
                bindPattern(declarator.id, scope, value);
            }
            break;

        case "AssignmentExpression":
            traverse(node.right, scope, visitCall);
            if (node.left.type === "Identifier") {
                assignBinding(scope, node.left.name, node.operator === "=" ? evalExpr(node.right, scope) : Unknown);
            }
            else {
                traverse(node.left, scope, visitCall);
            }
            break;

        case "CallExpression":
        case "NewExpression":
            visitCall(node, scope);
            traverseChildren(node, scope, visitCall);
            break;

        case "FunctionDeclaration":
            if (node.id) setBinding(scope, node.id.name, Unknown);
            traverseFunction(node, scope, visitCall);
            break;

        case "FunctionExpression":
        case "ArrowFunctionExpression":
            traverseFunction(node, scope, visitCall);
            break;

        case "ClassDeclaration":
        case "ClassExpression":
            if (node.id) setBinding(scope, node.id.name, Unknown);
            traverseChildren(node, scope, visitCall);
            break;

        case "CatchClause": {
            const catchScope = createScope(scope);
            if (node.param) bindPattern(node.param, catchScope);
            traverse(node.body, catchScope, visitCall);
            break;
        }

        case "ForStatement":
        case "ForInStatement":
        case "ForOfStatement": {
            const loopScope = createScope(scope);
            traverseChildren(node, loopScope, visitCall);
            break;
        }

        default:
            traverseChildren(node, scope, visitCall);
            break;
    }
}
