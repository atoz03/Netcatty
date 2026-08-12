/**
 * Narrowing helpers for the result unions used across the app.
 *
 * `tsconfig.json` leaves `strictNullChecks` off. Without it TypeScript refuses
 * to discriminate a union on a boolean-literal property (`{ ok: true } | { ok:
 * false }`) and will not drop an `{ error }` member from an `in` check, so the
 * idiomatic `if (!result.ok) return result.error` reads as an error even though
 * it is correct. These predicates narrow by assignability, which behaves the
 * same either way — so call sites keep working if the flag is ever turned on.
 */

/** Failure shape of the `T | { error: string }` parse helpers. */
export type ErrorResult = { error: string };

export function isErrorResult(value: unknown): value is ErrorResult {
  return typeof value === 'object' && value !== null && 'error' in value;
}

/** Narrow a `{ ok: true; … } | { ok: false; … }` union to its failure member. */
export function isFailedResult<T extends { ok: boolean }>(result: T): result is T & { ok: false } {
  return !result.ok;
}

/** Narrow a `{ ok: true; … } | { ok: false; … }` union to its success member. */
export function isOkResult<T extends { ok: boolean }>(result: T): result is T & { ok: true } {
  return result.ok;
}

/** As above for unions keyed on `success` instead of `ok`. */
export function isFailedSuccessResult<T extends { success: boolean }>(
  result: T,
): result is T & { success: false } {
  return !result.success;
}

export function isSucceededResult<T extends { success: boolean }>(
  result: T,
): result is T & { success: true } {
  return result.success;
}
