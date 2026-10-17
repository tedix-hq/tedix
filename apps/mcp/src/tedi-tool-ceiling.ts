/** The gateway stamps this from the fresh D1 profile after stripping client headers. */
export function readTediEndpointCeiling(
	raw: string | null,
): string[] | undefined {
	if (raw === null) return undefined;
	try {
		const value: unknown = JSON.parse(raw);
		return Array.isArray(value) &&
			value.length <= 100 &&
			value.every((x) => typeof x === "string")
			? value
			: [];
	} catch {
		return [];
	}
}
export function tediToolCeilingDenial(
	allowed: readonly string[] | undefined,
	transport: string,
	endpoint: unknown,
): string | null {
	if (allowed === undefined || transport === "catalog") return null;
	return transport === "rpc" &&
		typeof endpoint === "string" &&
		allowed.includes(endpoint)
		? null
		: "Tool is outside this tedi's configured endpoint ceiling";
}
