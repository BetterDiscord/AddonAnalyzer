import {analyzeAddon, rules, type Finding} from "../ast";
import {DYNAMIC_SEGMENT} from "../ast/rules/remoteurls";
import {Type, type Analysis, type CachedAddon} from "../types";


// One parse+walk per addon shared by every AST-backed analysis below
const findingsCache = new WeakMap<CachedAddon, Finding[]>();
function getFindings(addon: CachedAddon): Finding[] {
    let findings = findingsCache.get(addon);
    if (!findings) {
        findings = analyzeAddon(addon.file_name, addon.file_content, addon.type, rules);
        findingsCache.set(addon, findings);
    }
    return findings;
}

function countBy(addon: CachedAddon, rule: string, key: (finding: Finding) => string): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const finding of getFindings(addon)) {
        if (finding.rule !== rule) continue;
        const k = key(finding);
        counts[k] = (counts[k] ?? 0) + 1;
    }
    return counts;
}

export const bdapiUsage: Analysis = {
    key: "bdapi-usage",
    types: [Type.Plugin],
    run: (addon) => countBy(addon, "bdapi-usage", f => String(f.details?.api))
};

export const deprecatedApis: Analysis = {
    key: "deprecated-apis",
    types: [Type.Plugin],
    run(addon) {
        const counts: Record<string, number> = {};
        for (const finding of getFindings(addon)) {
            if (finding.rule !== "bdapi-usage" || !finding.details?.deprecated) continue;
            const api = String(finding.details.api);
            counts[api] = (counts[api] ?? 0) + 1;
        }
        return counts;
    }
};

function hostOf(url: string): string {
    try {
        return new URL(url.split(DYNAMIC_SEGMENT)[0]).hostname;
    }
    catch {
        return "(dynamic)";
    }
}

export const remoteUrls: Analysis = {
    key: "remote-urls",
    types: [Type.Plugin],
    run: (addon) => countBy(addon, "remote-url", f => hostOf(String(f.details?.url)))
};

export const cssUrls: Analysis = {
    key: "css-urls",
    types: [Type.Plugin, Type.Theme],
    run: (addon) => countBy(addon, "css-url", f => hostOf(String(f.details?.url)))
};

export const htmlInjection: Analysis = {
    key: "html-injection",
    types: [Type.Plugin],
    run: (addon) => countBy(addon, "innerHTML", f => String(f.details?.sink))
};

export const dynamicCode: Analysis = {
    key: "dynamic-code",
    types: [Type.Plugin],
    run: (addon) => countBy(addon, "eval", f => String(f.details?.kind))
};

export const parseErrors: Analysis = {
    key: "parse-errors",
    types: [Type.Plugin],
    run: (addon) => getFindings(addon).filter(f => f.rule === "parse-error").length
};
