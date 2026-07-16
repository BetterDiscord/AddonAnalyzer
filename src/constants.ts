import path from "path";


// Relative to this file (src/constants.ts) so entry points work outside `bun run` scripts too
export const workspaceRoot = path.dirname(import.meta.dir);
export const cacheFolder = path.join(workspaceRoot, ".cache");
export const addonFolder = path.join(cacheFolder, "addons");
export const resultsFolder = path.join(workspaceRoot, "results");

// Committed, unlike results/ — trend deltas are worthless if they vanish on checkout
export const historyFolder = path.join(workspaceRoot, "history");