export const evalRule: Rule = {
    name: "eval-detection",
    appliesTo: ["plugin"],

    visitJs(node, context) {
        if (
            node.type === "CallExpression" &&
            node.callee?.type === "Identifier" &&
            node.callee.name === "eval"
        ) {
            this._hits ??= [];
            this._hits.push({
                loc: context.getLoc?.(node),
            });
        }
    },

    finalize(context) {
        if (!this._hits?.length) return null;

        return this._hits.map(hit => ({
            rule: "eval-detection",
            file: context.file,
            addonType: context.addonType,
            message: "Use of eval detected",
            category: "security",
            severity: "error",
            details: {},
            loc: hit.loc,
        }));
    }
};
