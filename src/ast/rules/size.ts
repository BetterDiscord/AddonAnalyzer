import {Type} from "../../types";
import {type Rule, type RuleContext} from "../types";


/**
 * Per-addon size — the missing denominator (handoff-07). Every other number the report
 * publishes is an absolute with no baseline; this gives one.
 *
 * A `visitText` rule so it needs no AST and runs for themes and unparseable plugins alike:
 * visitText fires before the parse gate in analyzeAddon, so a plugin that fails to parse
 * still yields a size. Deliberately *not* in REMOTE_CONTENT_RULES — it measures the store
 * file on disk (so `bytes`/`lines` reconcile exactly against `wc -c` / `wc -l`), and the
 * remote @import CSS is sized separately in the `size` analysis.
 *
 *   - bytes: UTF-8 byte length, not `text.length` (which is UTF-16 code units and diverges
 *     from `wc -c` on any non-ASCII content — and this corpus has emoji/CJK in comments).
 *   - lines: newline count, matching `wc -l` exactly (a file with no trailing newline has
 *     one fewer newline than visible lines, which is what `wc -l` reports).
 *   - codeLines: non-blank, non-comment-only lines. This is the honest small-addon metric —
 *     the median theme is ~50 lines *including* its meta block, so raw `lines` overstates
 *     it. Comment stripping is a **cheap approximation** (block comments blanked; for
 *     plugins, `//` line comments dropped), labelled as such in the report. It is a lie for
 *     minified plugins (a bundle is a handful of enormous lines) — the report uses
 *     byte-based ratios there, never line-based, per the obfuscation flag.
 */
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;

function countCodeLines(text: string, isPlugin: boolean): number {
    // Blank block comments length-preservingly so a multi-line /* ... */ (incl. JSDoc meta
    // blocks and the meta header both addon types carry) collapses to blank lines.
    const blanked = text.replace(BLOCK_COMMENT, m => m.replace(/[^\n]/g, " "));
    let count = 0;
    for (const raw of blanked.split("\n")) {
        const line = raw.trim();
        if (!line) continue;
        if (isPlugin && line.startsWith("//")) continue; // `//` is not a CSS comment, so plugins only
        count++;
    }
    return count;
}

export const sizeRule: Rule = {
    name: "size",
    appliesTo: "both",

    visitText(text, context: RuleContext) {
        const isPlugin = context.addonType === Type.Plugin;
        return {
            rule: "size",
            file: context.file,
            message: `Addon size: ${Buffer.byteLength(text, "utf8")} bytes`,
            category: "other",
            severity: "info",
            details: {
                bytes: Buffer.byteLength(text, "utf8"),
                lines: (text.match(/\n/g) ?? []).length,
                codeLines: countCodeLines(text, isPlugin)
            },
            loc: null
        };
    }
};
