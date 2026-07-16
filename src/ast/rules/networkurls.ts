import type {ESTree} from "meriyah";
import {interpretProgram} from "../../evaluator/interpret";
import {DYNAMIC_SEGMENT, partialString} from "../../evaluator/strings";
import {Type} from "../../types";
import {calleeOf, memberChain, resolveChain, stripGlobal} from "../helpers";
import {type Finding, type Rule} from "../types";


const URL_PATTERN = /^(https?|wss?):\/\//;

// Canonical callee chain (after alias/global resolution) -> index of the URL argument
const CALL_SINKS: Record<string, number> = {
    "fetch": 0,
    "open": 0, // window.open after global stripping
    "BdApi.Net.fetch": 0,
    "navigator.sendBeacon": 0,
    "axios": 0,
    "axios.get": 0,
    "axios.post": 0,
    "XMLHttpRequest.open": 1, // via instance aliasing: const xhr = new XMLHttpRequest()
};
const NEW_SINKS: Record<string, number> = {
    WebSocket: 0,
    EventSource: 0,
};

// Themes and plugins run on discord.com, so relative requests resolve there
function normalizeUrl(raw: string): string | null {
    const url = raw.trim();
    if (URL_PATTERN.test(url)) return url;
    if (url.startsWith("//")) return "https:" + url;
    if (url.startsWith("/") && !url.startsWith("/*")) return "https://discord.com" + url;
    return null;
}

// The host portion must be fully static for the finding to be useful
function hostIsStatic(url: string): boolean {
    const host = url.split("://")[1]?.split("/")[0] ?? "";
    return host.length > 0 && !host.includes(DYNAMIC_SEGMENT);
}

export const networkUrlRule: Rule = {
    name: "network-url",
    appliesTo: [Type.Plugin],

    finalize(context) {
        if (!context.ast) return null;
        const findings: Finding[] = [];

        interpretProgram(context.ast, (node, scope) => {
            const callee = node.type === "CallExpression" ? calleeOf(node) : node.callee as ESTree.Node;
            const raw = memberChain(callee);
            if (!raw) return;

            const chain = stripGlobal(resolveChain(stripGlobal(raw), context.aliases));
            let sink = chain.join(".");
            let urlIndex = node.type === "NewExpression" ? NEW_SINKS[sink] : CALL_SINKS[sink];

            // obj.open(method, url) — the XMLHttpRequest pattern; instances aren't statically nameable
            if (urlIndex === undefined && node.type === "CallExpression" && chain.length >= 2
                && chain[chain.length - 1] === "open" && node.arguments.length >= 2) {
                sink = "XMLHttpRequest.open";
                urlIndex = 1;
            }
            if (urlIndex === undefined) return;

            const argument = node.arguments[urlIndex];
            if (!argument || argument.type === "SpreadElement") return;

            const resolved = partialString(argument, scope);
            if (!resolved) return;
            const url = normalizeUrl(resolved.text);
            if (!url || !hostIsStatic(url)) return;

            findings.push({
                rule: "network-url",
                file: context.file,
                message: `URL passed to ${sink}: ${url}`,
                category: "network",
                severity: "info",
                details: {url, sink, exact: resolved.exact, resolved: argument.type !== "Literal"},
                loc: context.getLoc(node)
            });
        });

        return findings.length ? findings : null;
    }
};
