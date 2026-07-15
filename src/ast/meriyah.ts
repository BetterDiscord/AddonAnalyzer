import {parseScript, type ESTree} from "meriyah";
import {Type} from "../types";
import {collectAliases} from "./aliases";
import {walk} from "./walk";
import {type Rule, type RuleContext, type Finding} from "./types";

export function analyzeAddon(
    file: string,
    code: string,
    addonType: Type,
    rules: Rule[]
): Finding[] {
    const findings: Finding[] = [];

    // Filter rules by addon type
    const applicable = rules.filter(
        r => r.appliesTo === "both" || r.appliesTo.includes(addonType)
    );

    let ast: ESTree.Program | null = null;
    if (addonType === Type.Plugin) {
        try {
            ast = parseScript(code, {
                next: true,
                loc: true,
                ranges: true,
                raw: true // literal source text, needed for escape-density signals
            });
        }
        catch (error) {
            findings.push({
                rule: "parse-error",
                file,
                message: `Failed to parse: ${error instanceof Error ? error.message : String(error)}`,
                category: "other",
                severity: "error",
                loc: null
            });
        }
    }

    const context: RuleContext = {
        file,
        addonType,
        ast,
        aliases: ast ? collectAliases(ast) : new Map(),
        getLoc(node) {
            if (!node.loc) return null;
            return {
                line: node.loc.start.line,
                column: node.loc.start.column
            };
        }
    };

    // 1. Text-only rules (metadata, CSS, etc.)
    for (const rule of applicable) {
        if (rule.visitText) {
            const result = rule.visitText(code, context);
            if (Array.isArray(result)) findings.push(...result);
            else if (result) findings.push(result);
        }
    }

    // 2. JS plugin analysis
    if (ast) {
        walk(ast, (node, parent) => {
            for (const rule of applicable) {
                if (rule.match && rule.report) {
                    if (rule.match(node, context, parent)) {
                        const result = rule.report(node, context, parent);
                        if (Array.isArray(result)) findings.push(...result);
                        else if (result) findings.push(result);
                    }
                }
            }
        });
    }

    // 3. finalize() for rules that need whole-file context
    for (const rule of applicable) {
        if (rule.finalize) {
            const out = rule.finalize(context);
            if (out) findings.push(...out);
        }
    }

    return findings;
}
