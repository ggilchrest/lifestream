export type ValidationError = {
  instancePath: string;
  keyword: string;
  message: string;
};

export const safeValidationErrors = (errors: readonly ValidationError[] | null | undefined) =>
  (errors ?? []).map(({ instancePath, keyword, message }) => ({ instancePath, keyword, message }));
