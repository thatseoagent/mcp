/**
 * Type guards and type utilities for type-safe operations.
 * Provides reusable type checking functions to avoid 'any' usage.
 */

/**
 * Check if value is a record (plain object).
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Check if value is a string.
 */
export function isString(value: unknown): value is string {
  return typeof value === "string";
}

/**
 * Check if value is a number.
 */
export function isNumber(value: unknown): value is number {
  return typeof value === "number" && !Number.isNaN(value);
}

/**
 * Check if value is a boolean.
 */
export function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/**
 * Check if value is an array.
 */
export function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/**
 * Check if value is an array of specific type.
 */
export function isArrayOf<T>(
  value: unknown,
  guard: (item: unknown) => item is T
): value is T[] {
  return Array.isArray(value) && value.every(guard);
}

/**
 * JSON value type (no functions, no undefined).
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Check if value is valid JSON.
 */
export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (typeof value === "string") return true;
  if (typeof value === "number" && !Number.isNaN(value)) return true;
  if (typeof value === "boolean") return true;

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  if (isRecord(value)) {
    return Object.values(value).every(isJsonValue);
  }

  return false;
}

/**
 * Schema object type (JSON-LD, Microdata, etc.)
 */
export interface SchemaObject {
  "@type"?: string | string[];
  [key: string]: unknown;
}

/**
 * API error type from Google APIs.
 */
export interface ApiError {
  code?: number;
  message?: string;
  details?: Array<{
    message?: string;
    domain?: string;
    reason?: string;
  }>;
  status?: string;
}

/**
 * Check if error is an API error.
 */
export function isApiError(error: unknown): error is ApiError {
  return (
    isRecord(error) &&
    ("code" in error || "message" in error || "details" in error)
  );
}

/**
 * Assert that a value is defined (not null or undefined).
 */
export function assertDefined<T>(
  value: T | null | undefined,
  message?: string
): asserts value is T {
  if (value === null || value === undefined) {
    throw new Error(message || "Value is null or undefined");
  }
}

/**
 * Assert that a value is a string.
 */
export function assertString(
  value: unknown,
  message?: string
): asserts value is string {
  if (!isString(value)) {
    throw new Error(message || "Value is not a string");
  }
}

/**
 * Assert that a value is a record.
 */
export function assertRecord(
  value: unknown,
  message?: string
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(message || "Value is not an object");
  }
}

/**
 * Assert that a value is an array.
 */
export function assertArray(
  value: unknown,
  message?: string
): asserts value is unknown[] {
  if (!isArray(value)) {
    throw new Error(message || "Value is not an array");
  }
}

/**
 * Assert that a value is a number.
 */
export function assertNumber(
  value: unknown,
  message?: string
): asserts value is number {
  if (!isNumber(value)) {
    throw new Error(message || "Value is not a number");
  }
}

// ================================
// Result Type Pattern
// ================================

/**
 * Result type for explicit error handling without try/catch.
 * Discriminated union that forces consumers to handle both success and error cases.
 *
 * @template T - The type of the successful result data
 * @template E - The type of the error (defaults to Error)
 *
 * @example
 * ```typescript
 * function divide(a: number, b: number): Result<number> {
 *   if (b === 0) {
 *     return failure(new Error("Division by zero"));
 *   }
 *   return success(a / b);
 * }
 *
 * const result = divide(10, 2);
 * if (result.success) {
 *   console.log(result.data); // Type: number
 * } else {
 *   console.error(result.error); // Type: Error
 * }
 * ```
 *
 * @example
 * ```typescript
 * // Custom error type
 * type ValidationError = { field: string; message: string };
 *
 * function validateEmail(email: string): Result<string, ValidationError> {
 *   if (!email.includes("@")) {
 *     return failure({ field: "email", message: "Invalid email" });
 *   }
 *   return success(email);
 * }
 * ```
 */
export type Result<T, E = Error> =
  | { success: true; data: T }
  | { success: false; error: E };

/**
 * Create a successful Result.
 */
export function success<T>(data: T): Result<T, never> {
  return { success: true, data };
}

/**
 * Create a failed Result.
 */
export function failure<E = Error>(error: E): Result<never, E> {
  return { success: false, error };
}

/**
 * Unwrap a Result, throwing if it's an error.
 * Use when you want to convert Result back to exception-based flow.
 */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.success) {
    return result.data;
  }
  throw result.error;
}

/**
 * Map a successful Result to a new value.
 * Error results pass through unchanged.
 *
 * @template T - Input data type
 * @template U - Output data type
 * @template E - Error type
 *
 * @example
 * ```typescript
 * const result: Result<number> = success(5);
 * const doubled = mapResult(result, x => x * 2);
 * // doubled: Result<number> = { success: true, data: 10 }
 *
 * const error: Result<number> = failure(new Error("oops"));
 * const stillError = mapResult(error, x => x * 2);
 * // stillError: Result<number> = { success: false, error: Error("oops") }
 * ```
 */
export function mapResult<T, U, E>(
  result: Result<T, E>,
  fn: (data: T) => U,
): Result<U, E> {
  if (result.success) {
    return success(fn(result.data));
  }
  return result;
}

/**
 * Chain Result-returning operations (also known as "bind" or "flatMap").
 * If the first Result is successful, apply fn to its data.
 * If it's an error, pass the error through.
 *
 * @template T - Input data type
 * @template U - Output data type
 * @template E - Error type
 *
 * @example
 * ```typescript
 * function parseNumber(str: string): Result<number> {
 *   const num = parseInt(str);
 *   return isNaN(num) ? failure(new Error("Not a number")) : success(num);
 * }
 *
 * function divide(a: number, b: number): Result<number> {
 *   return b === 0
 *     ? failure(new Error("Division by zero"))
 *     : success(a / b);
 * }
 *
 * // Chain operations: parse "10", then divide by 2
 * const result = flatMapResult(
 *   parseNumber("10"),
 *   num => divide(num, 2)
 * );
 * // result: Result<number> = { success: true, data: 5 }
 *
 * // If first operation fails, second is never called
 * const errorResult = flatMapResult(
 *   parseNumber("abc"),
 *   num => divide(num, 2)
 * );
 * // errorResult: Result<number> = { success: false, error: Error("Not a number") }
 * ```
 */
export function flatMapResult<T, U, E>(
  result: Result<T, E>,
  fn: (data: T) => Result<U, E>,
): Result<U, E> {
  if (result.success) {
    return fn(result.data);
  }
  return result;
}
