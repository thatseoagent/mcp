/**
 * Result type for explicit error handling without try/catch.
 *
 * A discriminated union that forces the caller to handle both cases. The
 * analyzers return it so that a failure to read a site is a value the Tool
 * renders, not an exception that escapes into the transport.
 */
export type Result<T, E = Error> =
  | { success: true; data: T }
  | { success: false; error: E };

export function success<T>(data: T): Result<T, never> {
  return { success: true, data };
}

export function failure<E = Error>(error: E): Result<never, E> {
  return { success: false, error };
}
