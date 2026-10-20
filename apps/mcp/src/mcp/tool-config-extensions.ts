import type { ToolConfig } from "@tedix/api-contract/schemas/tools";

export function readToolConfigExtension(
	config: ToolConfig,
	key: string,
): unknown {
	return (config as unknown as Record<string, unknown>)[key];
}

export function readToolConfigStringArray(
	config: ToolConfig,
	key: "fileParams" | "headerParams" | "queryParams" | "runtimeOnlyParams",
): string[] {
	const raw = readToolConfigExtension(config, key);
	if (!Array.isArray(raw)) return [];
	return raw.filter((item): item is string => typeof item === "string");
}

export function readToolConfigString(
	config: ToolConfig,
	key: "_aggregateTediOrgId",
): string | undefined {
	const raw = readToolConfigExtension(config, key);
	return typeof raw === "string" ? raw : undefined;
}
