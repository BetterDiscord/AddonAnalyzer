export type PEValue =
    | {kind: "string"; value: string;}
    | {kind: "number"; value: number;}
    | {kind: "boolean"; value: boolean;}
    | {kind: "object"; value: Record<string, PEValue>;}
    | {kind: "array"; value: PEValue[];}
    | {kind: "unknown";};

export const Unknown: PEValue = {kind: "unknown"};
