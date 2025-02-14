import {Type, type Analysis, type CachedAddon} from "../types";


export default {
    key: "oldMeta",
    types: [Type.Plugin, Type.Theme],
    run(addon: CachedAddon) {
        const firstLine = addon.file_content.split("\n")[0];
        return firstLine.includes("//META");
    }
} satisfies Analysis;