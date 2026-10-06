import type { AudioAttachment } from "@tedix/voice/stt";
import type { TediSessionModelIdentity } from "@tedix/tedi-session/session-harness";
import type { AdaptiveLearningMode } from "./adaptive-learning";
import type { ObserverToolExecutionEvidence } from "./observer-execution-evidence";

export interface RecentTurn {
	role: "user" | "assistant";
	content: string;
	attachments?: AudioAttachment[];
	sessionKey?: string;
	ts: number;
	modelIdentity?: TediSessionModelIdentity;
}

export interface BridgeTurnInput {
	user: RecentTurn;
	assistant: RecentTurn;
	/**
	 * Pre-built STABLE runId for this turn — the SAME id the companion
	 * `onLedgerMirror` step writes the 4-event chain under, so the trace
	 * bundle / artifact ids line up with the ledger events.
	 */
	runId: string;
	/** Cross-layer request trace propagated from the MCP gateway, when present. */
	traceId?: string;
	/** Tool-call refs for this run (see dispatchTurnMemoryEffects). */
	toolCallRefs?: string[];
	/** Canonical, content-free tool outcomes for Observer grounding. */
	executionEvidence?: ObserverToolExecutionEvidence[];
	/** Surface tag — kept aligned with the companion `onLedgerMirror` step. */
	origin?: string;
	/** Session key for the slug-prefixed conversation id. */
	sessionKey?: string;
	/** Disable all adaptive after-turn learning side effects for this turn. */
	learningMode?: AdaptiveLearningMode;
	/** Home Work Item served by this delegated turn, when present. */
	workItemId?: string;
}
