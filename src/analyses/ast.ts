import {analyzeAddon, classLiteralsRule, cssUrlRule, cssVariablesRule, rules, type Finding} from "../ast";
import {DYNAMIC_SEGMENT} from "../evaluator/strings";
import {phantomPath} from "../surface";
import {Type, type Analysis, type CachedAddon} from "../types";


// The CSS-content rules re-run over a theme's remote @import content (see below). Deliberately not
// the whole rule set: meta must not run on remote CSS (it has no meta block, so every import would
// report no-meta-block). css-url/class-literals/css-variables are the rules whose subject is the CSS
// itself, so they extend naturally to the remote content the store file only loads.
const REMOTE_CONTENT_RULES = [cssUrlRule, classLiteralsRule, cssVariablesRule];

// One parse+walk per addon shared by every AST-backed analysis below
const findingsCache = new WeakMap<CachedAddon, Finding[]>();
function getFindings(addon: CachedAddon): Finding[] {
    let findings = findingsCache.get(addon);
    if (!findings) {
        findings = analyzeAddon(addon.file_name, addon.file_content, addon.type, rules);
        // A theme's real CSS usually lives on *.github.io behind an @import; the store file is a
        // loader. Analyze that fetched content too and attribute its findings to the importing
        // theme (this addon), so class-literals/css-urls measure the theme, not the wrapper.
        if (addon.remote_content) {
            findings.push(...analyzeAddon(addon.file_name, addon.remote_content, Type.Theme, REMOTE_CONTENT_RULES));
        }
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

/**
 * Calls to BdApi members BD core does not declare, keyed by the phantom path.
 *
 * Classified here rather than in a rule because the judgement needs no AST: the bdapi-usage
 * rule has already resolved every chain through aliases and instances, so this reads its
 * findings and diffs them against the manifest — the same reuse `self-updating` makes of
 * the url rules. The counterpart question ("declared but never called") is a corpus-wide
 * fact that the per-addon Analysis shape cannot express at all; the report derives it from
 * the manifest plus summary.json instead.
 */
export const phantomApis: Analysis = {
    key: "phantom-apis",
    types: [Type.Plugin],
    run(addon) {
        const counts: Record<string, number> = {};
        for (const finding of getFindings(addon)) {
            if (finding.rule !== "bdapi-usage") continue;
            const phantom = phantomPath(String(finding.details?.api));
            if (phantom) counts[phantom] = (counts[phantom] ?? 0) + 1;
        }
        return counts;
    }
};

// Presence per addon, so the summary reads "plugins defining this member" (the meta-fields
// precedent) rather than counting a member twice in a plugin that defines it on two classes
export const lifecycle: Analysis = {
    key: "lifecycle",
    types: [Type.Plugin],
    run(addon) {
        const present: Record<string, number> = {};
        for (const finding of getFindings(addon)) {
            if (finding.rule !== "lifecycle") continue;
            present[String(finding.details?.member)] = 1;
        }
        return present;
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

// Per-addon size — the denominator every other number lacks (handoff-07). The `size` rule
// measures the store file only (bytes/lines/codeLines reconcile against wc); `remoteBytes` is
// added here because a theme's real CSS lives in its remote @import content, which the rule
// deliberately does not see. Aggregation sums each key, so summary.size gives total corpus size
// for free. Ratios (classes-per-KB) are NOT computed here — summing a ratio is meaningless; the
// report derives them per-addon in assemble(). `remoteBytes` is per-addon fuel for that (its
// summary sum is not meaningful — shared remote CSS is counted once per importing theme).
export const size: Analysis = {
    key: "size",
    types: [Type.Plugin, Type.Theme],
    run(addon) {
        const finding = getFindings(addon).find(f => f.rule === "size");
        return {
            bytes: Number(finding?.details?.bytes ?? 0),
            lines: Number(finding?.details?.lines ?? 0),
            codeLines: Number(finding?.details?.codeLines ?? 0),
            remoteBytes: addon.remote_content ? Buffer.byteLength(addon.remote_content, "utf8") : 0
        };
    }
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

// Plugins that reach Discord through a library object (BDFDB, ZeresPluginLibrary) instead of
// calling BdApi directly — presence per library, so the summary reads "N plugins route through
// X". This sizes the indirection blind spot every other internals analysis undercounts: those
// N plugins' webpack/patcher/bdapi usage is attributed to the library, not to them. See the
// library-deps rule for why detection is a global read, not a string mention.
export const libraryDeps: Analysis = {
    key: "library-deps",
    types: [Type.Plugin],
    run(addon) {
        const present: Record<string, number> = {};
        for (const finding of getFindings(addon)) {
            if (finding.rule !== "library-deps") continue;
            present[String(finding.details?.library)] = 1;
        }
        return present;
    }
};

// The same dependents split by signal ("<library>:<signal>"), so the report can distinguish a
// plugin that only guards for the library (a bootstrap check) from one that actively calls it.
export const libraryDepSignals: Analysis = {
    key: "library-dep-signals",
    types: [Type.Plugin],
    run(addon) {
        const present: Record<string, number> = {};
        for (const finding of getFindings(addon)) {
            if (finding.rule !== "library-deps") continue;
            present[`${String(finding.details?.library)}:${String(finding.details?.signal)}`] = 1;
        }
        return present;
    }
};

// Hand-rolled DOM work BdApi already offers, keyed by shape. Currently just raw <style> injection
// (document.createElement("style")); its API counterpart BdApi.DOM.addStyle is counted by
// bdapi-usage, so the report pairs the two from there rather than double-counting it here.
export const rawDom: Analysis = {
    key: "raw-dom",
    types: [Type.Plugin],
    run: (addon) => countBy(addon, "raw-dom", f => String(f.details?.shape))
};

// Node/Electron environment reach, keyed by root plus one segment (process.env, Buffer.from)
export const globals: Analysis = {
    key: "globals",
    types: [Type.Plugin],
    run: (addon) => countBy(addon, "globals", f => String(f.details?.global))
};

// Legacy ReactDOM entry points plus createRoot adoption, keyed by method
export const reactHazards: Analysis = {
    key: "react-hazards",
    types: [Type.Plugin],
    run: (addon) => countBy(addon, "react-hazards", f => String(f.details?.method))
};

// Hashed Discord class names hardcoded in source; a per-addon fragility count
export const classLiterals: Analysis = {
    key: "class-literals",
    types: [Type.Plugin, Type.Theme],
    run: (addon) => getFindings(addon).filter(f => f.rule === "class-literals").length
};

// Two independent signals for a plugin that installs executable code: a write into a .plugin.js
// path, and a fetch of a .plugin.js URL. The fetch side reuses the network/remote-url findings
// rather than re-walking — those rules already resolve URLs through the evaluator.
function selfUpdateSignals(addon: CachedAddon): Set<string> {
    const signals = new Set<string>();
    for (const finding of getFindings(addon)) {
        if (finding.rule === "self-update") signals.add(String(finding.details?.signal));
        if (finding.rule === "network-url" || finding.rule === "remote-url") {
            if (String(finding.details?.url).endsWith(".plugin.js")) signals.add("fetches-plugin-file");
        }
    }
    return signals;
}

// Either signal alone is weak: plugins write non-plugin files, and a .plugin.js URL is often
// just a @source link. The pair is what makes a self-installer, so the boolean needs both.
export const selfUpdating: Analysis = {
    key: "self-updating",
    types: [Type.Plugin],
    run: (addon) => {
        const signals = selfUpdateSignals(addon);
        return signals.has("writes-plugin-file") && signals.has("fetches-plugin-file");
    }
};

// The same signals unrolled, so the report can show which half a partial match has
export const selfUpdateSignalCounts: Analysis = {
    key: "self-update-signals",
    types: [Type.Plugin],
    run(addon) {
        const present: Record<string, number> = {};
        for (const signal of selfUpdateSignals(addon)) present[signal] = 1;
        return present;
    }
};

// Presence flags per addon, so the summary reads as "addons shipping this meta field"
export const metaFields: Analysis = {
    key: "meta-fields",
    types: [Type.Plugin, Type.Theme],
    run(addon) {
        const present: Record<string, number> = {};
        for (const finding of getFindings(addon)) {
            if (finding.rule !== "meta" || finding.details?.kind !== "field") continue;
            present[String(finding.details.field)] = 1;
        }
        return present;
    }
};

// Malformations keyed as "<problem>:<field>" (or bare "<problem>" where no field applies),
// so one record carries missing/duplicate/empty/invalid-version/invalid-url/no-meta-block
export const metaProblems: Analysis = {
    key: "meta-problems",
    types: [Type.Plugin, Type.Theme],
    run(addon) {
        const counts: Record<string, number> = {};
        for (const finding of getFindings(addon)) {
            if (finding.rule !== "meta" || finding.details?.kind !== "problem") continue;
            const problem = String(finding.details.problem);
            const field = finding.details.field as string | undefined; // set by the meta rule
            const key = field ? `${problem}:${field}` : problem;
            counts[key] = (counts[key] ?? 0) + 1;
        }
        return counts;
    }
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

// CSS custom properties, three keys because the report wants three tables that rank differently
// (see the css-variables rule). Counts are occurrences; per-addon presence is derived in report.ts.
function countVars(addon: CachedAddon, keep: (f: Finding) => boolean): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const finding of getFindings(addon)) {
        if (finding.rule !== "css-variables" || !keep(finding)) continue;
        const name = String(finding.details?.name);
        counts[name] = (counts[name] ?? 0) + 1;
    }
    return counts;
}

export const cssVarUsage: Analysis = {
    key: "css-var-usage",
    types: [Type.Plugin, Type.Theme],
    run: (addon) => countVars(addon, f => f.details?.kind === "consumption")
};

export const cssVarDefinitions: Analysis = {
    key: "css-var-definitions",
    types: [Type.Plugin, Type.Theme],
    run: (addon) => countVars(addon, f => f.details?.kind === "definition")
};

// A definition whose name Discord also ships: the theme reskins Discord's variable, and breaks
// silently if Discord renames or repurposes it. Overlap membership is set in the rule against the
// checked-in Discord manifest, so this analysis is pure classification of the definition findings.
export const cssVarOverlap: Analysis = {
    key: "css-var-overlap",
    types: [Type.Plugin, Type.Theme],
    run: (addon) => countVars(addon, f => f.details?.kind === "definition" && f.details.overlap === true)
};

// A definition or consumption of a name Discord has since renamed/removed — the CSS analog of a
// stale hardcoded class. Both directions count: consuming var(--text-normal) now resolves to nothing,
// and defining --background-primary reskins a variable Discord no longer reads. Classified against the
// manifest's `deprecated` set, never inferred, so it stays empty until that set is populated.
export const cssVarOutdated: Analysis = {
    key: "css-var-outdated",
    types: [Type.Plugin, Type.Theme],
    run: (addon) => countVars(addon, f => f.details?.outdated === true)
};
