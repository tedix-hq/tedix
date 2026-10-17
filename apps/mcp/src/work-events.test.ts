import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { InteractionEventError } from "./interaction-events";
import { assertEventCursor, eventArguments, pollEvent } from "./work-events";

const ORG_A = "10000000-0000-4000-8000-00000000000a";
const ORG_B = "10000000-0000-4000-8000-00000000000b";
const ITEM = "20000000-0000-4000-8000-000000000001";
const env = {} as CloudflareEnv;
const caller = {
	authorization: "Bearer synthetic-only",
	mcpUrl: "https://plugin.example/mcp",
};

/** A fake API whose ledger rows belong to one organization each. */
function fakeApi(selectedOrg: string) {
	const ledger = [
		{ org: ORG_A, sequence: 3, id: "e3", change: "accepted" },
		{ org: ORG_B, sequence: 4, id: "e4", change: "accepted" },
		{ org: ORG_A, sequence: 5, id: "e5", change: "completed" },
	];
	const pollWorkStateChanges = vi.fn(
		async (input: { afterSequence: number | null; limit: number }) => {
			const own = ledger.filter((row) => row.org === selectedOrg);
			if (input.afterSequence == null)
				return {
					events: [],
					afterSequence: own.at(-1)?.sequence ?? 0,
					hasMore: false,
				};
			const after = own.filter((row) => row.sequence > input.afterSequence!);
			const page = after.slice(0, input.limit);
			return {
				events: page.map((row) => ({
					eventId: `evt_work_${row.id}`,
					timestamp: "2026-10-15T12:00:00.000Z",
					data: {
						organization_id: row.org,
						work_item_id: ITEM,
						change: row.change,
						disposition: row.change,
						attempt_id: null,
						attempt_outcome: null,
					},
				})),
				afterSequence: page.at(-1)?.sequence ?? input.afterSequence,
				hasMore: after.length > page.length,
			};
		},
	);
	const pollWorkApprovalRequests = vi.fn(async () => ({
		events: [],
		after: { at: "2026-10-15T12:00:00.000Z", id: "p1" },
		hasMore: false,
	}));
	const pollFailedSkillRuns = vi.fn(async () => ({
		events: [],
		after: { at: "", id: "" },
		hasMore: false,
	}));
	return {
		mcpEvents: {
			pollHomeRunFinished: vi.fn(async () => ({
				events: [],
				after: { at: "", id: "" },
				hasMore: false,
			})),
			pollWorkStateChanges,
			pollWorkApprovalRequests,
			pollWorkComments: vi.fn(async () => ({
				events: [],
				after: { at: "2026-10-15T12:00:00.000Z", id: "c1" },
				hasMore: false,
			})),
			pollWorkInteractionRequests: vi.fn(async () => ({
				events: [],
				after: { at: "2026-10-15T12:00:00.000Z", id: "i1" },
				hasMore: false,
			})),
			pollWorkInteractionResponses: vi.fn(
				async (input: { after: { at: string; id: string } | null }) => ({
					events:
						input.after === null
							? []
							: [
									{
										eventId: "evt_interaction_response_r2",
										timestamp: "2026-10-16T12:00:00.000Z",
										data: {
											organization_id: selectedOrg,
											request_id: ITEM,
											response_id: "r2",
										},
									},
								],
					after: { at: "2026-10-15T12:00:00.000Z", id: "r1" },
					hasMore: false,
				}),
			),
			pollFailedSkillRuns,
		},
	};
}

let authorize: ReturnType<typeof vi.fn>;
let api: ReturnType<typeof fakeApi>;

