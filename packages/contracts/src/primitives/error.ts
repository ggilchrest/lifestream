export type ErrorStatus = {
  code: string;
  message: string;
  retryable: boolean;
  correlationId: string;
};

export class LifestreamError extends Error {
  public readonly code: string;
  public readonly retryable: boolean;
  public readonly correlationId: string;

  public constructor(
    code: string,
    message: string,
    retryable: boolean,
    correlationId: string
  ) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.correlationId = correlationId;
    this.name = "LifestreamError";
  }

  toStatus(): ErrorStatus {
    return { code: this.code, message: this.message, retryable: this.retryable, correlationId: this.correlationId };
  }
}
