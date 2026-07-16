import {type Finding, type Rule} from "../types";


// Ground truth for everything in this file is BetterDiscord itself, not the addon docs alone:
//   - parser semantics: BetterDiscord/src/common/utils/jsdoc.ts (parseJsDoc)
//   - meta-block requirement: BetterDiscord/src/betterdiscord/modules/addonmanager.ts (~line 190)
//   - field list: BetterDiscord/src/betterdiscord/types/addon/index.ts + the docs table at
//     https://docs.betterdiscord.app/plugins/introduction/structure#fields
// Keep them in sync when BD changes; a drifting copy silently reports the wrong thing.

// Required per the docs table. BD's runtime is laxer — it only hard-fails on a missing meta
// block and falls back for author/version/description ("???", "Unknown Author") — but a plugin
// showing "???" in the UI is still a defect, so the docs' contract is what gets reported.
export const REQUIRED_FIELDS = ["name", "author", "description", "version"] as const;

// Documented optional fields, plus two BD parses but does not document: runAt (addonmanager
// gates start timing on "idle" vs "connection") and icon (present on the Addon type).
export const OPTIONAL_FIELDS = ["invite", "authorId", "authorLink", "donate", "patreon", "website", "source", "runAt", "icon"] as const;

const KNOWN_FIELDS = new Set<string>([...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]);

// Fields BD renders as an href. invite is excluded on purpose: it carries a bare invite code
// (addoncard.tsx hands it to Modals.showGuildJoinModal), not a URL. authorId is a snowflake.
const URL_FIELDS = new Set<string>(["authorLink", "donate", "patreon", "website", "source"]);

// Lenient on purpose: BD only ever string-compares versions, and "1.0" / "v2.1.3-beta" are
// common in the store. This catches prose and placeholders ("???", "latest"), not looseness.
const VERSION_PATTERN = /^v?\d+(\.\d+)*([-+][0-9A-Za-z-.]+)?$/;

export function isKnownField(field: string): boolean {
    return KNOWN_FIELDS.has(field);
}

export function isRequiredField(field: string): boolean {
    return (REQUIRED_FIELDS as readonly string[]).includes(field);
}

// Verbatim port of BD's parseJsDoc, minus the throw on a missing block (callers guard for it)
// and minus the injected `format` key. Duplicated fields collapse to an array exactly as they
// do in BD, which is what makes duplicate detection here match BD's own behaviour.
const splitRegex = /[^\S\r\n]*?\r?(?:\r\n|\n)[^\S\r\n]*?\*[^\S\r\n]?/;
const escapedAtRegex = /^\\@/;

function parseJsDoc(text: string): Record<string, string | string[]> {
    const opened = text.split("/**", 2)[1];
    if (opened === undefined) return {};
    const block = opened.split("*/", 1)[0];

    const out: Record<string, string | string[]> = {};
    let field = "";
    let accum = "";
    const flush = () => {
        if (!out[field]) {
            out[field] = accum.trim();
        }
        else {
            if (!Array.isArray(out[field])) out[field] = [out[field] as string];
            (out[field] as string[]).push(accum.trim());
        }
    };

    for (const line of block.split(splitRegex)) {
        if (line.length === 0) continue;
        if (line.charAt(0) === "@" && line.charAt(1) !== " ") {
            flush();
            const l = line.indexOf(" ");
            field = line.substring(1, l);
            accum = line.substring(l + 1);
        }
        else {
            accum += " " + line.replace("\\n", "\n").replace(escapedAtRegex, "@");
        }
    }
    flush();
    delete out[""];
    return out;
}

function isValidUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:";
    }
    catch {
        return false;
    }
}

export const metaRule: Rule = {
    name: "meta",
    appliesTo: "both", // themes are CSS, but the meta block and BD's parser are identical

    visitText(text, context) {
        const findings: Finding[] = [];
        const problem = (key: string, message: string, field?: string) => {
            findings.push({
                rule: "meta",
                file: context.file,
                message,
                category: "style",
                severity: "warning",
                details: {kind: "problem", problem: key, ...(field ? {field} : {})},
                loc: null // BD's parser works on a split block, so source offsets are gone
            });
        };

        // BD strips a BOM and requires "/**" on the very first line; a block anywhere else is
        // not a meta block as far as the addon manager is concerned (Addons.metaNotFound).
        const source = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
        const lineEnd = source.indexOf("\n");
        const firstLine = source.slice(0, lineEnd === -1 ? source.length : lineEnd);
        if (!firstLine.includes("/**")) {
            problem("no-meta-block", "No meta block: BetterDiscord requires /** on the first line");
            return findings;
        }

        const meta = parseJsDoc(source);

        for (const [field, value] of Object.entries(meta)) {
            const values = Array.isArray(value) ? value : [value];

            // A field written with no value never reaches BD under its own name, in one of two
            // shapes depending on what follows it. Mid-block ("@invite" then another " * " line)
            // there is no space on the line, so indexOf(" ") is -1 and substring(1, -1) collapses
            // the name to a literal "@". As the last line before "*/" the name instead keeps the
            // trailing newline ("invite\n"). Either way BD looks up `addon.invite` and finds
            // nothing, so both are the same defect — report it rather than invent a field.
            if (field === "@" || field !== field.trim()) {
                const named = field === "@" ? values[0].trim() : `@${field.trim()}`;
                problem("valueless-field", `${named} has no value, so BetterDiscord does not see the field`);
                continue;
            }

            findings.push({
                rule: "meta",
                file: context.file,
                message: `Meta field @${field}`,
                category: "style",
                severity: "info",
                details: {kind: "field", field, known: isKnownField(field)},
                loc: null
            });

            // Unknown fields are author/library conventions (DevilBro's @var theme settings,
            // @changelog, @colorwayVar), not defects — BD ignores them. Only fields BD actually
            // consumes get validated; the coverage table is where the rest show up.
            if (!isKnownField(field)) continue;

            // parseJsDoc only produces an array when the same field appeared more than once
            if (values.length > 1) {
                problem("duplicate", `Duplicate @${field} (BetterDiscord keeps every value as an array)`, field);
            }

            const first = values[0].trim();
            if (first === "") {
                problem("empty", `@${field} has no value`, field);
                continue;
            }

            if (field === "version" && !VERSION_PATTERN.test(first)) {
                problem("invalid-version", `@version is not a version number: ${first}`, field);
            }
            if (URL_FIELDS.has(field) && !isValidUrl(first)) {
                problem("invalid-url", `@${field} is not an http(s) URL: ${first}`, field);
            }
        }

        for (const field of REQUIRED_FIELDS) {
            if (!(field in meta)) problem("missing", `Missing required @${field}`, field);
        }

        return findings;
    }
};
