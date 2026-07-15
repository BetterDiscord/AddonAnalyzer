import type {Rule} from "../types";
import {bdApiRule} from "./bdapi";
import {classLiteralsRule} from "./classliterals";
import {cssUrlRule} from "./cssurls";
import {evalRule} from "./eval";
import {globalsRule} from "./globals";
import {innerHTMLRule} from "./innerhtml";
import {networkUrlRule} from "./networkurls";
import {obfuscationRule} from "./obfuscation";
import {reactHazardsRule} from "./reacthazards";
import {remoteUrlRule} from "./remoteurls";
import {requireRule} from "./requires";
import {patcherTargetsRule, webpackTargetsRule} from "./webpacktargets";

export {bdApiRule, classLiteralsRule, cssUrlRule, evalRule, globalsRule, innerHTMLRule, networkUrlRule, obfuscationRule, reactHazardsRule, remoteUrlRule, requireRule, webpackTargetsRule, patcherTargetsRule};

export const rules: Rule[] = [
    bdApiRule,
    classLiteralsRule,
    cssUrlRule,
    evalRule,
    globalsRule,
    innerHTMLRule,
    networkUrlRule,
    obfuscationRule,
    reactHazardsRule,
    remoteUrlRule,
    requireRule,
    webpackTargetsRule,
    patcherTargetsRule,
];
