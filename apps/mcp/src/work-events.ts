import { isRecord } from "@tedix/api-contract/utils/is-record";
import {
	authorizeEventCaller,
	type EventCallerCredential,
} from "./interaction-event-auth";
import {
	InteractionEventError,
	INTERACTION_REPLY_EVENT,
	interactionReplyEventDefinition,
} from "./interaction-events";

/**
 * Poll-mode MCP Events (SEP-3415) over the canonical Work and skill-run
 * ledgers. Poll is stateless on this side: the opaque cursor is a ledger
 * position, the API reads only the caller's organization, and every request
 * revalidates the human OAuth grant and the scope that gates the matching
 * tools. Events are hints; consumers re-read state before acting.
 */

export const WORK_STATE_CHANGED_EVENT = "work.item.state_changed";
export const WORK_APPROVAL_REQUESTED_EVENT = "work.approval.requested";
export const WORK_ITEM_COMMENTED_EVENT = "work.item.commented";
export const WORK_INTERACTION_REQUESTED_EVENT = "work.interaction.requested";
export const LANE_REQUESTED_EVENT = "lane.requested";
export const SKILL_RUN_FAILED_EVENT = "skill.run.failed";
export const HOME_RUN_FINISHED_EVENT = "home.run.finished";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const NEXT_POLL_MS = 30_000;
const DEFAULT_MAX_EVENTS = 50;
const MAX_EVENTS = 100;
const NOTICE =
	"This event grants no execution authority; read current state before acting.";

const WORK_READ_SCOPES = [
	"mcp:work.read",
	"mcp:work.write",
	"mcp:work.admin",
] as const;
const SKILL_READ_SCOPES = [
	"mcp:skills",
	"mcp:skills.read",
	"mcp:skills.write",
	"mcp:skills.admin",
] as const;

const organizationProperty = { type: "string", format: "uuid" } as const;
const idProperty = { type: "string", format: "uuid" } as const;

function objectSchema(
	properties: Record<string, unknown>,
	required: string[],
): Record<string, unknown> {
	return { type: "object", properties, required, additionalProperties: false };
}

export const workStateChangedEventDefinition = {
	name: WORK_STATE_CHANGED_EVENT,
	description: `A Work Item changed, an Attempt settled or expired, or a registered lane went stale. ${NOTICE}`,
	delivery: ["poll"],
	inputSchema: objectSchema(
		{ organization_id: organizationProperty, work_item_id: idProperty },
		["organization_id"],
	),
	payloadSchema: objectSchema(
		{
			organization_id: organizationProperty,
			work_item_id: idProperty,
			change: {
				type: "string",
				enum: [
					"accepted",
					"completed",
					"cancelled",
					"attempt_settled",
					"attempt_expired",
					"lane_stale",
				],
			},
			disposition: {
				type: ["string", "null"],
				enum: ["accepted", "completed", "cancelled", null],
			},
			attempt_id: { type: ["string", "null"] },
			attempt_outcome: { type: ["string", "null"] },
		},
		[
			"organization_id",
			"work_item_id",
			"change",
			"disposition",
			"attempt_id",
			"attempt_outcome",
		],
	),
};

export const workApprovalRequestedEventDefinition = {
	name: WORK_APPROVAL_REQUESTED_EVENT,
	description: `A Work approval was requested from a person or tedi. The request body is never included. ${NOTICE}`,
	delivery: ["poll"],
	inputSchema: objectSchema(
		{
			organization_id: organizationProperty,
			work_item_id: idProperty,
			approver_id: { type: "string" },
		},
		["organization_id"],
	),
	payloadSchema: objectSchema(
		{
			organization_id: organizationProperty,
			work_item_id: idProperty,
			approval_id: idProperty,
			action: { type: "string" },
			authority_key: { type: "string" },
			approver_type: { type: "string", enum: ["user", "tedi"] },
			approver_id: { type: "string" },
			expires_at: { type: "string", format: "date-time" },
		},
		[
			"organization_id",
			"work_item_id",
			"approval_id",
			"action",
			"authority_key",
			"approver_type",
			"approver_id",
			"expires_at",
		],
	),
};

