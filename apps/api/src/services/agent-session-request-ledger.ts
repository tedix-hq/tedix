/**
 * Request ledger for a person's own local agent sessions.
 *
 * The plugin hooks only upload redacted session events: each message the
 * person types (`prompt`) and each agent turn end with a digest of its
 * activity (`turn`). The upload stores them and returns; a background pass
 * ({@link processAgentSessionEvents}) runs them in session order through a
 * small Workers AI model, prompted by the runtime-neutral observer and
 * reflector in `@tedix/context-core/request-ledger`, into private ledger rows
 * and status moves. A model failure leaves the event pending for a later pass.
 */

import {
	type LedgerRowRef,
	parseObservedRequests,
	parseReflectedNewRows,
	parseReflectedUpdates,
	REQUEST_OBSERVER_SYSTEM_PROMPT,
	REQUEST_REFLECTOR_SYSTEM_PROMPT,
	requestObserverInput,
	requestReflectorInput,
} from "@tedix/context-core/request-ledger";
import {
	AGENT_SESSION_REQUEST_ACTIVE_STATUSES,
	type AgentSessionRequestUpdate,
	claimAgentSessionEvent,
	listAgentSessionRequests,
	listPendingAgentSessionEvents,
	markAgentSessionRequestsUnaddressed,
	recordAgentSessionEvents,
	recordAgentSessionRequests,
	settleAgentSessionEvent,
	updateAgentSessionRequests,
} from "@tedix/db/queries/agent-session-requests";
import type { DbQueryClient } from "@tedix/db/query-client";
import type {
	AgentSessionEventKind,
	AgentSessionRequestRow,
} from "@tedix/db/schema/agent-session-requests";
import type { WorkAgentSessionHarness } from "@tedix/db/schema/work-agent-sessions";
import { type DistillEnv, runDistillModel } from "./lesson-distiller";

/** Active rows one model call sees. */
const ROWS_IN_PROMPT = 30;
/** Agent turns an open row may go untouched before it is at risk. */
export const UNADDRESSED_TURNS_AT_RISK = 5;
const MODEL_TIMEOUT_MS = 15_000;

export type LedgerModel = (
	system: string,
	prompt: string,
	surface: string,
) => Promise<string | null>;

export function workersAiLedgerModel(env: DistillEnv): LedgerModel {
	return (system, prompt, surface) =>
		runDistillModel(env, prompt, {
			system,
			surface,
			maxTokens: 1500,
			timeoutMs: MODEL_TIMEOUT_MS,
		});
}

interface SessionScope {
	organizationId: string;
	userId: string;
	harness: WorkAgentSessionHarness;
	sessionKey: string;
}

function refs(rows: readonly AgentSessionRequestRow[]): {
	prompt: LedgerRowRef[];
	byRef: Map<string, AgentSessionRequestRow>;
} {
	const byRef = new Map<string, AgentSessionRequestRow>();
	const prompt = rows.map((row, index) => {
		const ref = `r${index + 1}`;
		byRef.set(ref, row);
		return { ref, text: row.text, status: row.status };
	});
	return { prompt, byRef };
}

/** The session's newest active rows, oldest first, as the models see them. */
async function activeRows(db: DbQueryClient, scope: SessionScope) {
	const rows = await listAgentSessionRequests(db, {
		...scope,
		statuses: AGENT_SESSION_REQUEST_ACTIVE_STATUSES,
		limit: ROWS_IN_PROMPT,
		newestFirst: true,
	});
	return rows.reverse();
}

async function sourceKey(parts: readonly string[]): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(parts.join("\u0000")),
	);
	return [...new Uint8Array(digest)]
		.slice(0, 16)
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

const normalized = (text: string) =>
	text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();

export async function observeAgentSessionRequests(
	db: DbQueryClient,
	model: LedgerModel,
	input: SessionScope & {
		message: string;
		sourceAt: string;
		repository: string | null;
		now: string;
	},
): Promise<
	| { status: "unavailable" }
	| {
			status: "recorded";
			recorded: AgentSessionRequestRow[];
			cancelled: number;
	  }
> {
	const open = await activeRows(db, input);
	const { prompt, byRef } = refs(open);
	const observed = parseObservedRequests(
		await model(
			REQUEST_OBSERVER_SYSTEM_PROMPT,
			requestObserverInput(input.message, prompt),
			"agent-session-request-observer",
		),
		new Set(byRef.keys()),
	);
	if (!observed) return { status: "unavailable" };
	const known = new Set(open.map((row) => normalized(row.text)));
	const requests = observed.requests.filter(
		(request) => !known.has(normalized(request.text)),
	);
	const recorded = await recordAgentSessionRequests(db, {
		organizationId: input.organizationId,
		userId: input.userId,
		harness: input.harness,
		sessionKey: input.sessionKey,
		repository: input.repository,
		sourceAt: input.sourceAt,
		sourceKey: await sourceKey([
			input.harness,
			input.sessionKey,
			input.sourceAt,
			input.message,
		]),
		requests,
		now: input.now,
	});
	const cancelled = observed.cancelled.flatMap((ref) => {
		const row = byRef.get(ref);
		return row
			? [
					{
						id: row.id,
						status: "cancelled" as const,
						evidence: "Withdrawn by the person in a later message.",
					},
				]
			: [];
	});
	await updateAgentSessionRequests(db, {
		organizationId: input.organizationId,
		userId: input.userId,
		updates: cancelled,
		now: input.now,
	});
	return { status: "recorded", recorded, cancelled: cancelled.length };
}

