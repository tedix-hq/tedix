import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import {
	deliverDueEventWebhooks,
	type EventWebhookDependencies,
	MAX_CONSECUTIVE_FAILURES,
	MAX_EVENTS_PER_HOUR,
	subscribeEventWebhook,
	unsubscribeEventWebhook,
} from "./event-webhooks";
import type { PollableEventName } from "./work-events";
import { sendInteractionWebhook } from "./interaction-events";

const ORG_A = "10000000-0000-4000-8000-00000000000a";
const ORG_B = "10000000-0000-4000-8000-00000000000b";
const ITEM = "20000000-0000-4000-8000-000000000001";
const CALLBACK = "https://hooks.example/tedix";
const SECRET_BYTES = "s".repeat(32);
const SECRET = `whsec_${btoa(SECRET_BYTES)}`;
const MCP_URL = "https://tedix.mcp.example/mcp";
const T0 = Date.parse("2026-10-15T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const env = {
	PLATFORM_SERVICE_TOKEN: "platform-service-token-for-tests",
} as unknown as CloudflareEnv;

type Row = {
	id: string;
	organizationId: string;
	ownerSubject: string;
	mcpUrl: string;
	eventName: PollableEventName;
	arguments: Record<string, string>;
	callbackUrl: string;
	sealedCredential: string;
	claimToken: string | null;
	cursor: string;
	status: "active" | "unhealthy";
	consecutiveFailures: number;
	nextAttemptAt: number;
	rateWindowStartedAt: string | null;
	rateWindowCount: number;
	expiresAt: string;
};

/**
 * One in-memory installation: an org-bound Work ledger, the API's
 * subscription store, a token table for the authorizer, a fake clock and a
 * webhook receiver behind the global fetch that `guardedFetch` uses.
 */
