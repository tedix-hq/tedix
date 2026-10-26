import type { DelegationCapabilityPlan } from "@tedix/api-contract/schemas/kernel-runtime";
import { codeModeLiteral } from "@tedix/api-contract/utils/code-mode-literal";
import { isCodeModeResultHandle } from "@tedix/tedi-codemode-core/bounded-result";

/** MCP transports may wrap or objectify a Code Mode array. Never accept a clipped result. */
export function discoveryRows(value: unknown, depth = 0): unknown[] | null {
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

/** Find the record a Code Mode transport wrapped (JSON text or `result`/`data`). */
function codeModeRecord(
	value: unknown,
	match: (record: Record<string, unknown>) => boolean,
	depth = 0,
): Record<string, unknown> | null {
	if (depth > 3) return null;
	if (typeof value === "string") {
		if (value.length > 300_000) return null;
		try {
			return codeModeRecord(JSON.parse(value), match, depth + 1);
		} catch {
			return null;
		}
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (match(record)) return record;
	for (const key of ["result", "data"]) {
		if (!Object.hasOwn(record, key)) continue;
		const found = codeModeRecord(record[key], match, depth + 1);
		if (found) return found;
	}
	return null;
}

/** JSON-escaped page text must stay under the gateway's own result budget. */
const RESULT_PAGE_CHARS = 10_000;
/** 16 callables at the 16k schema cap still fit. */
const MAX_RESULT_PAGES = 32;

/**
 * The gateway keeps an over-budget `code` result behind a
 * `__tedix_result_handle` envelope. Page it back in full through
 * `discover.read_result` with the same credential; the reassembled value is
 * then verified like an inline one. Returns `result` unchanged when it is not
 * a handle, and `null` when a page is unusable, so authority is never read
 * from a preview.
 */
async function resolveCodeModeResultHandle(
	result: unknown,
	execute: (code: string) => Promise<unknown>,
	pageChars = RESULT_PAGE_CHARS,
): Promise<unknown> {
	const envelope = codeModeRecord(result, isCodeModeResultHandle);
	if (!envelope) return result;
	const handle = envelope.handle;
	if (typeof handle !== "string" || !/^[\w-]{1,128}$/.test(handle)) return null;
	const parts: string[] = [];
	let offset = 0;
	for (let page = 0; page < MAX_RESULT_PAGES; page++) {
		const data = codeModeRecord(
			await execute(
				`async () => await discover.read_result(${codeModeLiteral({ handle, offset, limit: pageChars })})`,
			),
			(record) =>
				record.handle === handle &&
				record.__tedix_result_handle !== true &&
				(record.complete === true || typeof record.text === "string"),
		);
		if (!data) return null;
		if (data.complete === true && "value" in data && !parts.length)
			return data.value;
		if (typeof data.text !== "string") return null;
		parts.push(data.text);
		if (data.nextOffset === undefined) {
			try {
				return JSON.parse(parts.join(""));
			} catch {
				return null;
			}
		}
		if (typeof data.nextOffset !== "number" || data.nextOffset <= offset)
			return null;
		offset = data.nextOffset;
	}
	return null;
}

const NATIVE_SOURCE_TOOLS = new Set(["clone_repo", "repo_load"]);

/**
 * Native source research runs on one of two filesystems: a prepared computer
 * checkout, or the scratch workspace that the plan's clone_repo/repo_load fill
 * with selected paths. Scratch tools only work while no computer is selected,
 * so an unselected computer is not a missing checkout when the plan grants them.
 */
export function assertNativeResearchCheckout(
	plan: DelegationCapabilityPlan | undefined,
	environment: { ready: boolean; preparation: string } | undefined,
): void {
	if (!plan?.requiredCapabilities.includes("repository.read")) return;
	if (
		!environment &&
		plan.allowedToolIds.some((id) => NATIVE_SOURCE_TOOLS.has(id))
	)
		return;
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
	let resolved: unknown;
	try {
		resolved = await resolveCodeModeResultHandle(result, execute);
	} catch (error) {
		throw new Error(
			`Delegation preflight failed: tool authority result could not be read (${(error instanceof Error ? error.message : String(error)).slice(0, 200)}); return to Home`,
		);
	}
	const rows = discoveryRows(resolved);
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