it("polls Home completion with messaging authority and preserves non-UUID conversation IDs", async () => {
	const name = "home.run.finished";
	const args = {
		organization_id: ORG_A,
		conversation_id: "home:example:CaseSensitive",
	};
	const head = await poll({ name, arguments: args });
	expect(head.cursor).toMatch(/^hrf1\./);
	await poll({ name, arguments: args, cursor: head.cursor });
	expect(api.mcpEvents.pollHomeRunFinished).toHaveBeenCalledWith({
		after: { at: "", id: "" },
		conversationId: args.conversation_id,
		limit: 50,
	});
	expect(authorize.mock.calls[0]?.[2]).toEqual([
		"mcp:messaging.read",
		"mcp:messaging.write",
		"mcp:messaging.admin",
	]);
	expect(() => assertEventCursor(name, "srf1.WyIiLCIiXQ")).toThrow();
});
beforeEach(() => {
	authorize = vi.fn(
		async (
			_env: CloudflareEnv,
			credential: { organizationId: string },
			_scopes: readonly string[],
		) => {
			api = fakeApi(credential.organizationId);
			return {
				client: api,
				organizationId: credential.organizationId,
				owner: "human",
				expiresAt: Date.now() + 60_000,
			};
		},
	);
});

function poll(params: Record<string, unknown>) {
	return pollEvent(env, caller, params, {
		authorize: authorize as never,
	});
}

describe("events/poll over the Work ledger", () => {
	it("starts from now, then resumes after the returned cursor", async () => {
		const first = await poll({
			name: "work.item.state_changed",
			arguments: { organization_id: ORG_A },
			cursor: null,
		});
		expect(first).toMatchObject({
			events: [],
			cursor: "wsc1.5",
			truncated: false,
			hasMore: false,
			nextPollMs: 30_000,
		});

		const replay = await poll({
			name: "work.item.state_changed",
			arguments: { organization_id: ORG_A },
			cursor: "wsc1.0",
			maxEvents: 1,
		});
		expect(replay.events).toEqual([
			expect.objectContaining({
				eventId: "evt_work_e3",
				name: "work.item.state_changed",
			}),
		]);
		expect(replay).toMatchObject({ cursor: "wsc1.3", hasMore: true });

		const next = await poll({
			name: "work.item.state_changed",
			arguments: { organization_id: ORG_A },
			cursor: replay.cursor,
		});
		expect(next.events.map((event) => event.eventId)).toEqual(["evt_work_e5"]);
		expect(next).toMatchObject({ cursor: "wsc1.5", hasMore: false });
	});

	it("binds every poll to the organization named in the arguments", async () => {
		const result = await poll({
			name: "work.item.state_changed",
			arguments: { organization_id: ORG_A },
			cursor: "wsc1.0",
		});
		expect(
			result.events.every((event) => event.data.organization_id === ORG_A),
		).toBe(true);
		expect(authorize).toHaveBeenCalledWith(
			env,
			{ ...caller, organizationId: ORG_A },
			["mcp:work.read", "mcp:work.write", "mcp:work.admin"],
		);
	});

	it("rejects a caller whose grant does not select the requested organization", async () => {
		authorize.mockImplementationOnce(async () => {
			throw new Error("Organization not selected");
		});
		await expect(
			poll({
				name: "work.item.state_changed",
				arguments: { organization_id: ORG_B },
				cursor: null,
			}),
		).rejects.toMatchObject({ code: -32024 });
		authorize.mockImplementationOnce(async () => ({
			client: fakeApi(ORG_A),
			organizationId: ORG_A,
			owner: "human",
			expiresAt: Date.now() + 60_000,
		}));
		await expect(
			poll({
				name: "work.item.state_changed",
				arguments: { organization_id: ORG_B },
				cursor: null,
			}),
		).rejects.toMatchObject({ code: -32024 });
	});

	it("requires a skills scope for skill.run.failed", async () => {
		await poll({
			name: "skill.run.failed",
			arguments: { organization_id: ORG_A },
			cursor: null,
		});
		expect(authorize.mock.calls[0]?.[2]).toContain("mcp:skills.read");
	});

	it("round-trips an opaque keyset cursor for approval requests", async () => {
		const first = await poll({
			name: "work.approval.requested",
			arguments: { organization_id: ORG_A, work_item_id: ITEM },
			cursor: null,
		});
		expect(first.cursor).toMatch(/^war1\./);
		await poll({
			name: "work.approval.requested",
			arguments: { organization_id: ORG_A, work_item_id: ITEM },
			cursor: first.cursor,
		});
		expect(api.mcpEvents.pollWorkApprovalRequests).toHaveBeenCalledWith({
			after: { at: "2026-10-15T12:00:00.000Z", id: "p1" },
			workItemId: ITEM,
			approverId: undefined,
			limit: 50,
		});
	});

	it("rejects unknown events, foreign cursors and undeclared arguments before any read", async () => {
		await expect(
			poll({ name: "email.received", arguments: {}, cursor: null }),
		).rejects.toMatchObject({ code: -32023 });
		await expect(
			poll({
				name: "work.approval.requested",
				arguments: { organization_id: ORG_A },
				cursor: "wsc1.3",
			}),
		).rejects.toBeInstanceOf(InteractionEventError);
		await expect(
			poll({
				name: "work.item.state_changed",
				arguments: { organization_id: ORG_A, tedi_id: ITEM },
				cursor: null,
			}),
		).rejects.toMatchObject({ code: -32602 });
		expect(authorize).toHaveBeenCalledTimes(1);
	});
});

