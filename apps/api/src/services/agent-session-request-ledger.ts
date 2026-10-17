import { assertModelEgressAllowed } from "./unrouted-model-egress";
/**
 * Request ledger for a person's own local agent sessions.
 *
 * The plugin hooks only upload redacted session events: each message the
 * person types (`prompt`) and each agent turn end with a digest of its
 * activity (`turn`). The upload stores them and returns; a background pass
 * ({@link processAgentSessionEvents}) runs them in session order through a
 * small Workers AI observer and separate Gateway status/intake passes, prompted by
 * `@tedix/context-core/request-ledger`, into private ledger rows
 * and status moves. A model failure leaves the event pending for a later pass.
 */

import {
	isScheduledLedgerPrompt,
	type LedgerRowRef,
	type LedgerLesson,
	type LedgerLessonSource,
	SESSION_LESSON_REFLECTOR_SYSTEM_PROMPT,
	REQUEST_INTAKE_SYSTEM_PROMPT,
	requestIntakeInput,
	hasLedgerIntake,
	parseObservedRequests,
	parseLedgerMentions,
	parseLedgerLanes,
	parseReflectedMerges,
	parseReflectedNewRows,
	parseReflectedLessons,
	parseReflectedUpdates,
	REQUEST_OBSERVER_SYSTEM_PROMPT,
	REQUEST_REFLECTOR_SYSTEM_PROMPT,
	REQUEST_REPLY_REFLECTOR_SYSTEM_PROMPT,
	requestObserverInput,
	requestReplyReflectorInput,
	requestReflectorInput,
} from "@tedix/context-core/request-ledger";
import {
	AGENT_SESSION_REQUEST_ACTIVE_STATUSES,
	AGENT_SESSION_REQUEST_LIST_LIMIT,
	type AgentSessionRequestUpdate,
	claimAgentSessionEvent,
	getPreviousAgentSessionTurn,
	getAgentSessionRequestPrompts,
	listAgentSessionRequests,
	listRecentAgentSessionTurns,
	listPendingAgentSessionEvents,
	recordAgentSessionEvents,
	recordAgentSessionRequests,
	retryFailedAgentSessionEvents,
	rebuildFailedAgentSession,
	type RebuildFailedAgentSessionParams,
	settleAgentSessionEvent,
	updateAgentSessionRequests,
} from "@tedix/db/queries/agent-session-requests";
import type { DbQueryClient } from "@tedix/db/query-client";
import type {
	AgentSessionEventKind,
	AgentSessionRequestRow,
} from "@tedix/db/schema/agent-session-requests";
import type { WorkAgentSessionHarness } from "@tedix/db/schema/work-agent-sessions";
import {
	type AiGatewayTransportEnv,
	resolveAiGatewayTransport,
} from "@tedix/workers-ai/gateway-transport";
import { type DistillEnv, runDistillModel } from "./lesson-distiller";

const LEDGER_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MODEL_TIMEOUT_MS = 15_000;
export const LEDGER_REFLECTOR_MODEL = "gpt-6-astra";
export const LEDGER_SILENCE_TURNS = 5;

type LedgerEnv = DistillEnv &
	AiGatewayTransportEnv & {
		AZURE_OPENAI_RESOURCE?: string;
	};

async function reflectWithGateway(
	env: LedgerEnv,
	system: string,
	prompt: string,
	surface: string,
): Promise<string | null> {
	await assertModelEgressAllowed(env);
	const transport = resolveAiGatewayTransport(
		env,
		env.AI_GATEWAY_LLM_ID ?? "",
		"azure-openai",
	);
	const resource = env.AZURE_OPENAI_RESOURCE?.trim();
	if (!transport || !resource || !/^[a-zA-Z0-9-]+$/.test(resource)) return null;
	try {
		const response = await transport.fetch(
			`${transport.providerRoot}/${resource}/openai/v1/responses`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"cf-aig-authorization": `Bearer ${transport.authorization}`,
					"cf-aig-no-wholesale": "true",
					"cf-aig-metadata": JSON.stringify({ surface }),
				},
				body: JSON.stringify({
					model: LEDGER_REFLECTOR_MODEL,
					instructions: system,
					input: prompt,
					max_output_tokens: 6000,
					reasoning: { effort: "low" },
				}),
				signal: AbortSignal.timeout(24_000),
			},
		);
		if (!response.ok) return null;
		const result = (await response.json()) as {
			status?: string;
			output?: Array<{
				type: string;
				content?: Array<{ type: string; text?: string }>;
			}>;
		};
		if (result.status !== "completed") return null;
		return (
			result.output
				?.filter((item) => item.type === "message")
				.flatMap((item) => item.content ?? [])
				.filter((item) => item.type === "output_text")
				.map((item) => item.text ?? "")
				.join("\n") || null
		);
	} catch {
		return null;
	}
}

