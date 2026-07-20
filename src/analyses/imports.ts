import {loadImportGraph, themeKey} from "../importcache";
import {Type, type Analysis, type CachedAddon} from "../types";


// The flat list of remote URLs a theme pulls in via @import, read from the import cache
// (importcache.ts) rather than fetched live. Retiring the old live-fetch analysis is the single
// biggest win in this batch: the graph is now resolved once per corpus and cached to disk, so a
// re-run makes zero network requests. The list is now the full *transitive* set (the old analysis
// was depth-1 and never fetched the nested imports' imports); the result key is preserved so the
// committed history/ snapshots keep this series.
export default {
    key: "imports",
    types: [Type.Theme],
    async run(addon: CachedAddon) {
        const graph = await loadImportGraph();
        return graph[themeKey(addon.author, addon.file_name)] ?? [];
    }
} satisfies Analysis;
