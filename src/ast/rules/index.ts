import type {Rule} from "../types";
import {bdApiRule} from "./bdapi";
import {classLiteralsRule} from "./classliterals";
import {cssUrlRule} from "./cssurls";
import {cssVariablesRule} from "./cssvariables";
import {evalRule} from "./eval";
import {globalsRule} from "./globals";
import {innerHTMLRule} from "./innerhtml";
import {lifecycleRule} from "./lifecycle";
import {metaRule} from "./meta";
import {networkUrlRule} from "./networkurls";
import {obfuscationRule} from "./obfuscation";
import {reactHazardsRule} from "./reacthazards";
import {remoteUrlRule} from "./remoteurls";
import {requireRule} from "./requires";
import {selfUpdateRule} from "./selfupdate";
import {patcherTargetsRule, webpackTargetsRule} from "./webpacktargets";

export {bdApiRule, classLiteralsRule, cssUrlRule, cssVariablesRule, evalRule, globalsRule, innerHTMLRule, lifecycleRule, metaRule, networkUrlRule, obfuscationRule, reactHazardsRule, remoteUrlRule, requireRule, selfUpdateRule, webpackTargetsRule, patcherTargetsRule};

export const rules: Rule[] = [
    bdApiRule,
    classLiteralsRule,
    cssUrlRule,
    cssVariablesRule,
    evalRule,
    globalsRule,
    innerHTMLRule,
    lifecycleRule,
    metaRule,
    networkUrlRule,
    obfuscationRule,
    reactHazardsRule,
    remoteUrlRule,
    requireRule,
    selfUpdateRule,
    webpackTargetsRule,
    patcherTargetsRule,
];
