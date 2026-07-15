import type {Rule} from "../types";
import {bdApiRule} from "./bdapi";
import {cssUrlRule} from "./cssurls";
import {evalRule} from "./eval";
import {innerHTMLRule} from "./innerhtml";
import {networkUrlRule} from "./networkurls";
import {obfuscationRule} from "./obfuscation";
import {remoteUrlRule} from "./remoteurls";
import {requireRule} from "./requires";

export {bdApiRule, cssUrlRule, evalRule, innerHTMLRule, networkUrlRule, obfuscationRule, remoteUrlRule, requireRule};

export const rules: Rule[] = [
    bdApiRule,
    cssUrlRule,
    evalRule,
    innerHTMLRule,
    networkUrlRule,
    obfuscationRule,
    remoteUrlRule,
    requireRule,
];
