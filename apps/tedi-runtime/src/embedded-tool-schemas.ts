/** What one metadata read produced: the schemas, and what did not survive it. */
export interface EmbeddedToolSchemaResolution {
	/** Serialized `{callable, parameters}` rows, ready for the tool description. */
	schemas: string[];
	/** Admitted callables the read returned nothing usable for. */
	missing: string[];
}

/** Resolve only signed admitted callables; metadata never grants execution authority. */
export async function resolveEmbeddedToolSchemas(
	callables: readonly string[],
	execute: (code: string) => Promise<unknown>,
): Promise<EmbeddedToolSchemaResolution> {
	const admitted = [...new Set(callables)].filter((value) =>
		/^[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*$/.test(value),
	);
	if (!admitted.length) return { schemas: [], missing: [] };
	// Bound per-turn metadata work independently of profile size.
	const selected = admitted.slice(0, 16);
	const result = await execute(
		`async () => await Promise.all(${JSON.stringify(selected)}.map(async (callable) => { const definition = await discover.describe(callable); return definition ? { callable: definition.callable, parameters: definition.parameters } : null; }))`,
	);
	// A truncated or failed read resolves nothing; the caller retries rather
	// than treating an empty answer as "these tools have no parameters".
	if (!Array.isArray(result)) return { schemas: [], missing: selected };
	let remainingChars = 32000;
	const resolved = new Set<string>();
	const schemas = result.flatMap((value) => {
		if (!value || typeof value !== "object") return [];
		const row = value as Record<string, unknown>;
		if (
			typeof row.callable !== "string" ||
			!selected.includes(row.callable) ||
			!row.parameters ||
			typeof row.parameters !== "object" ||
			Array.isArray(row.parameters)
		)
			return [];
		const text = JSON.stringify({
			callable: row.callable,
			parameters: row.parameters,
		});
		if (text.length > 16000 || text.length > remainingChars) return [];
		remainingChars -= text.length;
		resolved.add(row.callable);
		return [text];
	});
	// A callable admitted by the signed profile but absent here cannot be called:
	// it is not mounted on this session's gateway, or its describe returned
	// nothing. Naming it is what lets the caller stop advertising it and lets an
	// operator see the cause instead of a model apologizing in the transcript.
	return {
		schemas,
		missing: selected.filter((callable) => !resolved.has(callable)),
	};
}
