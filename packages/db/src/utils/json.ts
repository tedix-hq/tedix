import type { JsonValue } from "@tedix/api-contract/schemas/common";

/**
 * JSON utilities for Drizzle ORM.
 *
 * Drizzle `{ mode: "json" }` columns are canonical for persisted JSON. The
 * manual parse/stringify helpers remain only for legacy TEXT columns that have
 * not yet migrated to JSON mode. New JSON-mode writes should use their domain
 * type directly, or the boundary adapters below when an upstream structural
 * type cannot satisfy TypeScript's recursive JsonValue index signature.
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

/**
 * Parse a legacy TEXT JSON field with null support and invalid-data recovery.
 * Do not use this for Drizzle `{ mode: "json" }` columns.
 */
export function parseJsonField<T>(
	value: T | string | null | undefined,
): T | null {
	if (value == null) return null;
	if (typeof value !== "string") return value;
	if (!value) return null;
	try {
		return JSON.parse(value) as T;
	} catch {
		return null;
	}
}

/**
 * Stringify a legacy TEXT JSON field. Do not use this for Drizzle
 * `{ mode: "json" }` columns.
 */
export function stringifyJsonField<T>(
	value: T | null | undefined,
): string | null {
	if (value === null || value === undefined) return null;
	try {
		return JSON.stringify(value);
	} catch {
		return null;
	}
}
