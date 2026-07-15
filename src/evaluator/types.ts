export type PEValue =
    | {kind: "string"; value: string;}
    | {kind: "number"; value: number;}
    | {kind: "boolean"; value: boolean;}
    | {kind: "object"; value: Record<string, PEValue>;}
    | {kind: "unknown";};

export const Unknown: PEValue = {kind: "unknown"};

export function isUnknown(v: PEValue): boolean {
    return v.kind === "unknown";
}