export const skillRunFailedEventDefinition = {
	name: SKILL_RUN_FAILED_EVENT,
	description: `A skill workflow run ended failed. Carries ids and a coarse error class only. ${NOTICE}`,
	delivery: ["poll"],
	inputSchema: objectSchema(
		{
			organization_id: organizationProperty,
			tedi_id: idProperty,
			skill_id: idProperty,
		},
		["organization_id"],
	),
	payloadSchema: objectSchema(
		{
			organization_id: organizationProperty,
			run_id: { type: "string" },
			skill_id: { type: "string" },
			tedi_id: { type: "string" },
			work_item_id: { type: ["string", "null"] },
			error_class: { type: "string", enum: ["admission", "execution"] },
		},
		[
			"organization_id",
			"run_id",
			"skill_id",
			"tedi_id",
			"work_item_id",
			"error_class",
		],
	),
};

export const workItemCommentedEventDefinition = {
	name: WORK_ITEM_COMMENTED_EVENT,
	description: `A comment was added to a Work Item. The body and metadata are never included. ${NOTICE}`,
	delivery: ["poll"],
	inputSchema: objectSchema(
		{
			organization_id: organizationProperty,
			work_item_id: idProperty,
			author_type: {
				type: "string",
				enum: ["user", "tedi", "external_agent", "system"],
			},
		},
		["organization_id"],
	),
	payloadSchema: objectSchema(
		{
			organization_id: organizationProperty,
			work_item_id: idProperty,
			comment_id: idProperty,
			author_type: {
				type: "string",
				enum: ["user", "tedi", "external_agent", "system"],
			},
			author_id: { type: ["string", "null"] },
		},
		[
			"organization_id",
			"work_item_id",
			"comment_id",
			"author_type",
			"author_id",
		],
	),
};

export const workInteractionRequestedEventDefinition = {
	name: WORK_INTERACTION_REQUESTED_EVENT,
	description: `A Work Interaction was opened. The subject, prompt and metadata are never included. ${NOTICE}`,
	delivery: ["poll"],
	inputSchema: objectSchema(
		{
			organization_id: organizationProperty,
			work_item_id: idProperty,
			target_id: { type: "string", minLength: 1, maxLength: 128 },
			kind: {
				type: "string",
				enum: ["question", "input", "handoff", "coordination"],
			},
		},
		["organization_id"],
	),
	payloadSchema: objectSchema(
		{
			organization_id: organizationProperty,
			request_id: idProperty,
			work_item_id: { type: ["string", "null"] },
			project_id: { type: ["string", "null"] },
			kind: {
				type: "string",
				enum: ["question", "input", "handoff", "coordination"],
			},
			target_type: {
				type: ["string", "null"],
				enum: ["user", "tedi", "external_agent", null],
			},
			target_id: { type: ["string", "null"] },
			creator_type: {
				type: "string",
				enum: ["user", "tedi", "external_agent", "system"],
			},
			due_at: { type: ["string", "null"] },
		},
		[
			"organization_id",
			"request_id",
			"work_item_id",
			"project_id",
			"kind",
			"target_type",
			"target_id",
			"creator_type",
			"due_at",
		],
	),
};

export const pollableEventDefinitions = [
	{
		...workInteractionRequestedEventDefinition,
		name: LANE_REQUESTED_EVENT,
		inputSchema: objectSchema(
			{ organization_id: organizationProperty, work_item_id: idProperty },
			["organization_id"],
		),
		description: `Tedix requested a Codex or Claude lane from the authenticated recipient. Read the Interaction, check its requested harness and Work readiness, and obtain your own Attempt before executing. ${NOTICE}`,
	},
	{
		name: HOME_RUN_FINISHED_EVENT,
		description: `A visible Home run or delegated child completed, failed or needs input. ${NOTICE}`,
		delivery: ["poll"],
		inputSchema: objectSchema(
			{
				organization_id: organizationProperty,
				conversation_id: { type: "string" },
			},
			["organization_id"],
		),
		payloadSchema: objectSchema(
			{
				organization_id: organizationProperty,
				conversation_id: { type: "string" },
				run_id: { type: "string" },
				parent_run_id: { type: ["string", "null"] },
				status: {
					type: "string",
					enum: ["completed", "failed", "needs_input"],
				},
			},
			[
				"organization_id",
				"conversation_id",
				"run_id",
				"parent_run_id",
				"status",
			],
		),
	},
	interactionReplyEventDefinition,
	workStateChangedEventDefinition,
	workApprovalRequestedEventDefinition,
	workItemCommentedEventDefinition,
	workInteractionRequestedEventDefinition,
	skillRunFailedEventDefinition,
];

