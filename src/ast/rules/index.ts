import type {Rule} from "../types";
import {bdApiRule} from "./bdapi";
import {cssUrlRule} from "./cssurls";
import {evalRule} from "./eval";
import {innerHTMLRule} from "./innerhtml";
import {networkUrlRule} from "./networkurls";
import {remoteUrlRule} from "./remoteurls";

export {bdApiRule, cssUrlRule, evalRule, innerHTMLRule, networkUrlRule, remoteUrlRule};

export const rules: Rule[] = [
    bdApiRule,
    cssUrlRule,
    evalRule,
    innerHTMLRule,
    networkUrlRule,
    remoteUrlRule,
];
