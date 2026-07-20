import discordVars from "./data/discord-css-variables.json";


// Discord's own CSS custom-property names, the second checked-in data input after the BdApi
// surface manifest. Used only to classify a theme's variable *definitions* as overlapping with
// Discord's (the retheme-or-break signal). Everything else about CSS variables — consumption and
// raw definition counts — is measured from the corpus itself and needs no list.
//
// Tolerant of two on-disk shapes so the manifest can gain provenance without a code change:
//   - a flat array of names (the current shape)
//   - {source: {...}, variables: [...]} (mirrors bdapi-surface.json)
interface DiscordVarManifest {
    source?: {version?: string; generated?: string; note?: string};
    variables: string[];

    // Former Discord variable names, dropped/renamed by a Discord redesign (e.g. --text-normal ->
    // --text-default). Empty until catalogued; a theme still using one of these is the CSS-variable
    // analog of a hardcoded stale class — the planned "outdated var usage" signal reads this.
    deprecated?: string[];
}

const raw: unknown = discordVars;
const manifest: DiscordVarManifest = Array.isArray(raw)
    ? {variables: raw as string[]}
    : (raw as DiscordVarManifest);

const norm = (name: string) => (name.startsWith("--") ? name : `--${name}`);

// Normalise to bare names with the leading -- intact; membership is exact on the property name.
const DISCORD_VARS = new Set(manifest.variables.map(norm));
const DEPRECATED_VARS = new Set((manifest.deprecated ?? []).map(norm));

export const discordVarSource = manifest.source ?? null;
export const discordVarCount = DISCORD_VARS.size;
export const deprecatedVarCount = DEPRECATED_VARS.size;

export function isDiscordVariable(name: string): boolean {
    return DISCORD_VARS.has(name);
}

// A variable Discord used to ship but has since renamed/removed. Always false until the manifest's
// `deprecated` list is populated — never inferred, so the outdated-usage table stays evidence-based.
export function isOutdatedVariable(name: string): boolean {
    return DEPRECATED_VARS.has(name);
}
