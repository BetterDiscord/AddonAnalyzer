import {type ESTree} from "meriyah";

export const enum AddonType {
    Plugin = "plugin",
    Theme = "theme",
};

export interface RuleContext {
    file: string;
    addonType: AddonType;
    getLoc(node: ESTree.Node): {line: number; column: number;} | null;
}

export interface Rule {
    name: string;

    // Which addon types this rule applies to
    appliesTo: AddonType[] | "both";

    // Simple per-node rules
    match?(node: ESTree.Node, context: RuleContext): boolean;
    report?(node: ESTree.Node, context: RuleContext): Finding | null;

    // Optional: whole-file summary rules
    finalize?(context: RuleContext): Finding[] | null;

    // Optional: text-only rules (metadata, etc.)
    visitText?(text: string, context: RuleContext): void;
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
