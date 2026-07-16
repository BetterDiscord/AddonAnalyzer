import path from "path";


export const workspaceRoot = path.dirname(process.env.npm_package_json!);
export const cacheFolder = path.join(workspaceRoot, ".cache");
export const addonFolder = path.join(cacheFolder, "addons");
export const resultsFolder = path.join(workspaceRoot, "results");

// Committed, unlike results/ — trend deltas are worthless if they vanish on checkout
export const historyFolder = path.join(workspaceRoot, "history");