export type PollableEventName =
	| typeof HOME_RUN_FINISHED_EVENT
	| typeof INTERACTION_REPLY_EVENT
	| typeof WORK_STATE_CHANGED_EVENT
	| typeof WORK_APPROVAL_REQUESTED_EVENT
	| typeof WORK_ITEM_COMMENTED_EVENT
	| typeof WORK_INTERACTION_REQUESTED_EVENT
	| typeof LANE_REQUESTED_EVENT
	| typeof SKILL_RUN_FAILED_EVENT;

export function isPollableEvent(name: unknown): name is PollableEventName {
	return pollableEventDefinitions.some((event) => event.name === name);
}

const ARGUMENT_KEYS = {
	[LANE_REQUESTED_EVENT]: ["organization_id", "work_item_id"],
	[HOME_RUN_FINISHED_EVENT]: ["organization_id", "conversation_id"],
	[INTERACTION_REPLY_EVENT]: [
		"organization_id",
		"request_id",
		"work_item_id",
		"responder_type",
	],
	[WORK_STATE_CHANGED_EVENT]: ["organization_id", "work_item_id"],
	[WORK_APPROVAL_REQUESTED_EVENT]: [
		"organization_id",
		"work_item_id",
		"approver_id",
	],
	[WORK_ITEM_COMMENTED_EVENT]: [
		"organization_id",
		"work_item_id",
		"author_type",
	],
	[WORK_INTERACTION_REQUESTED_EVENT]: [
		"organization_id",
		"work_item_id",
		"target_id",
		"kind",
	],
	[SKILL_RUN_FAILED_EVENT]: ["organization_id", "tedi_id", "skill_id"],
} as const satisfies Record<PollableEventName, readonly string[]>;

export function eventArguments(
	name: PollableEventName,
	value: unknown,
): Record<string, string> & { organization_id: string } {
	const allowed: readonly string[] = ARGUMENT_KEYS[name];
	if (
		!isRecord(value) ||
		Object.keys(value).some((key) => !allowed.includes(key)) ||
		typeof value.organization_id !== "string" ||
		!UUID.test(value.organization_id)
	)
		throw new InteractionEventError(
			-32602,
			"Arguments must match the event inputSchema",
		);
	const result: Record<string, string> = {};
	for (const key of allowed) {
		const entry = value[key];
		if (entry === undefined) continue;
		if (
			typeof entry !== "string" ||
			entry.length === 0 ||
			entry.length > 128 ||
			(key === "responder_type"
				? !["user", "tedi", "external_agent"].includes(entry)
				: key === "author_type"
					? !["user", "tedi", "external_agent", "system"].includes(entry)
					: key === "kind"
						? !["question", "input", "handoff", "coordination"].includes(entry)
						: key !== "approver_id" &&
							key !== "target_id" &&
							key !== "conversation_id" &&
							!UUID.test(entry))
		)
			throw new InteractionEventError(-32602, `Invalid ${key}`);
		result[key] = [
			"approver_id",
			"target_id",
			"author_type",
			"responder_type",
			"kind",
			"conversation_id",
		].includes(key)
			? entry
			: entry.toLowerCase();
	}
	return result as Record<string, string> & { organization_id: string };
}

type Keyset = { at: string; id: string };

function encodeKeyset(prefix: string, position: Keyset): string {
	return `${prefix}.${btoa(JSON.stringify([position.at, position.id]))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "")}`;
}

function decodeKeyset(prefix: string, cursor: string): Keyset {
	if (!cursor.startsWith(`${prefix}.`) || cursor.length > 512)
		throw new InteractionEventError(-32602, "Invalid cursor");
	try {
		const encoded = cursor
			.slice(prefix.length + 1)
			.replaceAll("-", "+")
			.replaceAll("_", "/");
		const parsed: unknown = JSON.parse(atob(encoded));
		if (
			Array.isArray(parsed) &&
			parsed.length === 2 &&
			typeof parsed[0] === "string" &&
			typeof parsed[1] === "string"
		)
			return { at: parsed[0], id: parsed[1] };
	} catch {
		/* fall through */
	}
	throw new InteractionEventError(-32602, "Invalid cursor");
}

