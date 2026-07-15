import type {Rule} from "../types";
import {bdApiRule} from "./bdapi";
import {evalRule} from "./eval";
import {innerHTMLRule} from "./innerhtml";
import {remoteUrlRule} from "./remoteurls";

export {bdApiRule, evalRule, innerHTMLRule, remoteUrlRule};

export const rules: Rule[] = [
    bdApiRule,
    evalRule,
    innerHTMLRule,
    remoteUrlRule,
];
