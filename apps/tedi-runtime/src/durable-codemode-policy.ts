export interface DurableCodeValidationResult {
	ok: boolean;
	error?: string;
}

/**
 * Catch the most damaging generated-code TDZ mistake before it becomes a
 * durable execution: shadowing a sandbox namespace while using that same
 * namespace in the initializer (`const mcp = await mcp.call_tool(...)`).
 */
export function validateDurableCodeSource(
	code: string,
	namespaces: readonly string[] = ["mcp", "codemode"],
): DurableCodeValidationResult {
	for (const namespace of namespaces) {
		const escaped = namespace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const pattern = new RegExp(
			`\\b(?:const|let|var)\\s+${escaped}\\s*=\\s*(?:await\\s+)?${escaped}\\s*\\.`,
		);
		if (pattern.test(code)) {
			return {
				ok: false,
				error: `Do not shadow the ${namespace} sandbox namespace. Rename the local variable and keep ${namespace}.* for tool calls.`,
			};
		}
	}
	return { ok: true };
}
