import {type ESTree} from "meriyah";
import {Type} from "../types";

export interface RuleContext {
    file: string;
    addonType: Type;

    // Identifier aliases of member chains (const Api = BdApi -> Api: ["BdApi"]), empty for themes
    aliases: ReadonlyMap<string, string[]>;

    // Parsed program for whole-file rules (finalize); null for themes or unparseable plugins
    ast: ESTree.Program | null;

    getLoc(node: ESTree.Node): {line: number; column: number;} | null;
}

export interface Rule {
    name: string;

    // Which addon types this rule applies to
    appliesTo: Type[] | "both";

    // Simple per-node rules
    match?(node: ESTree.Node, context: RuleContext, parent: ESTree.Node | null): boolean;
    report?(node: ESTree.Node, context: RuleContext, parent: ESTree.Node | null): Finding | Finding[] | null;

    // Optional: whole-file summary rules
    finalize?(context: RuleContext): Finding[] | null;

    // Optional: text-only rules (metadata, CSS, etc.)
    visitText?(text: string, context: RuleContext): Finding | Finding[] | null;
}



export interface Finding {
    // Which rule produced this finding
    rule: string;

    // File where the issue was found
    file: string;

    // Optional plugin name (parsed from metadata)
    plugin?: string;

    // Human-readable description (rule provides this)
    message: string;

    // Machine-readable category for grouping
    category: "api" | "security" | "deprecated" | "style" | "network" | "other";

    // Severity for dashboards
    severity: "info" | "warning" | "error";

    // Optional structured data specific to the rule
    details?: Record<string, unknown>;

    // Location in source
    loc: {
        line: number;
        column: number;
    } | null;
}
