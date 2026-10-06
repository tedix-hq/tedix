import { type ExtractedItem, normalizeItems } from "./item-normalization";

export function parseConfiguredExtractResult(
	result: unknown,
	arrayKey: string,
	fieldMappings?: Record<string, string[]>,
): ExtractedItem[] {
	if (!result || typeof result !== "object" || Array.isArray(result)) return [];
	const value = (result as Record<string, unknown>)[arrayKey];
	return Array.isArray(value) ? normalizeItems(value, fieldMappings) : [];
}
