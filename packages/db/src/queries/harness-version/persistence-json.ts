import {
	type JsonValue,
	JsonValueSchema,
} from "@tedix/api-contract/schemas/common";

export type JsonObject = Record<string, JsonValue>;

export function parseJsonObject(value: unknown, boundary: string): JsonObject {
	const parsed = JsonValueSchema.parse(value);
	if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
		throw new TypeError(`${boundary} must be a JSON object`);
	}
	return parsed;
}

export function optionalJsonObject(
	value: unknown,
	boundary: string,
): JsonObject | undefined {
	return value == null ? undefined : parseJsonObject(value, boundary);
}

export function safeJsonObject(value: unknown): JsonObject | null {
	const parsed = JsonValueSchema.safeParse(value);
	if (
		!parsed.success ||
		parsed.data === null ||
		Array.isArray(parsed.data) ||
		typeof parsed.data !== "object"
	) {
		return null;
	}
	return parsed.data;
}
