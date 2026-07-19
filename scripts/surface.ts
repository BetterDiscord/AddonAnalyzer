/**
 * Generates `src/data/bdapi-surface.json` — the checked-in inventory of BdApi's public
 * surface — from a BetterDiscord checkout. Run manually, never from `bun run analyze`:
 * CI has no BD checkout, and a stale manifest is fine where a broken build is not.
 *
 *     bun run scripts/surface.ts ../BetterDiscord
 *
 * The source of truth for *exposure* is `api/index.ts`: its `static` properties on class
 * BdApi are the names addons actually type (`BdApi.Plugins`), which are not the class
 * names behind them (`AddonAPI` serves both `Plugins` and `Themes`). Keying on files or
 * classes is the mistake this script exists to avoid.
 */

import fs from "fs/promises";
import path from "path";
import ts from "typescript";
import type {Surface, SurfaceNamespace} from "../src/surface";


function parse(file: string, text: string): ts.SourceFile {
    return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
}

function hasTag(node: ts.Node, tag: string): boolean {
    return ts.getJSDocTags(node).some(t => t.tagName.text === tag);
}

function nameOf(node: ts.PropertyName | undefined): string | null {
    if (!node) return null;
    if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
    return null;
}

function hasModifier(node: ts.HasModifiers, kind: ts.SyntaxKind): boolean {
    return (ts.getModifiers(node) ?? []).some(m => m.kind === kind);
}

// ---- BD core: the api/ directory -------------------------------------------

interface Member {name: string; deprecated: boolean;}

// Non-computed keys of an object literal, so `Filters = {byKeys(){}, ...}` contributes
// `Filters.byKeys` — the shape addons actually call.
function objectKeys(node: ts.Expression): string[] {
    if (!ts.isObjectLiteralExpression(node)) return [];
    const keys: string[] = [];
    for (const property of node.properties) {
        const name = nameOf(property.name);
        if (name) keys.push(name);
    }
    return keys;
}

// `Types = Types` where a top-level `const Types = {...}` sits in the same file
function resolveObjectLiteral(node: ts.Expression, source: ts.SourceFile): ts.Expression {
    if (!ts.isIdentifier(node)) return node;
    for (const statement of source.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name) && declaration.name.text === node.text && declaration.initializer) {
                return declaration.initializer;
            }
        }
    }
    return node;
}

function findClass(source: ts.SourceFile, name: string): ts.ClassDeclaration | null {
    for (const statement of source.statements) {
        if (ts.isClassDeclaration(statement) && statement.name?.text === name) return statement;
    }
    return null;
}

/**
 * Instance members of a class, following `extends` within the same file. The inheritance
 * walk is not optional: `class DOM extends BaseDOM` keeps only addStyle/removeStyle of
 * its own, so a base-blind reading would report `onAdded`, `animate`, `createElement`
 * and `parseHTML` as declared-nowhere and then as never-used.
 */
function membersOf(cls: ts.ClassDeclaration, source: ts.SourceFile, seen = new Set<string>()): Member[] {
    if (cls.name && seen.has(cls.name.text)) return [];
    if (cls.name) seen.add(cls.name.text);

    const members: Member[] = [];

    for (const clause of cls.heritageClauses ?? []) {
        if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
        for (const type of clause.types) {
            if (!ts.isIdentifier(type.expression)) continue;
            const base = findClass(source, type.expression.text);
            if (base) members.push(...membersOf(base, source, seen));
        }
    }

    for (const member of cls.members) {
        if (ts.isConstructorDeclaration(member)) continue;
        if (!ts.isPropertyDeclaration(member) && !ts.isMethodDeclaration(member)
            && !ts.isGetAccessorDeclaration(member) && !ts.isSetAccessorDeclaration(member)) continue;

        // `#private` fields and `private x` members are not surface
        if (member.name && ts.isPrivateIdentifier(member.name)) continue;
        if (hasModifier(member, ts.SyntaxKind.PrivateKeyword)) continue;

        // Statics live on the class, not on the instance BdApi exposes
        if (hasModifier(member, ts.SyntaxKind.StaticKeyword)) continue;

        // `@ignore` is BD's own marker for "documented nowhere, not for addons"
        if (hasTag(member, "ignore")) continue;

        const name = nameOf(member.name);
        if (!name) continue;

        const deprecated = hasTag(member, "deprecated");
        members.push({name, deprecated});

        if (ts.isPropertyDeclaration(member) && member.initializer) {
            const value = resolveObjectLiteral(member.initializer, source);
            for (const key of objectKeys(value)) members.push({name: `${name}.${key}`, deprecated});
        }
    }

    return members;
}

// ---- BD core: api/index.ts -------------------------------------------------

// Local module specifier a name is imported from, e.g. Patcher -> "./patcher".
// Anything not imported from ./ is out of the api/ directory and therefore not BD surface
// we can enumerate (React and ReactDOM are Discord's own modules).
function importSources(source: ts.SourceFile): Map<string, string> {
    const sources = new Map<string, string>();
    for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
        const specifier = statement.moduleSpecifier.text;
        const bindings = statement.importClause?.namedBindings;
        if (statement.importClause?.name) sources.set(statement.importClause.name.text, specifier);
        if (bindings && ts.isNamedImports(bindings)) {
            for (const element of bindings.elements) sources.set(element.name.text, specifier);
        }
    }
    return sources;
}

