import type {ESTree} from "meriyah";
import {evalExpr} from "../../evaluator/core";
import {interpretProgram} from "../../evaluator/interpret";
import type {PEScope} from "../../evaluator/model";
import {Type} from "../../types";
import {calleeOf, memberChain, resolveChain, stripGlobal} from "../helpers";
import {type Finding, type Rule, type RuleContext} from "../types";


const DYNAMIC = "(dynamic)";

// Canonical callee chain (after alias + global resolution), e.g. W.getByKeys -> "BdApi.Webpack.getByKeys"
function canonicalChain(node: ESTree.CallExpression, context: RuleContext): string {
    const raw = memberChain(calleeOf(node));
    if (!raw) return "";
    return stripGlobal(resolveChain(stripGlobal(raw), context.aliases)).join(".");
}

// ---- webpack-targets -------------------------------------------------------

interface WebpackSink {kind: string; firstOnly?: boolean;}

// getModule/getMangled/getWithKey are intentionally absent: their filter argument is a
// function whose inner Filters.* calls are separate CallExpressions caught on their own.
const WEBPACK_SINKS: Record<string, WebpackSink> = {
    "BdApi.Webpack.getByKeys": {kind: "key"},
    "BdApi.Webpack.getAllByKeys": {kind: "key"},
    "BdApi.Webpack.getByStrings": {kind: "string"},
    "BdApi.Webpack.getAllByStrings": {kind: "string"},
    "BdApi.Webpack.getByPrototypeKeys": {kind: "protoKey"},
    "BdApi.Webpack.getStore": {kind: "store", firstOnly: true},
    "BdApi.Webpack.Filters.byKeys": {kind: "key"},
    "BdApi.Webpack.Filters.byProps": {kind: "key"},
    "BdApi.Webpack.Filters.byStrings": {kind: "string"},
    "BdApi.Webpack.Filters.byStoreName": {kind: "store", firstOnly: true},
    "BdApi.Webpack.Filters.byDisplayName": {kind: "displayName", firstOnly: true},
};

// String values passed to a sink, deduped per call. Options objects and other known
// non-strings are skipped silently; anything unresolvable collapses to a single (dynamic).
function extractStrings(node: ESTree.CallExpression, sink: WebpackSink, scope: PEScope): string[] {
    const args = sink.firstOnly ? node.arguments.slice(0, 1) : node.arguments;
    const values = new Set<string>();
    let sawDynamic = false;

    for (const arg of args) {
        if (arg.type === "SpreadElement") {
            const spread = evalExpr(arg.argument, scope);
            if (spread.kind === "array") {
                for (const element of spread.value) {
                    if (element.kind === "string") values.add(element.value);
                }
            }
            else {
                sawDynamic = true;
            }
            continue;
        }
        const value = evalExpr(arg, scope);
        if (value.kind === "string") values.add(value.value);
        else if (value.kind === "unknown") sawDynamic = true;
        // known non-strings (options objects, arrays, numbers) are legitimately not keys — skip
    }

    if (sawDynamic) values.add(DYNAMIC);
    return [...values];
}

export const webpackTargetsRule: Rule = {
    name: "webpack-targets",
    appliesTo: [Type.Plugin],

    finalize(context) {
        if (!context.ast) return null;
        const findings: Finding[] = [];

        interpretProgram(context.ast, (node, scope) => {
            if (node.type !== "CallExpression") return;
            const sink = WEBPACK_SINKS[canonicalChain(node, context)];
            if (!sink) return;

            for (const value of extractStrings(node, sink, scope)) {
                findings.push({
                    rule: "webpack-targets",
                    file: context.file,
                    message: `Webpack lookup ${sink.kind}: ${value}`,
                    category: "api",
                    severity: "info",
                    details: {kind: sink.kind, value},
                    loc: context.getLoc(node)
                });
            }
        });

        return findings.length ? findings : null;
    }
};

// ---- patcher-targets -------------------------------------------------------

// BdApi.Patcher.before|instead|after(callerId, module, methodName, cb) — arg 2 is the method
const PATCHER_TYPES = new Set(["before", "instead", "after"]);

export const patcherTargetsRule: Rule = {
    name: "patcher-targets",
    appliesTo: [Type.Plugin],

    finalize(context) {
        if (!context.ast) return null;
        const findings: Finding[] = [];

        interpretProgram(context.ast, (node, scope) => {
            if (node.type !== "CallExpression") return;
            const chain = canonicalChain(node, context);
            if (!chain.startsWith("BdApi.Patcher.")) return;
            const type = chain.slice("BdApi.Patcher.".length);
            if (!PATCHER_TYPES.has(type)) return;

            const methodArg = node.arguments[2];
            let method = DYNAMIC;
            if (methodArg && methodArg.type !== "SpreadElement") {
                const value = evalExpr(methodArg, scope);
                if (value.kind === "string") method = value.value;
            }

            findings.push({
                rule: "patcher-targets",
                file: context.file,
                message: `Patcher.${type} target: ${method}`,
                category: "api",
                severity: "info",
                details: {type, method},
                loc: context.getLoc(node)
            });
        });

        return findings.length ? findings : null;
    }
};
