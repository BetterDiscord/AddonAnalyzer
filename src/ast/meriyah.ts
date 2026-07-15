import {parseScript, type ESTree} from "meriyah";
import {walk} from "./walk";
import {type Rule, type RuleContext, AddonType, type Finding} from "./types";

export function analyzeAddon(
    file: string,
    code: string,
    addonType: AddonType,
    rules: Rule[]
): Finding[] {
    const findings: Finding[] = [];

    // Filter rules by addon type
    const applicable = rules.filter(
        r => r.appliesTo === "both" || r.appliesTo.includes(addonType)
    );

    const context: RuleContext = {
        file,
        addonType,
        getLoc(node) {
            if (!node.loc) return null;
            return {
                line: node.loc.start.line,
                column: node.loc.start.column
            };
        }
    };

    // 1. Text-only rules (metadata, etc.)
    for (const rule of applicable) {
        if (rule.visitText) {
            rule.visitText(code, context);
        }
    }

    // 2. JS plugin analysis
    if (addonType === AddonType.Plugin) {
        const ast = parseScript(code, {
            next: true,
            loc: true,
            ranges: true,
            module: false
        });

        walk(ast, (node: ESTree.Node) => {
            for (const rule of applicable) {
                if (rule.match && rule.report) {
                    if (rule.match(node, context)) {
                        const result = rule.report(node, context);
                        if (result) findings.push(result);
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
