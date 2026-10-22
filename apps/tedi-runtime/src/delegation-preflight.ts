import type { DelegationCapabilityPlan } from "@tedix/api-contract/schemas/kernel-runtime";
import { codeModeLiteral } from "@tedix/api-contract/utils/code-mode-literal";

/** MCP transports may wrap or objectify a Code Mode array. Never accept a clipped result. */
function discoveryRows(value: unknown, depth = 0): unknown[] | null {
	if (Array.isArray(value)) return value;
	if (depth > 3) return null;
	if (typeof value === "string") {
		if (value.length > 300_000) return null;
		try {
			return discoveryRows(JSON.parse(value), depth + 1);
		} catch {
			return null;
		}
	}
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	if (record.__tedix_truncated === true) return null;
	for (const key of ["result", "results", "data"]) {
		if (!Object.hasOwn(record, key)) continue;
		const rows = discoveryRows(record[key], depth + 1);
		if (rows) return rows;
	}
	const keys = Object.keys(record).filter((key) => key !== "length");
	if (!keys.length || keys.some((key) => !/^(0|[1-9]\d*)$/.test(key)))
		return null;
	keys.sort((a, b) => Number(a) - Number(b));
	if (
		keys.some((key, index) => Number(key) !== index) ||
		(record.length !== undefined && record.length !== keys.length)
	)
		return null;
	return keys.map((key) => record[key]);
}

export function assertNativeResearchCheckout(
	plan: DelegationCapabilityPlan | undefined,
	environment: { ready: boolean; preparation: string } | undefined,
): void {
	if (!plan?.requiredCapabilities.includes("repository.read")) return;
	if (!environment?.ready || environment.preparation !== "repository")
		throw new Error(
			"Delegation preflight failed: empty or unready native repository checkout. Source research cannot run here; return to Home for a prepared checkout or bounded source selection (large repositories may be too_large_for_native). No clone or workstation setup was attempted",
		);
}

const CATALOG_NOT_EXPOSED = /is not exposed in the current gateway catalog/i;
const CATALOG_RETRY_DELAYS_MS = [1_500, 4_000];

/**
 * A busy gateway can serve a degraded catalog that omits whole namespaces.
 * Re-read it a bounded number of times; an authority verdict is never assumed.
 */
async function executeWithCatalogRetry(
	execute: (code: string) => Promise<unknown>,
	code: string,
	delaysMs: readonly number[],
): Promise<unknown> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await execute(code);
		} catch (error) {
			const delay = delaysMs[attempt];
			const message = error instanceof Error ? error.message : String(error);
			if (delay === undefined || !CATALOG_NOT_EXPOSED.test(message))
				throw error;
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}
}

/** Read metadata with the child's own credential; discovery never grants access. */
export async function preflightDelegationTools(
	plan: DelegationCapabilityPlan | undefined,
	execute: (code: string) => Promise<unknown>,
	retryDelaysMs: readonly number[] = CATALOG_RETRY_DELAYS_MS,
): Promise<string[]> {
	if (!plan) return [];
	if (plan.missingCapabilities.length)
		throw new Error(
			`Delegation preflight failed: missing capabilities ${plan.missingCapabilities.join(", ")}; return to Home without inference or setup`,
		);
	const callables = [
		...new Set(plan.allowedToolIds.filter((id) => id.includes("."))),
	];
	if (!callables.length) return [];
	if (
		callables.length > 16 ||
		callables.some((id) => !/^[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*$/.test(id))
	)
		throw new Error(
			"Delegation preflight failed: invalid or excessive required callables",
		);
	const code = `async () => await Promise.all(${codeModeLiteral(callables)}.map(async (callable) => { const row = await discover.describe(callable); return { callable: row.callable, authorized: row.authorized, missingScopes: row.missingScopes, parameters: row.parameters }; }))`;
	const result = await executeWithCatalogRetry(execute, code, retryDelaysMs);
	const rows = discoveryRows(result);
	if (!rows)
		throw new Error(
			`Delegation preflight failed: tool authority could not be verified (${typeof result}${result && typeof result === "object" ? ` keys=${Object.keys(result).slice(0, 6).join(",").slice(0, 200)}` : ""}); return to Home`,
		);
	return callables.map((callable) => {
		const row = rows.find(
			(value): value is Record<string, unknown> =>
				!!value &&
				typeof value === "object" &&
				"callable" in value &&
				value.callable === callable,
		);
		if (
			!row ||
			row.authorized !== true ||
			!row.parameters ||
			typeof row.parameters !== "object"
		)
			throw new Error(
				`Delegation preflight failed: ${callable} is unavailable or unauthorized; missing scopes: ${Array.isArray(row?.missingScopes) ? row.missingScopes.join(", ") : "unverified"}. No scopes were added; return to Home`,
			);
		const schema = JSON.stringify({ callable, parameters: row.parameters });
		if (schema.length > 16000)
			throw new Error(
				`Delegation preflight failed: schema too large for ${callable}`,
			);
		return schema;
	});
}
