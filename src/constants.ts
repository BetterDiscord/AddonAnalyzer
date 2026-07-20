import path from "path";


// Relative to this file (src/constants.ts) so entry points work outside `bun run` scripts too
export const workspaceRoot = path.dirname(import.meta.dir);
export const cacheFolder = path.join(workspaceRoot, ".cache");
export const addonFolder = path.join(cacheFolder, "addons");

// Remote CSS pulled in by theme @imports, cached as <host>/<path>.css so the rule engine
// can analyze it as first-class content instead of re-fetching it on every run.
export const importsFolder = path.join(cacheFolder, "imports");
export const resultsFolder = path.join(workspaceRoot, "results");

// Committed, unlike results/ — trend deltas are worthless if they vanish on checkout
export const historyFolder = path.join(workspaceRoot, "history");