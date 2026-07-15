import {type Finding, type Rule} from "../types";


const IMPORT_PATTERN = /@import\s+(?:url\(\s*)?["']?([^"'()\s;]+)["']?\s*\)?/g;
const URL_PATTERN = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;

// Themes are injected into discord.com, so protocol- and root-relative refs resolve there
function cleanUrl(raw: string): string | null {
    const cleaned = raw.replace(/\\/g, "").trim();
    if (!cleaned || cleaned.startsWith("data:") || cleaned.startsWith("#")) return null;
    if (/[({}$]/.test(cleaned)) return null; // var(), template interpolation, and similar noise
    if (/^https?:\/\//.test(cleaned)) return cleaned;
    if (cleaned.startsWith("//")) return "https:" + cleaned;
    if (cleaned.startsWith("/")) return "https://discord.com" + cleaned;
    return null;
}

export const cssUrlRule: Rule = {
    name: "css-url",
    appliesTo: "both", // plugins embed CSS too (BdApi.DOM.addStyle and friends)

    visitText(text, context) {
        const importRanges: Array<[number, number]> = [];
        const entries: Array<{index: number, url: string, kind: "import" | "url"}> = [];

        for (const match of text.matchAll(IMPORT_PATTERN)) {
            const index = match.index ?? 0;
            importRanges.push([index, index + match[0].length]);
            const url = cleanUrl(match[1]);
            if (url) entries.push({index, url, kind: "import"});
        }

        for (const match of text.matchAll(URL_PATTERN)) {
            const index = match.index ?? 0;
            // @import url(...) already counted above
            if (importRanges.some(([start, end]) => index >= start && index < end)) continue;
            const url = cleanUrl(match[1]);
            if (url) entries.push({index, url, kind: "url"});
        }

        entries.sort((a, b) => a.index - b.index);

        // Single forward scan for line numbers instead of counting from 0 per finding
        let line = 1;
        let scanned = 0;
        let lineStart = 0;
        const findings: Finding[] = [];
        for (const entry of entries) {
            for (let i = scanned; i < entry.index; i++) {
                if (text.charCodeAt(i) === 10) {
                    line++;
                    lineStart = i + 1;
                }
            }
            scanned = entry.index;

            findings.push({
                rule: "css-url",
                file: context.file,
                message: `CSS ${entry.kind === "import" ? "@import" : "url()"} reference: ${entry.url}`,
                category: "network",
                severity: "info",
                details: {url: entry.url, kind: entry.kind},
                loc: {line, column: entry.index - lineStart}
            });
        }

        return findings.length ? findings : null;
    }
};