function installation() {
	let now = T0;
	let sequence = 100;
	const ledger: Array<{ org: string; sequence: number; change: string }> = [];
	const keysetLedger: Array<{
		name: PollableEventName;
		org: string;
		id: string;
		at: string;
		data: Record<string, unknown>;
	}> = [];
	const rows = new Map<string, Row>();
	const tokens = new Map([
		["Bearer alice", { owner: "alice", orgs: [ORG_A] }],
		["Bearer bob", { owner: "bob", orgs: [ORG_B] }],
	]);
	const received: Array<{ headers: Headers; body: string }> = [];
	let receiverStatus = 200;

	const keysetFeed = (organizationId: string, name: PollableEventName) =>
		vi.fn(
			async (input: {
				after: { at: string; id: string } | null;
				limit: number;
				workItemId?: string;
				authorType?: string;
				targetId?: string;
				kind?: string;
			}) => {
				const own = keysetLedger.filter(
					(row) => row.org === organizationId && row.name === name,
				);
				if (input.after === null) {
					const last = own.at(-1);
					return {
						events: [],
						after: last ? { at: last.at, id: last.id } : { at: "", id: "" },
						hasMore: false,
					};
				}
				const after = own.filter(
					(row) =>
						(row.at > input.after!.at ||
							(row.at === input.after!.at && row.id > input.after!.id)) &&
						(!input.workItemId || row.data.work_item_id === input.workItemId) &&
						(!input.authorType || row.data.author_type === input.authorType) &&
						(!input.targetId || row.data.target_id === input.targetId) &&
						(!input.kind || row.data.kind === input.kind),
				);
				const page = after.slice(0, input.limit);
				const last = page.at(-1);
				return {
					events: page.map((row) => ({
						eventId: `evt_${name === "work.item.commented" ? "comment" : "interaction"}_${row.id}`,
						timestamp: row.at,
						data: row.data,
					})),
					after: last ? { at: last.at, id: last.id } : input.after,
					hasMore: after.length > page.length,
				};
			},
		);
	const client = (organizationId: string, owner: string) => ({
		mcpEvents: {
			pollHomeRunFinished: keysetFeed(organizationId, "home.run.finished"),
			pollWorkComments: keysetFeed(organizationId, "work.item.commented"),
			pollWorkInteractionRequests: keysetFeed(
				organizationId,
				"work.interaction.requested",
			),
			pollWorkStateChanges: vi.fn(
				async (input: { afterSequence?: number | null; limit: number }) => {
					const own = ledger.filter((row) => row.org === organizationId);
					if (input.afterSequence == null)
						return { events: [], afterSequence: sequence, hasMore: false };
					const after = own.filter(
						(row) => row.sequence > input.afterSequence!,
					);
					const page = after.slice(0, input.limit);
					return {
						events: page.map((row) => ({
							eventId: `evt_work_${row.sequence}`,
							timestamp: new Date(now).toISOString(),
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
			),
			upsertWebhookSubscription: vi.fn(
				async (input: {
					id: string;
					eventName: PollableEventName;
					arguments: Record<string, string>;
					mcpUrl: string;
					callbackUrl: string;
					sealedCredential: string;
					cursor: string;
					keepCursor: boolean;
					expiresAt: string;
				}) => {
					const existing = rows.get(input.id);
					const cursor =
						input.keepCursor && existing?.status === "active"
							? existing.cursor
							: input.cursor;
					rows.set(input.id, {
						...input,
						organizationId,
						ownerSubject: owner,
						cursor,
						claimToken: null,
						status: "active",
						consecutiveFailures: 0,
						nextAttemptAt: now,
						rateWindowStartedAt: existing?.rateWindowStartedAt ?? null,
						rateWindowCount: existing?.rateWindowCount ?? 0,
					});
					return { id: input.id, cursor, expiresAt: input.expiresAt };
				},
			),
			deleteWebhookSubscription: vi.fn(async (input: { id: string }) => {
				const row = rows.get(input.id);
				const owned =
					row?.organizationId === organizationId && row.ownerSubject === owner;
				if (owned) rows.delete(input.id);
				return { deleted: owned };
			}),
		},
	});

	const authorize = vi.fn(
		async (
			_env: CloudflareEnv,
			credential: { authorization: string; organizationId: string },
		) => {
			const grant = tokens.get(credential.authorization);
			if (!grant || !grant.orgs.includes(credential.organizationId))
				throw new Error("forbidden");
			return {
				client: client(credential.organizationId, grant.owner),
				organizationId: credential.organizationId,
				owner: grant.owner,
				expiresAt: now + 24 * 60 * 60 * 1000,
			};
		},
	);

	const service = {
		claimDueWebhookSubscriptions: vi.fn(async (input: { limit: number }) => {
			for (const [id, row] of rows)
				if (Date.parse(row.expiresAt) <= now) rows.delete(id);
			const due = [...rows.values()]
				.filter((row) => row.status === "active" && row.nextAttemptAt <= now)
				.slice(0, input.limit);
			for (const row of due) {
				row.nextAttemptAt = now + 110_000;
				row.claimToken = crypto.randomUUID();
			}
			return {
				subscriptions: due.map(({ status: _s, nextAttemptAt: _n, ...row }) => ({
					...row,
				})),
			};
		}),
		recordWebhookDelivery: vi.fn(
			async (input: {
				id: string;
				claimToken: string;
				organizationId: string;
				cursor: string;
				status: "active" | "unhealthy";
				consecutiveFailures: number;
				nextAttemptAt: string;
				rateWindowStartedAt: string | null;
				rateWindowCount: number;
			}) => {
				const row = rows.get(input.id);
				if (
					!row ||
					row.organizationId !== input.organizationId ||
					row.claimToken !== input.claimToken
				)
					return { recorded: false };
				Object.assign(row, {
					claimToken: null,
					cursor: input.cursor,
					status: input.status,
					consecutiveFailures: input.consecutiveFailures,
					nextAttemptAt: Date.parse(input.nextAttemptAt),
					rateWindowStartedAt: input.rateWindowStartedAt,
					rateWindowCount: input.rateWindowCount,
				});
				return { recorded: true };
			},
		),
	};

	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url: string, init: RequestInit) => {
			const body = init.body as string;
			const parsed = JSON.parse(body) as { type?: string; challenge?: string };
			if (parsed.type === "verification")
				return Response.json({ challenge: parsed.challenge });
			received.push({ headers: new Headers(init.headers), body });
			return new Response(null, { status: receiverStatus });
		}),
	);

	const dependencies: EventWebhookDependencies = {
		authorize: authorize as unknown as EventWebhookDependencies["authorize"],
		send: sendInteractionWebhook,
		now: () => now,
	};
	return {
		keysetLedger,
		rows,
		tokens,
		received,
		service,
		dependencies,
		setReceiverStatus: (status: number) => {
			receiverStatus = status;
		},
		advance: (ms: number) => {
			now += ms;
		},
		change: (org: string, change = "completed") =>
			ledger.push({ org, sequence: ++sequence, change }),
		deliver: () =>
			deliverDueEventWebhooks(env, {
				service: service as never,
				dependencies,
			}),
	};
}

function subscribeParams(
	organizationId = ORG_A,
	extra: Record<string, unknown> = {},
) {
	return {
		name: "work.item.state_changed",
		arguments: { organization_id: organizationId },
		delivery: { mode: "webhook", url: CALLBACK, secret: SECRET },
		...extra,
	};
}

const alice = { authorization: "Bearer alice", mcpUrl: MCP_URL };

async function verifySignature(
	headers: Headers,
	body: string,
	secretBytes = SECRET_BYTES,
): Promise<boolean> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secretBytes),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["verify"],
	);
	const signature = Uint8Array.from(
		atob(headers.get("webhook-signature")!.slice(3)),
		(c) => c.charCodeAt(0),
	);
	return crypto.subtle.verify(
		"HMAC",
		key,
		signature,
		new TextEncoder().encode(
			`${headers.get("webhook-id")}.${headers.get("webhook-timestamp")}.${body}`,
		),
	);
}