// `const PluginAPI = new AddonAPI(PluginManager)` -> PluginAPI: "AddonAPI"
function instanceClasses(source: ts.SourceFile): Map<string, string> {
    const instances = new Map<string, string>();
    for (const statement of source.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
            if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
            if (!ts.isNewExpression(declaration.initializer)) continue;
            if (!ts.isIdentifier(declaration.initializer.expression)) continue;
            instances.set(declaration.name.text, declaration.initializer.expression.text);
        }
    }
    return instances;
}

function typeName(node: ts.TypeNode | undefined): string | null {
    if (!node || !ts.isTypeReferenceNode(node) || !ts.isIdentifier(node.typeName)) return null;
    return node.typeName.text;
}

/**
 * Exposed name -> the class names behind it.
 *
 * Both halves of BD's static/getter pairs are read, because they disagree on purpose:
 * `static Patcher: Patcher` is what `BdApi.Patcher` gives, `get Patcher(): BoundPatcher`
 * is what `new BdApi("x").Patcher` gives. The analyzer's alias tracker collapses those
 * two onto one chain, so the manifest has to carry the union of both classes' members.
 */
function exposedNames(index: ts.SourceFile): Map<string, Set<string>> {
    const cls = findClass(index, "BdApi");
    if (!cls) throw new Error("could not find `class BdApi` in api/index.ts");

    const instances = instanceClasses(index);
    const exposed = new Map<string, Set<string>>();
    const add = (name: string, className: string | null | undefined) => {
        if (!exposed.has(name)) exposed.set(name, new Set());
        if (className) exposed.get(name)!.add(className);
    };

    for (const member of cls.members) {
        const name = nameOf(member.name);
        if (!name) continue;

        if (ts.isPropertyDeclaration(member) && hasModifier(member, ts.SyntaxKind.StaticKeyword)) {
            add(name, typeName(member.type));
            if (member.initializer && ts.isIdentifier(member.initializer)) {
                add(name, instances.get(member.initializer.text));
            }
        }
        else if (ts.isGetAccessorDeclaration(member)) {
            add(name, typeName(member.type));
        }
    }

    return exposed;
}

// ---- generation ------------------------------------------------------------

async function bdVersion(root: string): Promise<string> {
    try {
        const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as {version?: string};
        return pkg.version ?? "unknown";
    }
    catch {
        return "unknown";
    }
}

async function bdCommit(root: string): Promise<string> {
    const proc = Bun.spawn(["git", "-C", root, "rev-parse", "--short", "HEAD"], {stdout: "pipe", stderr: "ignore"});
    const out = (await new Response(proc.stdout).text()).trim();
    return (await proc.exited) === 0 && out ? out : "unknown";
}

async function build(root: string): Promise<Surface> {
    const apiFolder = path.join(root, "src", "betterdiscord", "api");
    const read = async (file: string) => parse(file, await fs.readFile(path.join(apiFolder, file), "utf8"));

    const index = await read("index.ts");
    const sources = importSources(index);
    const exposed = exposedNames(index);

    // One parse per api/*.ts, keyed by the "./name" specifier used in index.ts
    const modules = new Map<string, ts.SourceFile>();
    for (const specifier of new Set(sources.values())) {
        if (!specifier.startsWith("./")) continue;
        modules.set(specifier, await read(`${specifier.slice(2)}.ts`));
    }

    const namespaces: Record<string, SurfaceNamespace> = {};
    for (const [name, classNames] of [...exposed].sort(([a], [b]) => a.localeCompare(b))) {
        const members = new Map<string, boolean>();
        const classes: string[] = [];

        for (const className of [...classNames].sort()) {
            const specifier = sources.get(className);
            const source = specifier ? modules.get(specifier) : undefined;
            if (!source) continue; // not an api/ class: React, ReactDOM, version
            const cls = findClass(source, className);
            if (!cls) continue;
            classes.push(className);
            for (const member of membersOf(cls, source)) {
                members.set(member.name, (members.get(member.name) ?? false) || member.deprecated);
            }
        }

        namespaces[name] = {
            classes,
            // React/ReactDOM/version are not BD-defined: their members are Discord's or a
            // plain string. Marked opaque so nothing below them is ever called a phantom.
            opaque: classes.length === 0,
            members: [...members.keys()].sort(),
            deprecated: [...members].filter(([, d]) => d).map(([m]) => m).sort()
        };
    }

    return {
        source: {
            version: await bdVersion(root),
            commit: await bdCommit(root),
            generated: new Date().toISOString().slice(0, 10)
        },
        namespaces
    };
}

const root = process.argv[2];
if (!root) {
    console.error("usage: bun run scripts/surface.ts <path-to-BetterDiscord-checkout>");
    process.exit(1);
}

const surface = await build(root);
const out = path.join(import.meta.dir, "..", "src", "data", "bdapi-surface.json");
await fs.mkdir(path.dirname(out), {recursive: true});
await fs.writeFile(out, `${JSON.stringify(surface, null, 4)}\n`);

const total = Object.values(surface.namespaces).reduce((a, n) => a + n.members.length, 0);
console.log(`Wrote ${out}`);
console.log(`BD ${surface.source.version} (${surface.source.commit}): ${Object.keys(surface.namespaces).length} namespaces, ${total} members`);
for (const [name, ns] of Object.entries(surface.namespaces)) {
    console.log(`  BdApi.${name}${ns.opaque ? " (opaque)" : `  [${ns.classes.join(", ")}]  ${ns.members.length} members${ns.deprecated.length ? `, deprecated: ${ns.deprecated.join(", ")}` : ""}`}`);
}
