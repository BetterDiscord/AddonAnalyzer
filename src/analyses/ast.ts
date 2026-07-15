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

export const networkUrls: Analysis = {
    key: "network-urls",
    types: [Type.Plugin],
    run: (addon) => countBy(addon, "network-url", f => hostOf(String(f.details?.url)))
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

export const requires: Analysis = {
    key: "requires",
    types: [Type.Plugin],
    run: (addon) => countBy(addon, "require", f => String(f.details?.module))
};

// Discord webpack module lookups, keyed as "<kind>:<value>" so one record carries every
// kind (key:getChannel, store:MessageStore, string:..., protoKey:..., displayName:...)
export const webpackTargets: Analysis = {
    key: "webpack-targets",
    types: [Type.Plugin],
    run: (addon) => countBy(addon, "webpack-targets", f => `${String(f.details?.kind)}:${String(f.details?.value)}`)
};

// Discord methods patched via BdApi.Patcher, keyed by method name (patch type kept in details)
export const patcherTargets: Analysis = {
    key: "patcher-targets",
    types: [Type.Plugin],
    run: (addon) => countBy(addon, "patcher-targets", f => String(f.details?.method))
};

// Presence flags (not raw counts), so the summary reads as "addons exhibiting this signal"
export const obfuscationSignals: Analysis = {
    key: "obfuscation-signals",
    types: [Type.Plugin],
    run(addon) {
        const present: Record<string, number> = {};
        for (const finding of getFindings(addon)) {
            if (finding.rule !== "obfuscation") continue;
            for (const signal of (finding.details?.signals as string[] | undefined) ?? []) present[signal] = 1;
        }
        return present;
    }
};

export const obfuscatedPlugins: Analysis = {
    key: "obfuscated-plugins",
    types: [Type.Plugin],
    run: (addon) => getFindings(addon).some(f => f.rule === "obfuscation" && f.details?.flagged === true)
};