it.each([
	{
		name: "work.item.commented",
		prefix: "wcm1",
		proc: "pollWorkComments" as const,
		id: "c1",
		filters: { author_type: "external_agent" },
		expected: { authorType: "external_agent" },
	},
	{
		name: "work.interaction.requested",
		prefix: "wir1",
		proc: "pollWorkInteractionRequests" as const,
		id: "i1",
		filters: { target_id: "Agent:CaseSensitive", kind: "coordination" },
		expected: { targetId: "Agent:CaseSensitive", kind: "coordination" },
	},
])(
	"round-trips $name cursors and forwards filters under Work read scopes",
	async ({ name, prefix, proc, id, filters, expected }) => {
		const args = { organization_id: ORG_A, work_item_id: ITEM, ...filters };
		const first = await poll({ name, arguments: args, cursor: null });
		expect(first.events).toEqual([]);
		expect(first.cursor).toMatch(new RegExp(`^${prefix}\\.`));
		expect(api.mcpEvents[proc]).toHaveBeenCalledWith({
			after: null,
			workItemId: ITEM,
			...expected,
			limit: 50,
		});
		await poll({ name, arguments: args, cursor: first.cursor, maxEvents: 1 });
		expect(api.mcpEvents[proc]).toHaveBeenCalledWith({
			after: { at: "2026-10-15T12:00:00.000Z", id },
			workItemId: ITEM,
			...expected,
			limit: 1,
		});
		expect(authorize.mock.calls[0]?.[2]).toEqual([
			"mcp:work.read",
			"mcp:work.write",
			"mcp:work.admin",
		]);
	},
);

it.each([
	["work.item.commented", { author_type: "USER" }],
	["work.item.commented", { author_type: "question" }],
	["work.interaction.requested", { kind: "system" }],
	["work.interaction.requested", { kind: "QUESTION" }],
	["work.interaction.requested", { target_id: "" }],
	["work.interaction.requested", { target_id: "x".repeat(129) }],
	["work.item.commented", { work_item_id: "not-a-uuid" }],
	["work.interaction.requested", { work_item_id: "not-a-uuid" }],
	["work.item.commented", { metadata: "private" }],
	["work.interaction.requested", { prompt: "private" }],
])(
	"rejects invalid arguments for %s before authorization",
	async (name, filters) => {
		await expect(
			poll({
				name,
				arguments: { organization_id: ORG_A, ...filters },
				cursor: null,
			}),
		).rejects.toMatchObject({ code: -32602 });
		expect(authorize).not.toHaveBeenCalled();
	},
);

