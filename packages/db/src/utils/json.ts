import type { JsonValue } from "@tedix/api-contract/schemas/common";

/**
 * JSON utilities for Drizzle ORM.
 *
 * Drizzle `{ mode: "json" }` columns are canonical for persisted JSON. New
 * JSON-mode writes should use their domain type directly, or the boundary
 * adapters below when an upstream structural type cannot satisfy TypeScript's
 * recursive JsonValue index signature.
 */

/**
 * Materialize the exact JSON value D1 will persist.
 *
 * The stringify/parse round trip deliberately matches Drizzle's JSON text
 * encoding, including omission of undefined object properties. JSON.stringify
 * supplies the fail-closed behavior for circular values and BigInt.
 */
export function toJsonValue(value: unknown): JsonValue {
	const serialized = JSON.stringify(value);
	if (serialized === undefined) {
		throw new TypeError("Value cannot be represented as JSON");
	}
	return JSON.parse(serialized) as JsonValue;
}

/** Materialize a JSON object, rejecting scalar and array values. */
export function toJsonRecord(value: unknown): Record<string, JsonValue> {
	const json = toJsonValue(value);
	if (json === null || typeof json !== "object" || Array.isArray(json)) {
		throw new TypeError("Value must serialize to a JSON object");
	}
	return json;
}

/** Stable JSON text across SQLite TEXT and Postgres jsonb; invalid legacy text is preserved. */
export function normalizeStoredJsonText(value: string | null): string | null {
	if (value === null) return null;
	try {
		const parsed: JsonValue = JSON.parse(value);
		return JSON.stringify(parsed, (_key, entry: JsonValue) =>
			entry && typeof entry === "object" && !Array.isArray(entry)
				? Object.fromEntries(
						Object.keys(entry)
							.sort()
							.map((key) => [key, entry[key]]),
					)
				: entry,
		);
	} catch {
		return value;
	}
}
