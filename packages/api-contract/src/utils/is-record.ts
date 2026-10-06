/** A non-null, non-array object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `value` as a record, or `null` when it is not a non-null, non-array object. */
export function asRecord(value: unknown): Record<string, unknown> | null {
	return isRecord(value) ? value : null;
}