function decodeSequence(cursor: string): number {
	const match = /^wsc1\.(\d{1,15})$/.exec(cursor);
	if (!match) throw new InteractionEventError(-32602, "Invalid cursor");
	return Number(match[1]);
}

type PollDependencies = { authorize: typeof authorizeEventCaller };

export type EventPollResult = {
	events: Array<{
		eventId: string;
		name: string;
		timestamp: string;
		data: Record<string, unknown>;
	}>;
	cursor: string;
	truncated: false;
	hasMore: boolean;
	nextPollMs: number;
};

/**
 * Answer one `events/poll` request. `cursor: null` returns no events and the
 * current ledger head ("start from now"); a returned cursor resumes exactly
 * after the last delivered event.
 */
export async function pollEvent(
	env: CloudflareEnv,
	caller: Omit<EventCallerCredential, "organizationId">,
	params: Record<string, unknown>,
	dependencies: PollDependencies = { authorize: authorizeEventCaller },
): Promise<EventPollResult> {
	const name = params.name;
	if (!isPollableEvent(name))
		throw new InteractionEventError(-32023, "Unknown poll event", {
			kind: "event",
		});
	const args = eventArguments(name, params.arguments);
	const cursor = params.cursor ?? null;
	if (cursor !== null && typeof cursor !== "string")
		throw new InteractionEventError(-32602, "Invalid cursor");
	const maxEvents = params.maxEvents ?? DEFAULT_MAX_EVENTS;
	if (
		typeof maxEvents !== "number" ||
		!Number.isSafeInteger(maxEvents) ||
		maxEvents < 1
	)
		throw new InteractionEventError(-32602, "Invalid maxEvents");
	const limit = Math.min(maxEvents, MAX_EVENTS);
	let authority: Awaited<ReturnType<typeof authorizeEventCaller>>;
	try {
		authority = await dependencies.authorize(
			env,
			{ ...caller, organizationId: args.organization_id },
			eventReadScopes(name),
		);
	} catch {
		throw new InteractionEventError(
			-32024,
			"Current human OAuth access to this organization and event is required",
		);
	}
	if (authority.organizationId !== args.organization_id)
		throw new InteractionEventError(-32024, "Organization not selected");
	const page = await readEventFeed(authority.client, name, args, cursor, limit);
	return {
		...page,
		truncated: false,
		nextPollMs: NEXT_POLL_MS,
	};
}

/** The read scopes that already gate the tools behind one event. */
export function eventReadScopes(name: PollableEventName): readonly string[] {
	return name === INTERACTION_REPLY_EVENT || name === HOME_RUN_FINISHED_EVENT
		? ["mcp:messaging.read", "mcp:messaging.write", "mcp:messaging.admin"]
		: name === SKILL_RUN_FAILED_EVENT
			? SKILL_READ_SCOPES
			: WORK_READ_SCOPES;
}

/** Reject a cursor this event's feed did not issue, without reading it. */
export function assertEventCursor(name: PollableEventName, cursor: string) {
	if (name === WORK_STATE_CHANGED_EVENT) decodeSequence(cursor);
	else
		decodeKeyset(
			name === HOME_RUN_FINISHED_EVENT
				? "hrf1"
				: name === INTERACTION_REPLY_EVENT
					? "wrr1"
					: name === WORK_APPROVAL_REQUESTED_EVENT
						? "war1"
						: name === WORK_ITEM_COMMENTED_EVENT
							? "wcm1"
							: name === WORK_INTERACTION_REQUESTED_EVENT
								? "wir1"
								: name === LANE_REQUESTED_EVENT
									? "lnr1"
									: "srf1",
			cursor,
		);
}

type EventFeedClient = Awaited<
	ReturnType<typeof authorizeEventCaller>
>["client"];

/**
 * Read one page of an event's organization-bound ledger feed after `cursor`
 * (`null` returns no events and the current head). Shared by `events/poll`
 * and webhook delivery so both resume from the same opaque positions.
 */
