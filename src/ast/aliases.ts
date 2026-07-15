import type {ESTree} from "meriyah";
import {memberChain} from "./helpers";
import {walk} from "./walk";


type Register = (name: string, chain: string[] | null) => void;

// Registers every name bound by a pattern. Destructured names extend the source chain
// ({Webpack} = BdApi binds Webpack -> BdApi.Webpack); bindings we can't follow get null.
function bindPattern(pattern: ESTree.Node, source: string[] | null, register: Register) {
    switch (pattern.type) {
        case "Identifier":
            register(pattern.name, source);
            break;
        case "ObjectPattern":
            for (const property of pattern.properties) {
                if (property.type === "Property") {
                    const key = !property.computed && property.key.type === "Identifier" ? property.key.name
                        : property.key.type === "Literal" && typeof property.key.value === "string" ? property.key.value
                            : null;
                    bindPattern(property.value, source && key ? [...source, key] : null, register);
                }
                else if ("argument" in property) { // rest elements, typed as SpreadElement by meriyah
                    bindPattern(property.argument, null, register);
                }
            }
            break;
        case "ArrayPattern":
            for (const element of pattern.elements) {
                if (element) bindPattern(element, null, register);
            }
            break;
        case "AssignmentPattern":
            bindPattern(pattern.left, source, register);
            break;
        case "RestElement":
            bindPattern(pattern.argument, null, register);
            break;
        default:
            break;
    }
}

/**
 * Builds a map of identifier -> member chain for simple aliases like
 * `const Api = BdApi` or `const {Webpack} = BdApi`, so rules can resolve
 * usages through them.
 *
 * The walk is scope-blind, so correctness comes from being conservative:
 * a name declared more than once, reassigned, or shadowed by any function
 * parameter, catch clause, or function/class name anywhere in the file is
 * dropped entirely. Minified code mostly loses its aliases this way, which
 * beats miscounting.
 */
export function collectAliases(ast: ESTree.Program): Map<string, string[]> {
    const candidates = new Map<string, string[] | null>();
    const shadowed = new Set<string>();

    const register: Register = (name, chain) => {
        candidates.set(name, candidates.has(name) ? null : chain);
    };
    const shadow: Register = (name) => {
        shadowed.add(name);
    };

    walk(ast, (node) => {
        switch (node.type) {
            case "VariableDeclarator":
                bindPattern(node.id, node.init ? memberChain(node.init) : null, register);
                break;
            case "AssignmentExpression":
                // Reassignment makes a name unreliable as an alias
                if (node.left.type === "Identifier" || node.left.type === "ObjectPattern" || node.left.type === "ArrayPattern") {
                    bindPattern(node.left, null, register);
                }
                break;
            case "FunctionDeclaration":
            case "FunctionExpression":
            case "ArrowFunctionExpression":
                if ("id" in node && node.id) shadow(node.id.name, null);
                for (const param of node.params) bindPattern(param, null, shadow);
                break;
            case "CatchClause":
                if (node.param) bindPattern(node.param, null, shadow);
                break;
            case "ClassDeclaration":
            case "ClassExpression":
                if (node.id) shadow(node.id.name, null);
                break;
            default:
                break;
        }
    });

    const aliases = new Map<string, string[]>();
    for (const [name, chain] of candidates) {
        if (chain && !shadowed.has(name)) aliases.set(name, chain);
    }
    return aliases;
}
