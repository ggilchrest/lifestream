export type AuthorityMode = "fixture" | "local" | "external";
export type AuthorityComposition = { mode: AuthorityMode; administrationPath: string; dispatchExposed: false; denyByDefaultWhenUnavailable: true };
export function createAuthorityComposition(mode: AuthorityMode = "fixture"): AuthorityComposition { if (mode === "external") throw new Error("external authority adapter is unavailable in this composition"); return { mode, administrationPath: "/api/authority/v1", dispatchExposed: false, denyByDefaultWhenUnavailable: true }; }
