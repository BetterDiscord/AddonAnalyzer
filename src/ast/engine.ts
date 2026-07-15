import {parseSync} from "@swc/core";
import type {Rule, RuleContext} from "./engine";

export function analyzeFile(path: string, code: string, rules: Rule[]) {
    const ast = parseSync(code, {
        syntax: "ecmascript",
        target: "es2022",
        script: true,
    });

    const findings: any[] = [];

    const context: RuleContext = {
        file: path,
        getLoc(node) {
            if (!node.span || !ast.loc?.getLineAndColumn) return null;
            const {line, column} = ast.loc.getLineAndColumn(node.span.start);
            return {line, column};
        }
    };

    walk(ast, (node) => {
        for (const rule of rules) {
            if (rule.match(node)) {
                const result = rule.report(node, context);
                if (result) findings.push(result);
            }
        }
    });

    return findings;
}

// simple DFS walker
function walk(node: any, visit: (n: any) => void) {
    const stack = [node];
    while (stack.length) {
        const cur = stack.pop();
        if (!cur || typeof cur !== "object") continue;
        visit(cur);
        for (const key of Object.keys(cur)) {
            const val = cur[key];
            if (Array.isArray(val)) stack.push(...val);
            else if (val && typeof val === "object") stack.push(val);
        }
    }
}
