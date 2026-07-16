import type {ESTree} from "meriyah";
import {interpretProgram} from "../../evaluator/interpret";
import type {PEScope} from "../../evaluator/model";
import {partialString} from "../../evaluator/strings";
import {Type} from "../../types";
import {calleeOf, memberChain, propertyName, resolveChain, stripGlobal} from "../helpers";
import {type Finding, type Rule, type RuleContext} from "../types";
import {walk} from "../walk";


const WRITE_METHODS = /^writeFile(Sync)?$/;
const PLUGIN_FILE = ".plugin.js";

// Where BD keeps executable plugins; a write landing here installs code
const PLUGINS_FOLDER = "BdApi.Plugins.folder";

// The canonical corpus shape is require("fs").writeFile(...) — a call rooted in another call,
// which memberChain cannot name. The method name is the only signature-agnostic locator, so it
// is what gets matched, deliberately without pinning the receiver to `fs`. That alone is far too
// loose to report on, which is why the path argument must independently point at a plugin file.
function writeMethodName(callee: ESTree.Node): string | null {
    if (callee.type === "Identifier") return callee.name; // const {writeFileSync} = require("fs")
    if (callee.type === "MemberExpression") return propertyName(callee);
    return null;
}

// Does this path argument point at a plugin file? partialString handles literals, templates,
// concatenation and resolvable consts; the subtree scan below catches what it cannot fold —
// path.join(BdApi.Plugins.folder, "X.plugin.js") is a CallExpression, so it folds to nothing.
function pluginFileTarget(node: ESTree.Node, scope: PEScope, context: RuleContext): string | null {
    const folded = partialString(node, scope);
    if (folded?.text.includes(PLUGIN_FILE)) return folded.text;

    let target: string | null = null;
    walk(node, (child) => {
        if (target) return;

        if (child.type === "Literal" && typeof child.value === "string" && child.value.includes(PLUGIN_FILE)) {
            target = child.value;
            return;
        }
        if (child.type === "TemplateLiteral") {
            for (const quasi of child.quasis) {
                if ((quasi.value.cooked ?? quasi.value.raw).includes(PLUGIN_FILE)) {
                    target = partialString(child, scope)?.text ?? PLUGIN_FILE;
                    return;
                }
            }
        }
        if (child.type === "MemberExpression") {
            const raw = memberChain(child);
            if (!raw) return;
            if (stripGlobal(resolveChain(stripGlobal(raw), context.aliases)).join(".") === PLUGINS_FOLDER) {
                target = PLUGINS_FOLDER;
            }
        }
    });

    return target;
}

export const selfUpdateRule: Rule = {
    name: "self-update",
    appliesTo: [Type.Plugin],

    finalize(context) {
        if (!context.ast) return null;
        const findings: Finding[] = [];

        interpretProgram(context.ast, (node, scope) => {
            if (node.type !== "CallExpression") return;

            const method = writeMethodName(calleeOf(node));
            if (!method || !WRITE_METHODS.test(method)) return;

            const argument = node.arguments[0];
            if (!argument || argument.type === "SpreadElement") return;

            const target = pluginFileTarget(argument, scope, context);
            if (!target) return;

            findings.push({
                rule: "self-update",
                file: context.file,
                message: `Writes a plugin file via ${method}(): ${target}`,
                category: "security",
                severity: "warning",
                details: {signal: "writes-plugin-file", method, target},
                loc: context.getLoc(node)
            });
        });

        return findings.length ? findings : null;
    }
};
