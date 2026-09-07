export type AuthorityMode = "fixture" | "external";
export type AuthorityComposition = { mode: AuthorityMode; administrationPath: string; dispatchExposed: false; denyByDefaultWhenUnavailable: true };
export function createAuthorityComposition(mode: AuthorityMode = "fixture"): AuthorityComposition { if (mode !== "fixture") throw new Error("non-fixture authority requires explicit LS-DEC-025 resolution"); return { mode, administrationPath: "/api/authority/v1", dispatchExposed: false, denyByDefaultWhenUnavailable: true }; }
