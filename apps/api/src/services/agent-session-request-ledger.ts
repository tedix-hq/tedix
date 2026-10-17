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
	acceptedDoneEvidence,
	type LedgerRowRef,
	type LedgerLesson,
	parseObservedRequests,
	parseReflectedNewRows,
	parseReflectedLessons,
	parseReflectedUpdates,
	REQUEST_OBSERVER_SYSTEM_PROMPT,
	REQUEST_REFLECTOR_SYSTEM_PROMPT,
	requestObserverInput,
	requestReflectorInput,
} from "@tedix/context-core/request-ledger";
import {
	AGENT_SESSION_REQUEST_ACTIVE_STATUSES,
	AGENT_SESSION_REQUEST_LIST_LIMIT,
	type AgentSessionRequestUpdate,
	claimAgentSessionEvent,
	listAgentSessionRequests,
	listPendingAgentSessionEvents,
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

const LEDGER_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MODEL_TIMEOUT_MS = 15_000;

export interface LedgerCheck {
	ref: string;
	request: string;
	status: "done" | "dropped_risk";
	evidence: string;
	userReply?: boolean;
}

export interface LedgerModel {
	(system: string, prompt: string, surface: string): Promise<string | null>;
	findCompletions?: (
		rows: LedgerRowRef[],
		source: string,
	) => Promise<Array<{ ref: string; evidence: string }>>;
	verify?: (
		checks: LedgerCheck[],
		source: string,
	) => Promise<ReadonlySet<string>>;
	learn?: (
		lessons: LedgerLesson[],
		scope: SessionScope & { sourceAt: string; repository: string | null },
	) => Promise<void>;
}

export function workersAiLedgerModel(env: DistillEnv): LedgerModel {
	const model: LedgerModel = (system, prompt, surface) =>
		runDistillModel(env, prompt, {
			model: LEDGER_MODEL,
			system,
			surface,
			maxTokens: 2500,
			timeoutMs: MODEL_TIMEOUT_MS,
		});
	model.verify = async (checks, source) => {
		if (!checks.length) return new Set();
		const { verifyLedgerEvidence } = await import("./request-ledger-verifier");
		return verifyLedgerEvidence(env, checks, source);
	};
	model.findCompletions = async (rows, source) => {
		const { findLedgerCompletions } = await import("./request-ledger-verifier");
		return findLedgerCompletions(env, rows, source);
	};
	return model;
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
		return { ref, text: row.text, status: row.status, kind: row.kind };
	});
	return { prompt, byRef };
}

/** The session's newest active rows, oldest first, as the models see them. */
async function activeRows(db: DbQueryClient, scope: SessionScope) {
	const rows = await listAgentSessionRequests(db, {
		...scope,
		statuses: AGENT_SESSION_REQUEST_ACTIVE_STATUSES,
		limit: AGENT_SESSION_REQUEST_LIST_LIMIT,
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
		return row && row.kind !== "ask"
			? [
					{
						id: row.id,
						status: "cancelled" as const,
						evidence: "Withdrawn by the person in a later message.",
					},
				]
			: [];
	});
	const answers = observed.answered.filter(
		({ ref, evidence }) =>
			byRef.get(ref)?.kind === "ask" &&
			Date.parse(byRef.get(ref)!.sourceAt) < Date.parse(input.sourceAt) &&
			evidence.trim().length > 0 &&
			input.message.toLowerCase().includes(evidence.toLowerCase()),
	);
	const supported =
		(await model.verify?.(
			answers.map(({ ref, evidence }) => ({
				ref,
				request: byRef.get(ref)!.text,
				status: "done",
				evidence,
				userReply: true,
			})),
			`USER REPLY:\n${input.message}`,
		)) ?? new Set<string>();
	await updateAgentSessionRequests(db, {
		organizationId: input.organizationId,
		userId: input.userId,
		updates: [
			...cancelled,
			...answers
				.filter(({ ref }) => supported.has(ref))
				.map(({ ref, evidence }) => ({
					id: byRef.get(ref)!.id,
					status: "done" as const,
					evidence,
				})),
		],
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
	const source = `AGENT TURN:\n${input.turn}\nACTIVITY:\n${input.activity ?? ""}`;
	const [raw, completions] = await Promise.all([
		model(
			REQUEST_REFLECTOR_SYSTEM_PROMPT,
			requestReflectorInput(input.turn, prompt, input.activity ?? ""),
			"agent-session-request-reflector",
		),
		model.findCompletions?.(prompt, source) ?? Promise.resolve([]),
	]);
	// Evidence may come from the turn or from its activity (a tool result).
	const reflected = parseReflectedUpdates(
		raw,
		new Set(byRef.keys()),
		`${input.turn}\n${input.activity ?? ""}`,
	);
	if (!reflected) return { status: "unavailable" };
	const candidates = reflected.filter(
		(update) =>
			byRef.get(update.ref)!.kind !== "ask" &&
			(update.status === "done" || update.status === "dropped_risk"),
	);
	const supported = new Set(
		(await model.verify?.(
			candidates.map((update) => ({
				ref: update.ref,
				request: byRef.get(update.ref)!.text,
				status: update.status as "done" | "dropped_risk",
				evidence: update.evidence ?? "",
			})),
			source,
		)) ?? [],
	);
	const proposed = new Map(reflected.map((update) => [update.ref, update]));
	for (const completion of completions) {
		const row = byRef.get(completion.ref);
		const evidence = acceptedDoneEvidence(completion.evidence, source);
		if (!row || row.kind === "ask" || !evidence) continue;
		proposed.set(completion.ref, {
			ref: completion.ref,
			status: "done",
			evidence,
		});
		supported.add(completion.ref);
	}
	const updated = [...proposed.values()].flatMap((update) => {
		const row = byRef.get(update.ref)!;
		if (row.kind === "ask") return [];
		if (
			(update.status === "done" || update.status === "dropped_risk") &&
			!supported.has(update.ref)
		)
			return [];
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
	const atRisk = updated.filter((row) => row.status === "dropped_risk").length;
	await model.learn?.(
		parseReflectedLessons(raw, input.turn, input.activity ?? ""),
		input,
	);
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

/** Maximum events per background pass. */
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
	const startedAt = Date.now();
	let processed = 0;
	for (let index = 0; index < (options.limit ?? EVENTS_PER_PASS); index++) {
		// Leave room for a 15s extraction, 5s verification and D1 writes within waitUntil's 30s.
		if (index > 0 && Date.now() - startedAt >= 5000) break;
		const [event] = await listPendingAgentSessionEvents(db, {
			...owner,
			limit: 1,
			now: now(),
		});
		if (!event) break;
		const claimed = await claimAgentSessionEvent(db, {
			...owner,
			id: event.id,
			now: now(),
		});
		if (!claimed) break;
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
		else break;
	}
	return processed;
}