let f: ReturnType<typeof installation>;
beforeEach(() => {
	f = installation();
});
afterEach(() => {
	vi.unstubAllGlobals();
});

describe("events/subscribe webhook delivery", () => {
	it("delivers a signed POST for a state change after subscribe", async () => {
		const result = await subscribeEventWebhook(
			env,
			alice,
			subscribeParams(),
			f.dependencies,
		);
		expect(result).toMatchObject({
			id: expect.stringMatching(/^evsub_[0-9a-f]{64}$/),
			cursor: "wsc1.100",
			truncated: false,
			refreshBefore: new Date(T0 + 60 * 60 * 1000).toISOString(),
		});
		// Nothing before the subscription is replayed.
		expect(await f.deliver()).toMatchObject({ idle: 1, delivered: 0 });
		f.change(ORG_A, "completed");
		expect(await f.deliver()).toMatchObject({ delivered: 1 });
		expect(f.received).toHaveLength(1);
		const [delivery] = f.received;
		expect(delivery!.headers.get("webhook-id")).toBe("evt_work_101");
		expect(delivery!.headers.get("X-MCP-Subscription-Id")).toBe(result.id);
		expect(JSON.parse(delivery!.body)).toEqual({
			eventId: "evt_work_101",
			name: "work.item.state_changed",
			timestamp: new Date(T0).toISOString(),
			data: {
				organization_id: ORG_A,
				work_item_id: ITEM,
				change: "completed",
				disposition: "completed",
				attempt_id: null,
				attempt_outcome: null,
			},
			cursor: "wsc1.101",
		});
		// The cursor moved: the same event is not delivered twice.
		expect(await f.deliver()).toMatchObject({ idle: 1, delivered: 0 });
		expect(f.received).toHaveLength(1);
		// The bearer and webhook secret never reach the API in the clear.
		const row = [...f.rows.values()][0]!;
		expect(row.sealedCredential).not.toContain("alice");
		expect(row.sealedCredential).not.toContain(SECRET);
	});

	it("passes the claim token and reports a superseded result as skipped", async () => {
		await subscribeEventWebhook(env, alice, subscribeParams(), f.dependencies);
		f.change(ORG_A);
		const persist = f.service.recordWebhookDelivery.getMockImplementation()!;
		f.service.recordWebhookDelivery.mockImplementationOnce(async (input) => {
			const claim = f.service.claimDueWebhookSubscriptions.mock.results[0]!;
			const { subscriptions } = await claim.value;
			expect(input.claimToken).toBe(subscriptions[0]!.claimToken);
			expect(input.claimToken).toEqual(expect.any(String));
			await subscribeEventWebhook(
				env,
				alice,
				subscribeParams(ORG_A, {
					cursor: "wsc1.200",
				}),
				f.dependencies,
			);
			return persist(input);
		});
		expect(await f.deliver()).toMatchObject({
			claimed: 1,
			skipped: 1,
			delivered: 0,
		});
		expect([...f.rows.values()][0]).toMatchObject({
			cursor: "wsc1.200",
			claimToken: null,
		});
		f.change(ORG_A);
		expect(await f.deliver()).toMatchObject({ idle: 1 });
	});

	it("signs the exact body with the subscriber's secret", async () => {
		await subscribeEventWebhook(env, alice, subscribeParams(), f.dependencies);
		f.change(ORG_A);
		await f.deliver();
		const [delivery] = f.received;
		expect(await verifySignature(delivery!.headers, delivery!.body)).toBe(true);
		expect(
			await verifySignature(delivery!.headers, delivery!.body, "x".repeat(32)),
		).toBe(false);
		expect(
			await verifySignature(
				delivery!.headers,
				delivery!.body.replace("completed", "cancelled"),
			),
		).toBe(false);
	});

	it("stops delivering once the lease expires", async () => {
		await subscribeEventWebhook(
			env,
			alice,
			subscribeParams(ORG_A, { ttlMs: 5_000 }),
			f.dependencies,
		);
		f.advance(5_000);
		f.change(ORG_A);
		expect(await f.deliver()).toMatchObject({ claimed: 0 });
		expect(f.received).toHaveLength(0);
		expect(f.rows.size).toBe(0);
	});

	it("stops delivering after unsubscribe", async () => {
		await subscribeEventWebhook(env, alice, subscribeParams(), f.dependencies);
		expect(
			await unsubscribeEventWebhook(
				env,
				alice,
				{
					name: "work.item.state_changed",
					arguments: { organization_id: ORG_A },
					delivery: { mode: "webhook", url: CALLBACK },
				},
				f.dependencies,
			),
		).toEqual({});
		expect(f.rows.size).toBe(0);
		f.change(ORG_A);
		await f.deliver();
		expect(f.received).toHaveLength(0);
	});

	it("isolates organizations at subscribe and at delivery", async () => {
		await expect(
			subscribeEventWebhook(env, alice, subscribeParams(ORG_B), f.dependencies),
		).rejects.toMatchObject({ code: -32024 });
		await subscribeEventWebhook(env, alice, subscribeParams(), f.dependencies);
		await subscribeEventWebhook(
			env,
			{ authorization: "Bearer bob", mcpUrl: MCP_URL },
			subscribeParams(ORG_B),
			f.dependencies,
		);
		f.change(ORG_B, "cancelled");
		await f.deliver();
		expect(f.received).toHaveLength(1);
		expect(JSON.parse(f.received[0]!.body).data.organization_id).toBe(ORG_B);
		// Bob cannot remove Alice's lease even with her exact arguments.
		await unsubscribeEventWebhook(
			env,
			{ authorization: "Bearer bob", mcpUrl: MCP_URL },
			{
				name: "work.item.state_changed",
				arguments: { organization_id: ORG_B },
				delivery: { mode: "webhook", url: CALLBACK },
			},
			f.dependencies,
		);
		expect(
			[...f.rows.values()].filter((row) => row.organizationId === ORG_A),
		).toHaveLength(1);
	});

	it("rechecks access at delivery and discloses nothing after revocation", async () => {
		await subscribeEventWebhook(env, alice, subscribeParams(), f.dependencies);
		f.tokens.delete("Bearer alice");
		f.change(ORG_A);
		expect(await f.deliver()).toMatchObject({ failed: 1 });
		expect(f.received).toHaveLength(0);
	});

	it("retries with backoff, then gives up and marks the lease unhealthy", async () => {
		await subscribeEventWebhook(
			env,
			alice,
			subscribeParams(ORG_A, { ttlMs: DAY_MS }),
			f.dependencies,
		);
		f.setReceiverStatus(503);
		f.change(ORG_A);
		for (let attempt = 1; attempt < MAX_CONSECUTIVE_FAILURES; attempt++) {
			expect(await f.deliver()).toMatchObject({ failed: 1 });
			// Backoff: not due again on the next immediate pass.
			expect(await f.deliver()).toMatchObject({ claimed: 0 });
			f.advance(31 * 60 * 1000);
		}
		expect(await f.deliver()).toMatchObject({ unhealthy: 1 });
		expect(f.received).toHaveLength(MAX_CONSECUTIVE_FAILURES);
		// Every retry carried the same event id for receiver dedupe.
		expect(new Set(f.received.map((r) => r.headers.get("webhook-id")))).toEqual(
			new Set(["evt_work_101"]),
		);
		const [row] = f.rows.values();
		expect(row).toMatchObject({ status: "unhealthy", cursor: "wsc1.100" });
		f.setReceiverStatus(200);
		f.advance(60 * 60 * 1000);
		expect(await f.deliver()).toMatchObject({ claimed: 0 });
		expect(f.received).toHaveLength(MAX_CONSECUTIVE_FAILURES);
		// Subscribing again restarts a healthy lease from now.
		await subscribeEventWebhook(
			env,
			alice,
			subscribeParams(ORG_A, { ttlMs: DAY_MS }),
			f.dependencies,
		);
		expect([...f.rows.values()][0]).toMatchObject({
			status: "active",
			cursor: "wsc1.101",
		});
	});

	it("rate-limits one subscription during an event storm", async () => {
		await subscribeEventWebhook(
			env,
			alice,
			subscribeParams(ORG_A, { ttlMs: DAY_MS }),
			f.dependencies,
		);
		for (let i = 0; i < MAX_EVENTS_PER_HOUR + 20; i++) f.change(ORG_A);
		let passes = 0;
		while (f.received.length < MAX_EVENTS_PER_HOUR && passes++ < 50)
			await f.deliver();
		expect(f.received).toHaveLength(MAX_EVENTS_PER_HOUR);
		expect(await f.deliver()).toMatchObject({ rate_limited: 1 });
		expect(f.received).toHaveLength(MAX_EVENTS_PER_HOUR);
		f.advance(60 * 60 * 1000);
		await f.deliver();
		expect(f.received).toHaveLength(MAX_EVENTS_PER_HOUR + 20);
	});

	it("refuses delivery when the app has not opted into webhooks", async () => {
		f.dependencies.authorize = vi.fn(async () => {
			throw new Error("Event webhooks unavailable");
		}) as unknown as EventWebhookDependencies["authorize"];
		await expect(
			subscribeEventWebhook(env, alice, subscribeParams(), f.dependencies),
		).rejects.toMatchObject({ code: -32024 });
		expect(f.rows.size).toBe(0);
	});
});