export interface LedgerCheck {
	ref: string;
	request: string;
	status: "done" | "dropped_risk";
	evidence: string;
	userReply?: boolean;
}

export interface LedgerModel {
	(system: string, prompt: string, surface: string): Promise<string | null>;
	routeProjects?: boolean;
	enqueueFilings?: (owner: {
		organizationId: string;
		userId: string;
	}) => Promise<void>;
	scoreProjectFit?: (input: {
		request: string;
		project: unknown;
		corrections: unknown[];
	}) => Promise<number>;
	extractObligations?: (
		rows: LedgerRowRef[],
		turn: string,
		userMessage: string,
	) => Promise<string | null>;
	reflectReplies?: (
		rows: LedgerRowRef[],
		message: string,
		previousTurn?: string | null,
	) => Promise<string | null>;
	verify?: (
		checks: LedgerCheck[],
		source: string,
	) => Promise<ReadonlySet<string>>;
	reflectLessons?: (
		sources: readonly LedgerLessonSource[],
	) => Promise<string | null>;
	learn?: (
		lessons: LedgerLesson[],
		scope: SessionScope & { sourceAt: string; repository: string | null },
	) => Promise<void>;
}

export function workersAiLedgerModel(env: LedgerEnv): LedgerModel {
	const model: LedgerModel = (system, prompt, surface) =>
		surface === "agent-session-request-reflector" ||
		surface === "agent-session-request-intake" ||
		surface === "agent-session-lesson-reflector"
			? reflectWithGateway(env, system, prompt, surface)
			: runDistillModel(env, prompt, {
					model: LEDGER_MODEL,
					system,
					surface,
					maxTokens: 2500,
					timeoutMs: MODEL_TIMEOUT_MS,
				});
	model.extractObligations = (rows, turn, userMessage) =>
		model(
			REQUEST_INTAKE_SYSTEM_PROMPT,
			requestIntakeInput(turn, rows, userMessage),
			"agent-session-request-intake",
		);
	model.verify = async (checks, source) => {
		if (!checks.length) return new Set();
		const { verifyLedgerEvidence } = await import("./request-ledger-verifier");
		return verifyLedgerEvidence(env, checks, source);
	};
	model.reflectReplies = (rows, message, previousTurn) =>
		model(
			REQUEST_REPLY_REFLECTOR_SYSTEM_PROMPT,
			requestReplyReflectorInput(message, rows, previousTurn ?? ""),
			"agent-session-request-reflector",
		);
	model.reflectLessons = (sources) =>
		model(
			SESSION_LESSON_REFLECTOR_SYSTEM_PROMPT,
			JSON.stringify(sources),
			"agent-session-lesson-reflector",
		);
	model.routeProjects = true;
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
		return {
			ref,
			text: row.text,
			status: row.status,
			kind: row.kind,
			evidence: row.evidence,
			sourceAt: row.sourceAt,
			laneRunning: row.laneRunning,
		};
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
	if (isScheduledLedgerPrompt(input.message))
		return { status: "recorded", recorded: [], cancelled: 0 };
	const previousPrompt = await getPreviousAgentSessionTurn(db, {
		...input,
		before: input.sourceAt,
		kind: "prompt",
	});
	if (previousPrompt === input.message)
		return { status: "recorded", recorded: [], cancelled: 0 };
	const open = await activeRows(db, input);
	const { prompt, byRef } = refs(open);
	const [raw, replyRaw] = await Promise.all([
		model(
			REQUEST_OBSERVER_SYSTEM_PROMPT,
			requestObserverInput(input.message, prompt),
			"agent-session-request-observer",
		),
		model.reflectReplies
			? (async () => {
					const previousTurn = await getPreviousAgentSessionTurn(db, {
						...input,
						before: input.sourceAt,
					});
					return model.reflectReplies!(prompt, input.message, previousTurn);
				})()
			: undefined,
	]);
	const observed = parseObservedRequests(raw, new Set(byRef.keys()));
	if (!observed) return { status: "unavailable" };
	if (model.reflectReplies) {
		const replies = parseObservedRequests(
			replyRaw ?? null,
			new Set(byRef.keys()),
		);
		if (!replies) return { status: "unavailable" };
		observed.answered = replies.answered;
		observed.cancelled = replies.cancelled;
		observed.requests.push(
			...replies.requests.filter((row) => row.kind === "request"),
		);
	}
	const known = new Set(
		open.filter((row) => row.kind !== "ask").map((row) => normalized(row.text)),
	);
	const requests = observed.requests.filter((request) => {
		const key = normalized(request.text);
		if (known.has(key)) return false;
		known.add(key);
		return true;
	});
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
	await routeLedgerRequests(db, model, input, recorded);
	const cancelled = observed.cancelled.flatMap((ref) => {
		const row = byRef.get(ref);
		return row && row.kind !== "ask"
			? [
					{
						id: row.id,
						status: "cancelled" as const,
						evidence: input.message,
					},
				]
			: [];
	});
	const answers = observed.answered.filter(
		({ ref, evidence }) =>
			byRef.get(ref)?.kind === "ask" &&
			Date.parse(byRef.get(ref)!.sourceAt) < Date.parse(input.sourceAt) &&
			evidence.trim().length > 0 &&
			input.message
				.replace(/\s+/g, " ")
				.toLowerCase()
				.includes(evidence.toLowerCase()),
	);
	const supported = model.reflectReplies
		? new Set(answers.map((answer) => answer.ref))
		: ((await model.verify?.(
				answers.map(({ ref, evidence }) => ({
					ref,
					request: byRef.get(ref)!.text,
					status: "done",
					evidence,
					userReply: true,
				})),
				`USER REPLY:\n${input.message}`,
			)) ?? new Set<string>());
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
		sourceEventId?: string;
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
	const [active, resolved, userMessage, recentTurns] = await Promise.all([
		activeRows(db, input),
		listAgentSessionRequests(db, {
			...input,
			statuses: ["done"],
			limit: AGENT_SESSION_REQUEST_LIST_LIMIT,
			newestFirst: true,
		}),
		getPreviousAgentSessionTurn(db, {
			...input,
			before: input.sourceAt,
			kind: "prompt",
		}),
		listRecentAgentSessionTurns(db, { ...input, before: input.sourceAt }),
	]);
	const { prompt, byRef } = refs([...active, ...resolved]);
	const origins = await getAgentSessionRequestPrompts(db, {
		...input,
		ids: active
			.filter(
				(row) =>
					row.kind === "request" ||
					row.kind === "question" ||
					row.kind === "decision" ||
					row.kind === "idea" ||
					row.kind === "issue",
			)
			.map((row) => row.id),
	});
	const originById = new Map(origins.map(({ id, message }) => [id, message]));
	const scopes = new Map<string, string[]>();
	for (const [index, row] of active.entries()) {
		const message = originById.get(row.id);
		if (!message) continue;
		const ref = prompt[index]!.ref;
		const group = scopes.get(message) ?? [];
		group.push(ref);
		scopes.set(message, group);
	}
	const openRefs = new Set(
		prompt.slice(0, active.length).map((row) => row.ref),
	);
	const currentSource = `AGENT TURN:\n${input.turn}\nACTIVITY:\n${input.activity ?? ""}`;
	const source = `USER MESSAGE:\n${userMessage ?? ""}\n${currentSource}\nSAVED ROW EVIDENCE:\n${[...active, ...resolved].map((row) => row.evidence ?? "").join("\n")}`;
	const lessonSources = [
		...recentTurns,
		{
			id: input.sourceEventId ?? "",
			body: input.turn,
			activity: input.activity,
		},
	];
	const lessonsPending =
		model.reflectLessons &&
		lessonSources.some((event) =>
			/^(?:Failed|Error|Denied)\b/im.test(event.activity ?? ""),
		)
			? model.reflectLessons(lessonSources)
			: Promise.resolve(undefined);
	const [raw, intakeRaw, lessonRaw] = await Promise.all([
		model(
			REQUEST_REFLECTOR_SYSTEM_PROMPT,
			requestReflectorInput(
				input.turn,
				prompt.slice(0, active.length),
				input.activity ?? "",
				prompt.slice(active.length),
				userMessage ?? "",
				[...scopes]
					.map(([message, refs]) => `${refs.join(", ")}:\n${message}`)
					.join("\n\n"),
			),
			"agent-session-request-reflector",
		),
		model.extractObligations?.(prompt, input.turn, userMessage ?? ""),
		lessonsPending,
	]);
	if (model.extractObligations && !hasLedgerIntake(intakeRaw ?? null))
		return { status: "unavailable" };
	// Evidence may come from the turn or from its activity (a tool result).
	const reflected = parseReflectedUpdates(raw, openRefs, source);
	if (!reflected) return { status: "unavailable" };
	const currentRefs = new Set(
		(parseReflectedUpdates(raw, openRefs, currentSource) ?? []).map(
			(update) => update.ref,
		),
	);
	const updated = reflected.flatMap((update) => {
		const row = byRef.get(update.ref)!;
		if (row.status === update.status && !currentRefs.has(update.ref)) return [];
		const obsoleteUiChoice =
			update.status === "cancelled" &&
			update.operational &&
			row.kind === "ask" &&
			/\b(tabs?|panels?|layout|navigation|sidebar)\b/i.test(row.text) &&
			!/\b(approv\w*|auth\w*|consent|permission|credentials?|passwords?|tokens?|keys?|publish\w*|send|delete|archive|budget|billing|payment|pricing|legal|licen[cs]e|identity|access|public|private|personal|rules?|policy|policies|accept|reject|trust|logins?|sessions?|limits?|rates?)\b/i.test(
				row.text,
			);
		if (update.status === "cancelled" && !obsoleteUiChoice) return [];
		if (
			row.kind === "ask" &&
			!obsoleteUiChoice &&
			(update.status !== "done" ||
				!update.operational ||
				/\b(approv\w*|authoriz\w*|consent|permission|credentials?|tokens?|keys?|decide|choose|whether|publish\w*|send|delete|remove)\b/i.test(
					row.text,
				))
		)
			return [];

		return [{ id: row.id, status: update.status, evidence: update.evidence }];
	});
	const merges = parseReflectedMerges(raw, prompt);
	const mergedIds = new Set(merges.map((merge) => byRef.get(merge.ref)!.id));
	const changes: AgentSessionRequestUpdate[] = [
		...updated.filter((update) => !mergedIds.has(update.id)),
		...merges.map((merge) => ({
			id: byRef.get(merge.ref)!.id,
			status: "cancelled" as const,
			evidence: `Merged into ${byRef.get(merge.into)!.id}: ${merge.evidence}`,
		})),
	];
	const mentioned = parseLedgerMentions(raw, openRefs, currentSource);
	const newRows = parseReflectedNewRows(
		model.extractObligations ? (intakeRaw ?? null) : raw,
		model.extractObligations ? input.turn : currentSource,
	);
	const changeById = new Map(changes.map((change) => [change.id, change]));
	const lanes = parseLedgerLanes(raw, openRefs, currentSource);
	for (const [ref, row] of byRef) {
		if (
			!openRefs.has(ref) ||
			(row.lastReflectedAt &&
				Date.parse(row.lastReflectedAt) >= Date.parse(input.sourceAt))
		)
			continue;
		const lane = lanes.get(ref);
		const inheritedRunning = merges.some(
			(merge) => merge.into === ref && byRef.get(merge.ref)?.laneRunning,
		);
		const running = lane?.running ?? (row.laneRunning || inheritedRunning);
		const changed = changeById.get(row.id);
		const touched = mentioned.has(ref) || currentRefs.has(ref) || Boolean(lane);
		const count = touched ? 0 : row.turnsUnaddressed + 1;
		const atRisk =
			!changed &&
			row.kind !== "ask" &&
			row.kind !== "open_loop" &&
			row.status !== "waiting_on_user" &&
			count >= LEDGER_SILENCE_TURNS &&
			!running;
		const change: AgentSessionRequestUpdate = changed ?? {
			id: row.id,
			status: atRisk ? "dropped_risk" : row.status,
			evidence:
				lane?.evidence ??
				mentioned.get(ref) ??
				(atRisk
					? (row.evidence ??
						`${count} turns without mention; no running lane for request: "${row.text}"`)
					: null),
		};
		change.turnsUnaddressed = touched || changed ? 0 : count;
		change.laneRunning =
			change.status === "done" || change.status === "cancelled"
				? false
				: running;
		change.lastReflectedAt = input.sourceAt;
		if (!changed) changes.push(change);
	}
	await updateAgentSessionRequests(db, {
		organizationId: input.organizationId,
		userId: input.userId,
		updates: changes,
		now: input.now,
	});
	const known = new Set(
		[...active, ...resolved].map((row) => normalized(row.text)),
	);
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
		requests: newRows.filter((row) => !known.has(normalized(row.text))),
		now: input.now,
	});
	await routeLedgerRequests(db, model, input, recorded);
	const atRisk = changes.filter(
		(change) =>
			change.status === "dropped_risk" &&
			active.find((row) => row.id === change.id)?.status !== "dropped_risk",
	).length;
	if (lessonRaw === null)
		throw new Error("Session lesson reflection unavailable");
	if (lessonRaw !== undefined && !Array.isArray(JSON.parse(lessonRaw).lessons))
		throw new Error("Session lesson reflection malformed");
	await model.learn?.(
		parseReflectedLessons(
			lessonRaw ?? raw,
			input.turn,
			input.activity ?? "",
			lessonSources,
		),
		input,
	);
	return { status: "reflected", updated: changes, recorded, atRisk };
}

