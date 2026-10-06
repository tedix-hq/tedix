const CODE_MODE_DIRECT_TOOL_NAMES = new Set(["code", "execute"]);

function rpcPayloadsNeedingCodeMode(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(rpcPayloadsNeedingCodeMode);
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	const method = typeof record.method === "string" ? record.method : "";
	if (method === "tools/list") return true;
	if (method !== "tools/call") return false;
	const params =
		record.params && typeof record.params === "object"
			? (record.params as Record<string, unknown>)
			: {};
	const toolName = typeof params.name === "string" ? params.name : "";
	return CODE_MODE_DIRECT_TOOL_NAMES.has(toolName);
}

export async function shouldHydrateCodeModeForMcpRequest(
	request: Request,
): Promise<boolean> {
	if (request.method !== "POST") return true;
	try {
		return rpcPayloadsNeedingCodeMode(await request.clone().json());
	} catch {
		return true;
	}
}
