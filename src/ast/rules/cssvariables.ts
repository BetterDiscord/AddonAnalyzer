import {isDiscordVariable} from "../../discordvars";
import {type Finding, type Rule, type RuleContext} from "../types";


// CSS custom properties, three distinct signals (see handoff-05):
//   - consumption: `var(--x)` in a value — the adoption/health signal, the counterpart to
//     class-literals fragility. A theme built on Discord's variables survives class churn.
//   - definition: `--x:` declared anywhere — themes define their own palettes; normal, not health.
//   - overlap: a definition whose name Discord also ships — how themes retheme Discord, but also
//     how a theme silently breaks when Discord renames or repurposes a variable.
// Kept as separate finding kinds (not one `${kind}:${name}` key) because the report wants three
// separate top-N tables and they rank differently.

// Comments and quoted strings are blanked (length- and newline-preserving, so loc stays correct)
// before scanning, so `/* --x: */` and `content: "var(--x)"` are must-not-matches.
const COMMENT = /\/\*[\s\S]*?\*\//g;
const STRING = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;
function blankNonCode(css: string): string {
    const blank = (m: string) => m.replace(/[^\n]/g, " ");
    return css.replace(COMMENT, blank).replace(STRING, blank);
}

// A definition is `--name:` in declaration position. The lookbehind rejects a `--` embedded in a
// longer identifier; the `:` (not `)`) is what separates a definition from a `var(--name)` use.
const DEFINITION = /(?<![\w-])(--[A-Za-z0-9_-]+)\s*:/g;
// A consumption is the property name inside var(); nested fallbacks (`var(--x, var(--y))`) match
// both because matchAll keeps scanning past the first.
const CONSUMPTION = /var\(\s*(--[A-Za-z0-9_-]+)/g;

// Single forward scan mapping a source offset to a 1-based line, shared by both passes
function lineAt(text: string, index: number, state: {line: number; scanned: number}): number {
    for (let i = state.scanned; i < index; i++) {
        if (text.charCodeAt(i) === 10) state.line++;
    }
    state.scanned = index;
    return state.line;
}

export const cssVariablesRule: Rule = {
    name: "css-variables",
    appliesTo: "both", // themes are CSS; plugins embed CSS too, exactly as css-url reasons

    visitText(text, context: RuleContext) {
        const css = blankNonCode(text);
        const findings: Finding[] = [];

        // Definitions and consumptions are interleaved in source; scan each with its own line state
        const defState = {line: 1, scanned: 0};
        for (const match of css.matchAll(DEFINITION)) {
            const name = match[1];
            const overlap = isDiscordVariable(name);
            findings.push({
                rule: "css-variables",
                file: context.file,
                message: `Defines CSS variable ${name}${overlap ? " (shadows a Discord variable)" : ""}`,
                category: "style",
                severity: "info",
                details: {kind: "definition", name, overlap},
                loc: {line: lineAt(css, match.index ?? 0, defState), column: 0}
            });
        }

        const useState = {line: 1, scanned: 0};
        for (const match of css.matchAll(CONSUMPTION)) {
            const name = match[1];
            findings.push({
                rule: "css-variables",
                file: context.file,
                message: `Consumes CSS variable ${name}`,
                category: "style",
                severity: "info",
                details: {kind: "consumption", name},
                loc: {line: lineAt(css, match.index ?? 0, useState), column: 0}
            });
        }

        return findings.length ? findings : null;
    }
};
