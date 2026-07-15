import {node} from "@zerebos/eslint-config";
import ts from "@zerebos/eslint-config-typescript";
import {defineConfig} from "eslint/config";


/** @type {import("@zerebos/eslint-config-typescript").ConfigArray} */
export default defineConfig(
    ...node,
    ...ts.configs.recommendedWithTypes,
    {
        rules: {
            "no-console": "warn"
        }
    },
    {
        ignores: ["**/debug/**", "**/node_modules/**"]
    },
);