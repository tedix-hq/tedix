function structuredValue(value: unknown): object | null {
	if (value !== null && typeof value === "object") return value;
	if (typeof value !== "string") return null;
	let candidate = value.trim();
	if (candidate.startsWith("```")) {
		const fence =
			/^```[ \t]*(?:json|jsonc|json5)?[ \t]*\n([\s\S]*?)\n?```$/i.exec(
				candidate,
			);
		if (!fence) return null;
		candidate = (fence[1] ?? "").trim();
	} else {
		const inline = /^(`{1,2})([\s\S]*?)\1$/.exec(candidate);
		if (inline) candidate = (inline[2] ?? "").trim();
	}
	if (!candidate.startsWith("{") && !candidate.startsWith("[")) return null;
	try {
		const parsed: unknown = JSON.parse(candidate);
		return parsed !== null && typeof parsed === "object" ? parsed : null;
	} catch {
		return null;
	}
}

function structuredRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function containsCompletionEvidence(
	value: unknown,
	predicate: (evidence: Record<string, unknown>) => boolean,
	depth = 0,
): boolean {
	if (depth > 8 || value === null || value === undefined) return false;
	if (typeof value === "string") {
		const parsed = structuredValue(value);
		return parsed
			? containsCompletionEvidence(parsed, predicate, depth + 1)
			: false;
	}
	if (Array.isArray(value)) {
		return value.some((item) =>
			containsCompletionEvidence(item, predicate, depth + 1),
		);
	}
	if (typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	const evidence = structuredRecord(record.completionEvidence);
	if (evidence && predicate(evidence)) return true;
	return Object.values(record).some((item) =>
		containsCompletionEvidence(item, predicate, depth + 1),
	);
}

export function hasSuccessfulCompletionEvidence(value: unknown): boolean {
	return containsCompletionEvidence(value, (evidence) => {
		return (
			evidence.status === "succeeded" &&
			Array.isArray(evidence.supportedClaims) &&
			evidence.supportedClaims.some(
				(claim) => typeof claim === "string" && claim.trim().length > 0,
			)
		);
	});
}

export function hasTerminalJobCompletionEvidence(value: unknown): boolean {
	return containsCompletionEvidence(value, (evidence) => {
		return (
			(evidence.operation === "exec" ||
				evidence.operation === "read_execution") &&
			evidence.status === "succeeded" &&
			Array.isArray(evidence.supportedClaims) &&
			evidence.supportedClaims.includes("the command completed successfully")
		);
	});
}
