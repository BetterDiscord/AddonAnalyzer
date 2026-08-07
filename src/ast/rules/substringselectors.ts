import {Type} from "../../types";
import {type Finding, type Rule, type RuleContext} from "../types";
import {stringsOf} from "./classliterals";
import {blankNonCode} from "./cssvariables";


/**
 * Attribute-substring class selectors — `[class*="wrapper_"]` / `[class^=button_]` — the
 * churn-resilient counterpart of the hardcoded hashed classes class-literals counts: they
 * match the stable name and ignore the hash, so they survive Discord's rehashing.
 *
 * Only `*=` and `^=` count. The other class-attribute operators exist in the corpus
 * (`$=` 339, `~=` 106, `|=` 12 on 2026-07) but sampled they are overwhelmingly code-block
 * language matching (`[class$="python" i]` against highlight.js classes), not hash-churn
 * resilience — and `$=` can pin the hash itself. No whitespace is allowed around the
 * operator, matching the grep ground truth this reconciles against (`\[class[*^]=`);
 * whitespace variants are legal CSS but absent from the corpus — undercount over miscount.
 */
const SUBSTRING_SELECTOR = /\[class([*^])=/g;

// The selector value after the operator: a quoted string or an unquoted ident up to `]`,
// whitespace, or an `i` flag. Read from the ORIGINAL text — blanking erases quoted values.
const VALUE = /^("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\]\s]*)/;

function unquote(raw: string): string {
    const first = raw[0];
    if (raw.length >= 2 && (first === "\"" || first === "'") && raw.endsWith(first)) return raw.slice(1, -1);
    return raw;
}

// Matching runs on blanked text (so `/* [class*=x] */` and `content: "[class*=x]"` never
// count) but the value is extracted from the original at the same offset — blanking is
// length-preserving, so the offsets line up.
function scan(text: string, context: RuleContext, locFor: (index: number) => Finding["loc"]): Finding[] {
    const css = blankNonCode(text);
    const findings: Finding[] = [];
    for (const match of css.matchAll(SUBSTRING_SELECTOR)) {
        const index = match.index ?? 0;
        const operator = match[1];
        const value = unquote(VALUE.exec(text.slice(index + match[0].length))?.[1] ?? "");
        findings.push({
            rule: "substring-selectors",
            file: context.file,
            message: `Substring class selector: [class${operator}="${value}"]`,
            category: "style",
            severity: "info",
            details: {operator, value},
            loc: locFor(index)
        });
    }
    return findings;
}

export const substringSelectorsRule: Rule = {
    name: "substring-selectors",
    appliesTo: "both",

    // Themes (and remote @import content) are raw CSS. Plugins go through the AST branch
    // below instead — the class-literals precedent: string literals only, never raw JS text.
    visitText(text, context) {
        if (context.addonType !== Type.Theme) return null;

        let line = 1;
        let scanned = 0;
        let lineStart = 0;
        const findings = scan(text, context, index => {
            for (let i = scanned; i < index; i++) {
                if (text.charCodeAt(i) === 10) {
                    line++;
                    lineStart = i + 1;
                }
            }
            scanned = index;
            return {line, column: index - lineStart};
        });
        return findings.length ? findings : null;
    },

    // Plugin hits live in string literals and template quasis — embedded CSS handed to
    // addStyle and querySelector/matches arguments are the same resilience signal, with the
    // same fragile alternative (`.loadingOverlay_abc123`).
    match(node, context) {
        return context.addonType === Type.Plugin && stringsOf(node).length > 0;
    },

    report(node, context) {
        const findings: Finding[] = [];
        for (const text of stringsOf(node)) {
            findings.push(...scan(text, context, () => context.getLoc(node)));
        }
        return findings.length ? findings : null;
    }
};
