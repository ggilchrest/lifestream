export type WorldFact = { id: string; content: string; rank: number };
export class FixtureWorldProvider { constructor(private readonly facts: WorldFact[] = []) {} query(): WorldFact[] { return this.facts.map((f) => ({ ...f })); } }