/** Store uploaded events as pending, once each. */
export async function acceptAgentSessionEvents(
	db: DbQueryClient,
	input: {
		organizationId: string;
		userId: string;
		retryFailed?: boolean;
		rebuildFailedSession?: Omit<
			RebuildFailedAgentSessionParams,
			"organizationId" | "userId"
		>;
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
): Promise<{
	accepted: number;
	duplicates: number;
	retried?: number;
	rebuilt?: number;
}> {
	const rebuilt = input.rebuildFailedSession
		? await rebuildFailedAgentSession(db, {
				...input.rebuildFailedSession,
				organizationId: input.organizationId,
				userId: input.userId,
			})
		: undefined;
	if (rebuilt === 0)
		return { accepted: 0, duplicates: input.events.length, rebuilt: 0 };
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
	const retried = input.retryFailed
		? await retryFailedAgentSessionEvents(db, {
				organizationId: input.organizationId,
				userId: input.userId,
				sourceKeys: events.map((event) => event.sourceKey),
			})
		: undefined;
	return {
		accepted,
		duplicates: events.length - accepted,
		...(retried === undefined ? {} : { retried }),
		...(rebuilt === undefined ? {} : { rebuilt }),
	};
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
	options: {
		limit?: number;
		now?: () => string;
		onRecorded?: (scope: SessionScope & { sourceAt: string }) => Promise<void>;
	} = {},
): Promise<number> {
	const now = options.now ?? (() => new Date().toISOString());
	const startedAt = Date.now();
	let processed = 0;
	for (let index = 0; index < (options.limit ?? EVENTS_PER_PASS); index++) {
		// Both model passes run in parallel, leaving D1 time within waitUntil's 30s.
		if (index > 0 && Date.now() - startedAt >= 1000) break;
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
							sourceEventId: event.id,
							turn: event.body,
							activity: event.activity,
							repository: event.repository,
							sourceAt: event.sourceAt,
							now: now(),
						});
			ok = result.status !== "unavailable";
			if (ok)
				await options.onRecorded?.({ ...scope, sourceAt: event.sourceAt });
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

async function routeLedgerRequests(
	db: DbQueryClient,
	model: LedgerModel,
	scope: SessionScope & { now: string },
	rows: AgentSessionRequestRow[],
) {
	if (!model.routeProjects) return;
	if (model.enqueueFilings)
		return model.enqueueFilings({
			organizationId: scope.organizationId,
			userId: scope.userId,
		});
	const { autoFileRequests } = await import("./request-auto-filing");
	await autoFileRequests(db, model, scope);
	const current = await listAgentSessionRequests(db, { ...scope, limit: 200 });
	for (const row of rows)
		row.projectId =
			current.find((r) => r.id === row.id)?.projectId ?? row.projectId;
}
