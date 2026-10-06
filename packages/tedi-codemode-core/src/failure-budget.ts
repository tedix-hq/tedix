export interface FailureBudgetState {
	attempts: number;
	blocked: boolean;
	limit: number;
}

/**
 * Key-collation contract: object keys sort by `localeCompare`. Feeds the
 * identical-call failure-budget keys below — every runtime instance must
 * derive the SAME key for the same args or a repeated failing call escapes
 * its budget. Deliberately NOT unified with the codepoint-sorted
 * `canonicalJson` in `@tedix/db/queries/catalog/tool-source-policy` — the two
 * collations differ (e.g. case ordering) and that one feeds persisted
 * digests, so neither can adopt the other's ordering.
 */
function canonicalJson(value: unknown): string {
	if (Array.isArray(value))
		return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "undefined";
}

export function buildIdenticalCallKey(
	toolName: string,
	args: Record<string, unknown>,
): string {
	const source = canonicalJson(args);
	let hash = 0x811c9dc5;
	for (let index = 0; index < source.length; index += 1) {
		hash ^= source.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return `${toolName}:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export class IdenticalFailureBudget {
	readonly #attempts = new Map<string, number>();

	constructor(readonly limit = 2) {
		if (!Number.isInteger(limit) || limit < 1)
			throw new Error("failure budget limit must be a positive integer");
	}

	state(key: string): FailureBudgetState {
		const attempts = this.#attempts.get(key) ?? 0;
		return { attempts, blocked: attempts >= this.limit, limit: this.limit };
	}

	recordFailure(key: string): FailureBudgetState {
		this.#attempts.set(key, (this.#attempts.get(key) ?? 0) + 1);
		return this.state(key);
	}

	recordSuccess(key: string): FailureBudgetState {
		this.#attempts.delete(key);
		return this.state(key);
	}
}