it("validates every author and interaction kind and rejects foreign cursor prefixes", () => {
	for (const author_type of ["user", "tedi", "external_agent", "system"])
		expect(
			eventArguments("work.item.commented", {
				organization_id: ORG_A,
				author_type,
			}).author_type,
		).toBe(author_type);
	for (const kind of ["question", "input", "handoff", "coordination"])
		expect(
			eventArguments("work.interaction.requested", {
				organization_id: ORG_A,
				kind,
			}).kind,
		).toBe(kind);
	for (const name of [
		"work.item.commented",
		"work.interaction.requested",
	] as const) {
		for (const cursor of [
			"war1.WyIiLCIiXQ",
			"srf1.WyIiLCIiXQ",
			"wsc1.0",
			"garbage",
		])
			expect(() => assertEventCursor(name, cursor)).toThrow(
				InteractionEventError,
			);
	}
	expect(() =>
		assertEventCursor("work.item.commented", "wir1.WyIiLCIiXQ"),
	).toThrow(InteractionEventError);
	expect(() =>
		assertEventCursor("work.interaction.requested", "wcm1.WyIiLCIiXQ"),
	).toThrow(InteractionEventError);
});

it("polls replies with messaging scopes, optional filters and a distinct cursor", async () => {
	const name = "work.interaction.responded";
	const args = {
		organization_id: ORG_A,
		request_id: ITEM,
		work_item_id: ITEM,
		responder_type: "external_agent",
	};
	const first = await poll({
		name,
		arguments: { organization_id: ORG_A },
		cursor: null,
	});
	expect(first.cursor).toMatch(/^wrr1\./);
	expect(api.mcpEvents.pollWorkInteractionResponses).toHaveBeenCalledWith({
		after: null,
		limit: 50,
	});
	const resumed = await poll({
		name,
		arguments: args,
		cursor: first.cursor,
		maxEvents: 1,
	});
	expect(resumed.events).toEqual([
		{
			name,
			eventId: "evt_interaction_response_r2",
			timestamp: "2026-10-16T12:00:00.000Z",
			data: { organization_id: ORG_A, request_id: ITEM, response_id: "r2" },
		},
	]);
	expect(api.mcpEvents.pollWorkInteractionResponses).toHaveBeenCalledWith({
		after: { at: "2026-10-15T12:00:00.000Z", id: "r1" },
		requestId: ITEM,
		workItemId: ITEM,
		responderType: "external_agent",
		limit: 1,
	});
	expect(authorize.mock.calls[0]?.[2]).toEqual([
		"mcp:messaging.read",
		"mcp:messaging.write",
		"mcp:messaging.admin",
	]);
	expect(() => assertEventCursor(name, "wir1.WyIiLCIiXQ")).toThrow(
		InteractionEventError,
	);
});
it.each([
	{ responder_type: "system" },
	{ responder_type: "USER" },
	{ request_id: "invalid" },
	{ body: "private" },
])("rejects invalid reply filters %s", async (filters) => {
	await expect(
		poll({
			name: "work.interaction.responded",
			arguments: { organization_id: ORG_A, ...filters },
		}),
	).rejects.toMatchObject({ code: -32602 });
	expect(authorize).not.toHaveBeenCalled();
});

it("replays pending lane requests on binding and keeps its cursor separate from other asks", async () => {
	const first = await poll({
		name: "lane.requested",
		arguments: { organization_id: ORG_A },
	});
	expect(first.cursor).toMatch(/^lnr1\./);
	expect(api.mcpEvents.pollWorkInteractionRequests).toHaveBeenCalledWith(
		expect.objectContaining({
			laneRequestsOnly: true,
			after: { at: "", id: "" },
		}),
	);
	expect(() =>
		assertEventCursor("work.interaction.requested", first.cursor),
	).toThrow();
	expect(() =>
		eventArguments("lane.requested", {
			organization_id: ORG_A,
			target_id: "someone-else",
		}),
	).toThrow();
});
