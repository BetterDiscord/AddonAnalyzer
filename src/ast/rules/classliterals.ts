import type {ESTree} from "meriyah";
import {Type} from "../../types";
import {type Finding, type Rule, type RuleContext} from "../types";


/**
 * Discord's hashed CSS classes, in both styles it ships — `wrapper_a1b2c3` (single
 * underscore, 6 hex) and `name__2ea32` (double underscore, 5-6 hex). One element
 * commonly carries both: `class="name__2ea32 overflow_b0dfc2"`.
 *
 * Tuned against the 2026-07 corpus (2,139 distinct tokens over 16 addons); the shape
 * is deliberate on every axis:
 * - lowercase-first: Discord class names are camelCase, and requiring it drops URL-path
 *   false positives such as "https://wikipedia.org/wiki/HD_175167".
 * - hex-only suffix: widening to [a-z0-9] turns up ~400 snake_case false positives
 *   (utm_source, node_modules, too_small) for no real gain.
 * - 5-6 length: a 7-hex suffix matches nothing in the corpus, and a 5-hex one only ever
 *   appears in the double-underscore style.
 * - boundary guards: without them the suffix matches inside longer identifiers, e.g.
 *   bundler output like __nested_webpack_require_1306889__.
 *
 * All-letter hashes (_eaaeee, _fedacc) are real Discord classes, so there is
 * deliberately no "must contain a digit" rule.
 */
const HASHED_CLASS = /(?<![\w-])[a-z][a-zA-Z0-9]*__?[a-f0-9]{5,6}(?![\w-])/g;

// Data URIs carry hash-shaped noise and never contain class names
const DATA_URI = /data:[a-z-]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi;

// Cheap opaque-blob guard for plugin string literals: long, unbroken, base64-ish
function isOpaque(text: string): boolean {
    if (text.startsWith("data:")) return true;
    return text.length > 200 && !/\s/.test(text) && /^[A-Za-z0-9+/=_-]+$/.test(text);
}

function buildFinding(token: string, context: RuleContext, loc: Finding["loc"]): Finding {
    return {
        rule: "class-literals",
        file: context.file,
        message: `Hardcoded Discord class name: ${token}`,
        category: "style",
        severity: "warning",
        details: {token, style: token.includes("__") ? "double" : "single"},
        loc
    };
}

// Exported for the substring-selectors rule, which scans plugin strings the same way
export function stringsOf(node: ESTree.Node): string[] {
    if (node.type === "Literal") return typeof node.value === "string" ? [node.value] : [];
    if (node.type === "TemplateLiteral") {
        return node.quasis.map(q => q.value.cooked ?? "").filter(Boolean);
    }
    return [];
}

export const classLiteralsRule: Rule = {
    name: "class-literals",
    appliesTo: "both",

    // Themes are raw CSS. Plugins deliberately go through the AST branch instead, so
    // only genuine string literals count — scanning plugin source as text would sweep
    // up identifiers and bundler artifacts.
    visitText(text, context) {
        if (context.addonType !== Type.Theme) return null;

        // Blank out data URIs, preserving offsets so line numbers stay correct
        const scannable = text.replace(DATA_URI, match => " ".repeat(match.length));

        const findings: Finding[] = [];
        let line = 1;
        let scanned = 0;
        let lineStart = 0;
        for (const match of scannable.matchAll(HASHED_CLASS)) {
            const index = match.index ?? 0;
            for (let i = scanned; i < index; i++) {
                if (scannable.charCodeAt(i) === 10) {
                    line++;
                    lineStart = i + 1;
                }
            }
            scanned = index;
            findings.push(buildFinding(match[0], context, {line, column: index - lineStart}));
        }
        return findings.length ? findings : null;
    },

    match(node, context) {
        return context.addonType === Type.Plugin && stringsOf(node).length > 0;
    },

    report(node, context) {
        const findings: Finding[] = [];
        for (const text of stringsOf(node)) {
            if (isOpaque(text)) continue;
            for (const match of text.matchAll(HASHED_CLASS)) {
                findings.push(buildFinding(match[0], context, context.getLoc(node)));
            }
        }
        return findings.length ? findings : null;
    }
};
