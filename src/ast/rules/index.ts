import type {Rule} from "../types";
import {bdApiRule} from "./bdapi";
import {cssUrlRule} from "./cssurls";
import {evalRule} from "./eval";
import {innerHTMLRule} from "./innerhtml";
import {remoteUrlRule} from "./remoteurls";

export {bdApiRule, cssUrlRule, evalRule, innerHTMLRule, remoteUrlRule};

export const rules: Rule[] = [
    bdApiRule,
    cssUrlRule,
    evalRule,
    innerHTMLRule,
    remoteUrlRule,
];
