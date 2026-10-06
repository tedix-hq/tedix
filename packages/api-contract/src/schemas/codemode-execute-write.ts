/**
 * Shared contract for the codemode `execute` write-tier approval payload.
 *
 * Built by apps/tedi-runtime (DO) and parsed by apps/api (server guard).
 * Apps cannot import each other, so this lives in api-contract.
 *
 * Security constraint: the payload carries a SUMMARY ONLY — the model-authored
 * code never appears here (only its SHA-256 hash, for audit). The code stays in
 * the tedi's DO-SQLite `cm_executions` row and is never re-run server-side; the
 * approval authorizes one replay of the same code hash in the same coding
 * session. Durable calls instead bind the approval to one execution and one
 * pending connector call so CodemodeRuntime can resume it exactly once.
 *
 * Arbitrary model JS over the live durable workspace is always HIGH risk, so the
 * approval never auto-resolves via policy — it always parks a human card.
 */

export const CODEMODE_EXECUTE_WRITE_KIND = "codemode_execute_write" as const;

export interface CodemodeExecuteWritePayload {
	kind: typeof CODEMODE_EXECUTE_WRITE_KIND;
	organizationId: string;
	tediId: string;
	conversationId: string;
	/** Coding session (CmSessionGate key) the replay grant is bound to. */
	sessionKey: string;
	/** FK into the `cm_executions` DO-SQLite row that parked. */
	executionId: string;
	/** SHA-256 of the parked code — audit only; the code never leaves the DO. */
	codeHash: string;
	riskTier: "high";
	/** Legacy execute-session replay or the durable runtime's exact pending call. */
	executionMode?: "session_replay" | "durable_call";
	/** Parent/child correlation for delegated durable calls. */
	homeRunId?: string;
	childRunId?: string;
	pendingSeq?: number;
	connector?: string;
	method?: string;
}

/** Shape-validating guard mirroring parseRepoCommitWritePayload. Never throws. */
export function parseCodemodeExecuteWritePayload(
	value: unknown,
): CodemodeExecuteWritePayload | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const p = value as Record<string, unknown>;

	if (p.kind !== CODEMODE_EXECUTE_WRITE_KIND) return null;

	const {
		organizationId,
		tediId,
		conversationId,
		sessionKey,
		executionId,
		codeHash,
		riskTier,
	} = p;

	if (
		typeof organizationId !== "string" ||
		organizationId.length === 0 ||
		typeof tediId !== "string" ||
		tediId.length === 0 ||
		typeof conversationId !== "string" ||
		conversationId.length === 0 ||
		typeof sessionKey !== "string" ||
		sessionKey.length === 0 ||
		typeof executionId !== "string" ||
		executionId.length === 0 ||
		typeof codeHash !== "string" ||
		codeHash.length === 0
	) {
		return null;
	}

	if (riskTier !== "high") return null;
	const executionMode = p.executionMode;
	if (
		executionMode !== undefined &&
		executionMode !== "session_replay" &&
		executionMode !== "durable_call"
	) {
		return null;
	}
	if (
		executionMode === "durable_call" &&
		(typeof p.homeRunId !== "string" ||
			!p.homeRunId ||
			typeof p.childRunId !== "string" ||
			!p.childRunId ||
			typeof p.pendingSeq !== "number" ||
			typeof p.connector !== "string" ||
			typeof p.method !== "string")
	) {
		return null;
	}

	return {
		kind: CODEMODE_EXECUTE_WRITE_KIND,
		organizationId,
		tediId,
		conversationId,
		sessionKey,
		executionId,
		codeHash,
		riskTier,
		...(executionMode ? { executionMode } : {}),
		...(typeof p.homeRunId === "string" ? { homeRunId: p.homeRunId } : {}),
		...(typeof p.childRunId === "string" ? { childRunId: p.childRunId } : {}),
		...(typeof p.pendingSeq === "number" ? { pendingSeq: p.pendingSeq } : {}),
		...(typeof p.connector === "string" ? { connector: p.connector } : {}),
		...(typeof p.method === "string" ? { method: p.method } : {}),
	};
}