export async function readEventFeed(
	client: Pick<EventFeedClient, "mcpEvents">,
	name: PollableEventName,
	args: Record<string, string>,
	cursor: string | null,
	limit: number,
): Promise<Pick<EventPollResult, "events" | "cursor" | "hasMore">> {
	const named = (
		events: Array<{
			eventId: string;
			timestamp: string;
			data: Record<string, unknown>;
		}>,
	) => events.map((event) => ({ ...event, name }));
	try {
		if (name === HOME_RUN_FINISHED_EVENT) {
			const result = await client.mcpEvents.pollHomeRunFinished({
				after: cursor === null ? null : decodeKeyset("hrf1", cursor),
				conversationId: args.conversation_id,
				limit,
			});
			return {
				events: named(result.events),
				cursor: encodeKeyset("hrf1", result.after),
				hasMore: result.hasMore,
			};
		}
		if (name === INTERACTION_REPLY_EVENT) {
			const result = await client.mcpEvents.pollWorkInteractionResponses({
				after: cursor === null ? null : decodeKeyset("wrr1", cursor),
				requestId: args.request_id,
				workItemId: args.work_item_id,
				responderType: args.responder_type as
					| "user"
					| "tedi"
					| "external_agent"
					| undefined,
				limit,
			});
			return {
				events: named(result.events),
				cursor: encodeKeyset("wrr1", result.after),
				hasMore: result.hasMore,
			};
		}
		if (name === WORK_STATE_CHANGED_EVENT) {
			const result = await client.mcpEvents.pollWorkStateChanges({
				afterSequence: cursor === null ? null : decodeSequence(cursor),
				workItemId: args.work_item_id,
				limit,
			});
			return {
				events: named(result.events),
				cursor: `wsc1.${result.afterSequence}`,
				hasMore: result.hasMore,
			};
		}
		if (name === WORK_APPROVAL_REQUESTED_EVENT) {
			const result = await client.mcpEvents.pollWorkApprovalRequests({
				after: cursor === null ? null : decodeKeyset("war1", cursor),
				workItemId: args.work_item_id,
				approverId: args.approver_id,
				limit,
			});
			return {
				events: named(result.events),
				cursor: encodeKeyset("war1", result.after),
				hasMore: result.hasMore,
			};
		}
		if (name === WORK_ITEM_COMMENTED_EVENT) {
			const result = await client.mcpEvents.pollWorkComments({
				after: cursor === null ? null : decodeKeyset("wcm1", cursor),
				workItemId: args.work_item_id,
				authorType: args.author_type as
					| "user"
					| "tedi"
					| "external_agent"
					| "system"
					| undefined,
				limit,
			});
			return {
				events: named(result.events),
				cursor: encodeKeyset("wcm1", result.after),
				hasMore: result.hasMore,
			};
		}
		if (
			name === WORK_INTERACTION_REQUESTED_EVENT ||
			name === LANE_REQUESTED_EVENT
		) {
			const prefix = name === LANE_REQUESTED_EVENT ? "lnr1" : "wir1";
			const result = await client.mcpEvents.pollWorkInteractionRequests({
				...(name === LANE_REQUESTED_EVENT ? { laneRequestsOnly: true } : {}),
				after:
					cursor === null
						? name === LANE_REQUESTED_EVENT
							? { at: "", id: "" }
							: null
						: decodeKeyset(prefix, cursor),
				workItemId: args.work_item_id,
				targetId: args.target_id,
				kind: args.kind as
					| "question"
					| "input"
					| "handoff"
					| "coordination"
					| undefined,
				limit,
			});
			return {
				events: named(
					name === LANE_REQUESTED_EVENT
						? result.events.map((event) => ({
								...event,
								eventId: `evt_lane_${event.data.request_id}`,
							}))
						: result.events,
				),
				cursor: encodeKeyset(prefix, result.after),
				hasMore: result.hasMore,
			};
		}
		const result = await client.mcpEvents.pollFailedSkillRuns({
			after: cursor === null ? null : decodeKeyset("srf1", cursor),
			tediId: args.tedi_id,
			skillId: args.skill_id,
			limit,
		});
		return {
			events: named(result.events),
			cursor: encodeKeyset("srf1", result.after),
			hasMore: result.hasMore,
		};
	} catch (error) {
		if (error instanceof InteractionEventError) throw error;
		const code =
			isRecord(error) && typeof error.code === "string" ? error.code : "";
		if (code === "FORBIDDEN" || code === "UNAUTHORIZED")
			throw new InteractionEventError(-32024, "Forbidden");
		throw new InteractionEventError(-32603, "Event poll unavailable");
	}
}