it.each([
	{
		name: "home.run.finished" as const,
		prefix: "hrf1",
		eventId: "evt_interaction_home-example",
		id: "home-example",
		filters: { conversation_id: "home:example" },
		data: {
			organization_id: ORG_A,
			conversation_id: "home:example",
			run_id: "run-example",
			parent_run_id: null,
			status: "completed",
		},
	},
	{
		name: "work.item.commented" as const,
		prefix: "wcm1",
		eventId: "evt_comment_c1",
		id: "c1",
		filters: { author_type: "system" },
		data: {
			organization_id: ORG_A,
			work_item_id: ITEM,
			comment_id: "c1",
			author_type: "system",
			author_id: null,
		},
	},
	{
		name: "work.interaction.requested" as const,
		prefix: "wir1",
		eventId: "evt_interaction_i1",
		id: "i1",
		filters: { target_id: "Agent:CaseSensitive", kind: "question" },
		data: {
			organization_id: ORG_A,
			request_id: "i1",
			work_item_id: ITEM,
			project_id: null,
			kind: "question",
			target_type: "external_agent",
			target_id: "Agent:CaseSensitive",
			creator_type: "system",
			due_at: null,
		},
	},
])(
	"delivers, renews and unsubscribes signed $name webhooks",
	async ({ name, prefix, eventId, id, filters, data }) => {
		const args = {
			organization_id: ORG_A,
			...(name === "home.run.finished" ? {} : { work_item_id: ITEM }),
			...filters,
		};
		const params = subscribeParams(ORG_A, { name, arguments: args });
		const subscribed = await subscribeEventWebhook(
			env,
			alice,
			params,
			f.dependencies,
		);
		expect(subscribed.cursor).toMatch(new RegExp(`^${prefix}\\.`));
		expect(await f.deliver()).toMatchObject({ idle: 1, delivered: 0 });
		f.keysetLedger.push({
			name,
			org: ORG_B,
			id: "foreign",
			at: new Date(T0).toISOString(),
			data: { ...data, organization_id: ORG_B },
		});
		f.keysetLedger.push({
			name,
			org: ORG_A,
			id,
			at: new Date(T0).toISOString(),
			data,
		});
		expect(await f.deliver()).toMatchObject({ delivered: 1 });
		const delivery = f.received[0]!;
		expect(await verifySignature(delivery.headers, delivery.body)).toBe(true);
		expect(delivery.headers.get("webhook-id")).toBe(eventId);
		const body = JSON.parse(delivery.body);
		expect(body).toEqual({
			eventId,
			name,
			timestamp: new Date(T0).toISOString(),
			data,
			cursor: expect.stringMatching(new RegExp(`^${prefix}\\.`)),
		});
		expect(Object.keys(body.data).sort()).toEqual(Object.keys(data).sort());
		const renewed = await subscribeEventWebhook(
			env,
			alice,
			params,
			f.dependencies,
		);
		expect(renewed.id).toBe(subscribed.id);
		expect(renewed.cursor).toBe(body.cursor);
		expect(await f.deliver()).toMatchObject({ idle: 1, delivered: 0 });
		expect(f.received).toHaveLength(1);
		await unsubscribeEventWebhook(
			env,
			alice,
			{ name, arguments: args, delivery: { mode: "webhook", url: CALLBACK } },
			f.dependencies,
		);
		expect(f.rows.size).toBe(0);
	},
);

it("rejects reply events from the ledger webhook lease path", async () => {
	await expect(
		subscribeEventWebhook(
			{} as CloudflareEnv,
			{
				authorization: "Bearer synthetic",
				mcpUrl: "https://plugin.example/mcp",
			},
			{
				name: "work.interaction.responded",
				arguments: { organization_id: ORG_A },
			},
		),
	).rejects.toMatchObject({ code: -32023 });
});
