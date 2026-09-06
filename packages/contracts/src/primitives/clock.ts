export type Clock = { now(): string };

export class SystemClock implements Clock {
  now(): string {
    return new Date().toISOString();
  }
}

export class FixedClock implements Clock {
  private readonly value: string;

  public constructor(value: string) {
    this.value = value;
  }

  now(): string {
    return this.value;
  }
}
