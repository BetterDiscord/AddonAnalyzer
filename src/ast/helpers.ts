import type {ESTree} from "meriyah";


// meriyah types CallExpression.callee as `any`
export function calleeOf(node: ESTree.CallExpression | ESTree.NewExpression): ESTree.Node {
    return node.callee as ESTree.Node;
}

// Static name of a member access: foo.bar and foo["bar"] both yield "bar", dynamic keys yield null
export function propertyName(member: ESTree.MemberExpression): string | null {
    if (!member.computed && member.property.type === "Identifier") return member.property.name;
    if (member.property.type === "Literal" && typeof member.property.value === "string") return member.property.value;
    return null;
}
