import type {ESTree} from "meriyah";
import {Type} from "../../types";
import {calleeOf, memberChain, stripGlobal} from "../helpers";
import {type Rule} from "../types";
import {walk} from "../walk";


type Signal =
    | "weird-identifiers"
    | "many-single-char-identifiers"
    | "large-string-array"
    | "escape-heavy-strings"
    | "high-entropy-strings"
    | "cf-flattening"
    | "dynamic-eval"
    | "dynamic-function"
    | "string-timeout"
    | "document-write";

const HEAVY_SIGNALS = new Set<Signal>(["weird-identifiers", "large-string-array", "cf-flattening", "dynamic-eval", "dynamic-function"]);

interface SignalCounts {
    weirdIdentifiers: number;
    singleCharIdentifiers: number;
    totalIdentifiers: number;
    largeStringArrays: number;
    escapeHeavyStrings: number;
    highEntropyStrings: number;
    cfFlattening: number;
    dynamicEval: number;
    dynamicFunction: number;
    stringTimeouts: number;
    documentWrites: number;
}

// classic obfuscator pattern: _0x123abc
function isWeirdIdentifier(name: string): boolean {
    return /^_0x[0-9a-f]+$/i.test(name);
}

// \xNN / \uNNNN density in the raw source text (the cooked value is already decoded)
function isEscapeHeavy(raw: string): boolean {
    const escapes = raw.match(/\\x[0-9a-f]{2}|\\u[0-9a-f]{4}/gi)?.length ?? 0;
    return escapes > 3;
}

function estimateEntropy(text: string): number {
    if (!text.length) return 0;
    const freq = new Map<string, number>();
    for (const ch of text) freq.set(ch, (freq.get(ch) ?? 0) + 1);
    let entropy = 0;
    for (const count of freq.values()) {
        const p = count / text.length;
        entropy -= p * Math.log2(p);
    }
    return entropy;
}

// Thresholds tuned on the 2026-07 store corpus: >4.0/len16 flagged 95% of plugins
// (URLs and class strings qualify); >4.8/len48 flags 12%. Random base64 is ~5.9.
function isHighEntropy(text: string): boolean {
    return text.length >= 48 && estimateEntropy(text) > 4.8;
}

function collectCounts(ast: ESTree.Program): SignalCounts {
    const counts: SignalCounts = {
        weirdIdentifiers: 0,
        singleCharIdentifiers: 0,
        totalIdentifiers: 0,
        largeStringArrays: 0,
        escapeHeavyStrings: 0,
        highEntropyStrings: 0,
        cfFlattening: 0,
        dynamicEval: 0,
        dynamicFunction: 0,
        stringTimeouts: 0,
        documentWrites: 0,
    };

    walk(ast, (node) => {
        switch (node.type) {
            case "Identifier":
                counts.totalIdentifiers++;
                if (isWeirdIdentifier(node.name)) counts.weirdIdentifiers++;
                if (node.name.length === 1) counts.singleCharIdentifiers++;
                break;

            case "Literal":
                if (typeof node.value === "string") {
                    if (node.raw !== undefined && isEscapeHeavy(node.raw)) counts.escapeHeavyStrings++;
                    if (isHighEntropy(node.value)) counts.highEntropyStrings++;
                }
                break;

            case "ArrayExpression": {
                const stringElements = node.elements.filter(e => e?.type === "Literal" && typeof e.value === "string");
                if (stringElements.length >= 10) counts.largeStringArrays++;
                break;
            }

            case "WhileStatement":
                // control-flow flattening: while (true) { switch (...) }
                if (node.test.type === "Literal" && node.test.value === true) {
                    let hasSwitch = false;
                    walk(node.body, (inner) => {
                        if (inner.type === "SwitchStatement") hasSwitch = true;
                    });
                    if (hasSwitch) counts.cfFlattening++;
                }
                break;

            case "NewExpression":
            case "CallExpression": {
                const callee = node.type === "CallExpression" ? calleeOf(node) : node.callee;
                if (callee.type === "Identifier") {
                    if (callee.name === "eval" && node.type === "CallExpression") counts.dynamicEval++;
                    if (callee.name === "Function") counts.dynamicFunction++;
                    if ((callee.name === "setTimeout" || callee.name === "setInterval")
                        && node.arguments[0]?.type === "Literal" && typeof node.arguments[0].value === "string") {
                        counts.stringTimeouts++;
                    }
                }
                else if (callee.type === "MemberExpression") {
                    const chain = memberChain(callee);
                    if (chain && stripGlobal(chain).join(".") === "document.write") counts.documentWrites++;
                }
                break;
            }

            default:
                break;
        }
    });

    return counts;
}

function deriveSignals(counts: SignalCounts): Signal[] {
    const signals: Signal[] = [];
    const singleCharRatio = counts.totalIdentifiers === 0 ? 0 : counts.singleCharIdentifiers / counts.totalIdentifiers;

    if (counts.weirdIdentifiers >= 3) signals.push("weird-identifiers");
    if (singleCharRatio > 0.5 && counts.totalIdentifiers >= 20) signals.push("many-single-char-identifiers");
    if (counts.largeStringArrays > 0) signals.push("large-string-array");
    if (counts.escapeHeavyStrings > 0) signals.push("escape-heavy-strings");
    if (counts.highEntropyStrings > 0) signals.push("high-entropy-strings");
    if (counts.cfFlattening > 0) signals.push("cf-flattening");
    if (counts.dynamicEval > 0) signals.push("dynamic-eval");
    if (counts.dynamicFunction > 0) signals.push("dynamic-function");
    if (counts.stringTimeouts > 0) signals.push("string-timeout");
    if (counts.documentWrites > 0) signals.push("document-write");
    return signals;
}

export const obfuscationRule: Rule = {
    name: "obfuscation",
    appliesTo: [Type.Plugin],

    finalize(context) {
        if (!context.ast) return null;

        const counts = collectCounts(context.ast);
        const signals = deriveSignals(counts);
        if (!signals.length) return null;

        const score = Math.min(1, signals.reduce((total, signal) => total + (HEAVY_SIGNALS.has(signal) ? 0.25 : 0.15), 0));
        const flagged = score >= 0.4;

        return [{
            rule: "obfuscation",
            file: context.file,
            message: `Obfuscation score ${score.toFixed(2)} with signals: ${signals.join(", ")}`,
            category: "security",
            severity: score >= 0.7 ? "error" : flagged ? "warning" : "info",
            details: {score, flagged, signals, counts: {...counts}},
            loc: null
        }];
    }
};
