import type {Rule} from "../types";
import {bdApiRule} from "./bdapi";
import {classLiteralsRule} from "./classliterals";
import {cssUrlRule} from "./cssurls";
import {evalRule} from "./eval";
import {globalsRule} from "./globals";
import {innerHTMLRule} from "./innerhtml";
import {metaRule} from "./meta";
import {networkUrlRule} from "./networkurls";
import {obfuscationRule} from "./obfuscation";
import {reactHazardsRule} from "./reacthazards";
import {remoteUrlRule} from "./remoteurls";
import {requireRule} from "./requires";
import {selfUpdateRule} from "./selfupdate";
import {patcherTargetsRule, webpackTargetsRule} from "./webpacktargets";

export {bdApiRule, classLiteralsRule, cssUrlRule, evalRule, globalsRule, innerHTMLRule, metaRule, networkUrlRule, obfuscationRule, reactHazardsRule, remoteUrlRule, requireRule, selfUpdateRule, webpackTargetsRule, patcherTargetsRule};

export const rules: Rule[] = [
    bdApiRule,
    classLiteralsRule,
    cssUrlRule,
    evalRule,
    globalsRule,
    innerHTMLRule,
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