export async function reflectAgentSessionRequests(
	db: DbQueryClient,
	model: LedgerModel,
	input: SessionScope & {
		turn: string;
		activity: string | null;
		repository: string | null;
		sourceAt: string;
		now: string;
	},
): Promise<
	| { status: "unavailable" }
	| {
			status: "reflected";
			updated: AgentSessionRequestUpdate[];
			recorded: AgentSessionRequestRow[];
			atRisk: number;
	  }
> {
	const active = await activeRows(db, input);
	const { prompt, byRef } = refs(active);
	const raw = await model(
		REQUEST_REFLECTOR_SYSTEM_PROMPT,
		requestReflectorInput(input.turn, prompt, input.activity ?? ""),
		"agent-session-request-reflector",
	);
	// Evidence may come from the turn or from its activity (a tool result).
	const reflected = parseReflectedUpdates(
		raw,
		new Set(byRef.keys()),
		`${input.turn}\n${input.activity ?? ""}`,
	);
	if (!reflected) return { status: "unavailable" };
	const updated = reflected.flatMap((update) => {
		const row = byRef.get(update.ref)!;
		return row.status === update.status && !update.evidence
			? []
			: [{ id: row.id, status: update.status, evidence: update.evidence }];
	});
	await updateAgentSessionRequests(db, {
		organizationId: input.organizationId,
		userId: input.userId,
		updates: updated,
		now: input.now,
	});
	const touched = new Set(reflected.map((update) => byRef.get(update.ref)!.id));
	const untouched = active.filter(
		(row) => row.status === "open" && !touched.has(row.id),
	);
	await markAgentSessionRequestsUnaddressed(db, {
		organizationId: input.organizationId,
		userId: input.userId,
		ids: untouched.map((row) => row.id),
		threshold: UNADDRESSED_TURNS_AT_RISK,
		now: input.now,
	});
	const known = new Set(active.map((row) => normalized(row.text)));
	const recorded = await recordAgentSessionRequests(db, {
		organizationId: input.organizationId,
		userId: input.userId,
		harness: input.harness,
		sessionKey: input.sessionKey,
		repository: input.repository,
		sourceAt: input.sourceAt,
		sourceKey: await sourceKey([
			"turn",
			input.harness,
			input.sessionKey,
			input.sourceAt,
			input.turn,
		]),
		requests: parseReflectedNewRows(raw).filter(
			(row) => !known.has(normalized(row.text)),
		),
		now: input.now,
	});
	const atRisk = untouched.filter(
		(row) => row.turnsUnaddressed + 1 >= UNADDRESSED_TURNS_AT_RISK,
	).length;
	return { status: "reflected", updated, recorded, atRisk };
}

/** Store uploaded events as pending, once each. */
export async function acceptAgentSessionEvents(
	db: DbQueryClient,
	input: {
		organizationId: string;
		userId: string;
		events: ReadonlyArray<{
			kind: AgentSessionEventKind;
			harness: WorkAgentSessionHarness;
			sessionKey: string;
			sourceAt: string;
			text: string;
			activity?: string;
			repository?: string;
		}>;
		now: string;
	},
): Promise<{ accepted: number; duplicates: number }> {
	const events = await Promise.all(
		input.events.map(async (event) => ({
			harness: event.harness,
			sessionKey: event.sessionKey,
			repository: event.repository || null,
			kind: event.kind,
			body: event.text,
			activity: event.activity || null,
			sourceAt: event.sourceAt,
			sourceKey: await sourceKey([
				event.kind,
				event.harness,
				event.sessionKey,
				event.sourceAt,
				event.text,
			]),
		})),
	);
	const accepted = await recordAgentSessionEvents(db, {
		organizationId: input.organizationId,
		userId: input.userId,
		events,
		now: input.now,
	});
	return { accepted, duplicates: events.length - accepted };
}

/** Events one background pass processes; each costs one model call. */
export const EVENTS_PER_PASS = 4;

/**
 * Process the caller's pending events oldest first: a `prompt` through the
 * observer, a `turn` through the reflector. Each event is claimed first, so
 * two passes never process it twice; a model failure leaves it pending for a
 * later pass (failed after three attempts). Returns events processed.
 */
export async function processAgentSessionEvents(
	db: DbQueryClient,
	model: LedgerModel,
	owner: { organizationId: string; userId: string },
	options: { limit?: number; now?: () => string } = {},
): Promise<number> {
	const now = options.now ?? (() => new Date().toISOString());
	const pending = await listPendingAgentSessionEvents(db, {
		...owner,
		limit: options.limit ?? EVENTS_PER_PASS,
		now: now(),
	});
	let processed = 0;
	for (const event of pending) {
		const claimed = await claimAgentSessionEvent(db, {
			...owner,
			id: event.id,
			now: now(),
		});
		if (!claimed) continue;
		const scope = {
			...owner,
			harness: event.harness,
			sessionKey: event.sessionKey,
		};
		let ok = false;
		try {
			const result =
				event.kind === "prompt"
					? await observeAgentSessionRequests(db, model, {
							...scope,
							message: event.body,
							sourceAt: event.sourceAt,
							repository: event.repository,
							now: now(),
						})
					: await reflectAgentSessionRequests(db, model, {
							...scope,
							turn: event.body,
							activity: event.activity,
							repository: event.repository,
							sourceAt: event.sourceAt,
							now: now(),
						});
			ok = result.status !== "unavailable";
		} catch {
			ok = false;
		}
		await settleAgentSessionEvent(db, {
			...owner,
			id: event.id,
			processed: ok,
			now: now(),
		});
		if (ok) processed++;
	}
	return processed;
}
