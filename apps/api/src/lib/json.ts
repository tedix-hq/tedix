import type { JsonValue } from "@tedix/api-contract/schemas/common";

export function omitUndefined(
	input: Record<string, JsonValue | undefined>,
): Record<string, JsonValue> {
	return Object.fromEntries(
		Object.entries(input).filter(([, value]) => value !== undefined),
	) as Record<string, JsonValue>;
}
