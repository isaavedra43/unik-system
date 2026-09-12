/** Stable error with HTTP status used by every communications service. */
export class CommsError extends Error {
  constructor(
    message: string,
    public readonly status: number = 400,
    public readonly code?: string
  ) {
    super(message);
    this.name = 'CommsError';
  }
}

export function assertFound<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new CommsError(message, 404, 'not_found');
  return value;
}
