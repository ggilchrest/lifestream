export function checkConflict(expectedRevision: number, actualRevision: number): void { if (expectedRevision !== actualRevision) throw new Error("proposal conflict"); }
