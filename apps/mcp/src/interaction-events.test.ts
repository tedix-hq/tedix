import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	InteractionEventSubscriptions,
	INTERACTION_REPLY_EVENT,
	interactionEventTarget,
	sendInteractionWebhook,
} from "./interaction-events";
const ORG = "10000000-0000-4000-8000-000000000001",
	REQUEST = "20000000-0000-4000-8000-000000000002",
	RESPONSE = "30000000-0000-4000-8000-000000000003";
const SECRET = `whsec_${btoa("x".repeat(32))}`;
const credential = {
	authorization: "Bearer synthetic-test-only",
	mcpUrl: "https://plugin.example/mcp",
	organizationId: ORG,
	requestId: REQUEST,
};
const params = {
	name: INTERACTION_REPLY_EVENT,
	arguments: { organization_id: ORG, request_id: REQUEST },
	delivery: {
		mode: "webhook",
		url: "https://callback.example/events",
		secret: SECRET,
	},
	cursor: null,
};
const publication = {
	organizationId: ORG,
	requestId: REQUEST,
	responseId: RESPONSE,
	respondedAt: "2026-10-05T10:00:00.000Z",
};
function fixture() {
	const rows = new Map<string, unknown>();
	let alarm: number | null = null;
	let transactionTail: Promise<unknown> = Promise.resolve();
	const storage = {
		get: async (key: string) => structuredClone(rows.get(key)),
		put: async (key: string, value: unknown) => {
			rows.set(key, structuredClone(value));
		},
		delete: async (key: string) => rows.delete(key),
		list: async ({ prefix, limit }: { prefix: string; limit: number }) =>
			new Map(
				[...rows]
					.filter(([key]) => key.startsWith(prefix))
					.slice(0, limit)
					.map(([k, v]) => [k, structuredClone(v)]),
			),
		deleteAlarm: async () => {
			alarm = null;
		},
		transaction: async (
			closure: (transaction: DurableObjectStorage) => Promise<unknown>,
		) => {
			const operation = transactionTail.then(async () => {
				const before = structuredClone(rows);
				try {
					return await closure(storage);
				} catch (error) {
					rows.clear();
					for (const [k, v] of before) rows.set(k, v);
					throw error;
				}
			});
			transactionTail = operation.catch(() => {});
			return operation;
		},
		getAlarm: async () => alarm,
		setAlarm: async (at: number) => {
			alarm = at;
		},
	} as unknown as DurableObjectStorage;
	const authorize = vi.fn(async () => ({
		owner: "synthetic-user",
		expiresAt: Date.now() + 60_000,
	}));
	const send = vi.fn(
		async (
			_url: string,
			_secret: string,
			_sub: string,
			_id: string,
			payload: unknown,
			_previousSecret?: string,
		) => {
			const value = payload as Record<string, unknown>;
			return Response.json(
				value.type === "verification" ? { challenge: value.challenge } : {},
			);
		},
	);
	return {
		rows,
		storage,
		authorize,
		send,
		events: new InteractionEventSubscriptions(storage, {} as CloudflareEnv, {
			authorize,
			send,
		}),
	};
}
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});
describe("exact Interaction reply webhook lifecycle", () => {
	it("bounds concurrent callback verification subscriptions at twenty", async () => {
		const f = fixture();
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let verified = 0;
		f.send.mockImplementation(async (_url, _secret, _sub, _id, payload) => {
			verified++;
			if (verified === 21) release?.();
			await gate;
			return Response.json({
				challenge: (payload as { challenge: string }).challenge,
			});
		});
		const results = await Promise.allSettled(
			Array.from({ length: 21 }, (_, i) =>
				f.events.subscribe({
					credential,
					params: {
						...params,
						delivery: {
							...params.delivery,
							url: `https://callback.example/events/${i}`,
						},
					},
				}),
			),
		);
		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(20);
		expect(
			results.filter((result) => result.status === "rejected"),
		).toHaveLength(1);
		expect(
			[...f.rows.keys()].filter((key) => key.startsWith("sub:")),
		).toHaveLength(20);
	});
	it("rotates keys under one stable subscription with bounded old-key overlap", async () => {
		vi.useFakeTimers();
		const f = fixture();
		f.authorize.mockResolvedValue({
			owner: "synthetic-user",
			expiresAt: Date.now() + 3_600_000,
		});
		const first = await f.events.subscribe({ credential, params });
		const newSecret = `whsec_${btoa("y".repeat(32))}`;
		const rotatedParams = {
			...params,
			delivery: { ...params.delivery, secret: newSecret },
		};
		const rotated = await f.events.subscribe({
			credential,
			params: rotatedParams,
		});
		expect(rotated.id).toBe(first.id);
		expect(f.send.mock.calls[1]?.[5]).toBe(SECRET);
		await f.events.publish(publication);
		await f.events.alarm();
		expect(f.send.mock.calls[2]?.[1]).toBe(newSecret);
		expect(f.send.mock.calls[2]?.[5]).toBe(SECRET);
		await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
		await f.events.alarm();
		expect(
			[...f.rows.values()].find(
				(row) => (row as { id?: string }).id === first.id,
			),
		).not.toHaveProperty("previousSecret");
		await f.events.publish({
			...publication,
			responseId: "30000000-0000-4000-8000-000000000004",
		});
		await f.events.alarm();
		expect(f.send.mock.calls[3]?.[5]).toBeUndefined();
	});
	it("verifies callback, caps TTL at credential expiry, renews idempotently", async () => {
		const f = fixture();
		const first = await f.events.subscribe({ credential, params });
		const next = await f.events.subscribe({ credential, params });
		expect(first.id).toBe(next.id);
		expect(first.cursor).toBeNull();
		expect(first.truncated).toBe(false);
		expect(Date.parse(first.refreshBefore as string)).toBeLessThanOrEqual(
			Date.now() + 60_000,
		);
		expect(Object.keys(first).sort()).toEqual([
			"cursor",
			"id",
			"refreshBefore",
			"truncated",
		]);
		expect(f.send).toHaveBeenCalledTimes(1);
		expect(f.authorize).toHaveBeenCalledTimes(2);
	});
	it("fails callback challenge without persisting", async () => {
		const f = fixture();
		f.send.mockResolvedValue(Response.json({ challenge: "wrong" }));
		await expect(
			f.events.subscribe({ credential, params }),
		).rejects.toMatchObject({ code: -32015 });
		expect(f.rows.size).toBe(0);
	});
	it("rejects private callbacks, invalid secrets, mismatched filters and replay", async () => {
		for (const invalid of [
			{
				...params,
				delivery: { ...params.delivery, url: "https://127.0.0.1/events" },
			},
			{ ...params, delivery: { ...params.delivery, secret: "whsec_eA==" } },
			{ ...params, cursor: "old" },
			{ ...params, arguments: { ...params.arguments, request_id: RESPONSE } },
		]) {
			const f = fixture();
			await expect(
				f.events.subscribe({ credential, params: invalid }),
			).rejects.toBeDefined();
			expect(f.send).not.toHaveBeenCalled();
			expect(f.rows.size).toBe(0);
		}
		expect(() =>
			interactionEventTarget({ ...params.arguments, extra: "widen" }),
		).toThrow();
	});
	it("delivers matching saved IDs only, rechecks access, deduplicates", async () => {
		const f = fixture();
		await f.events.subscribe({ credential, params });
		expect(
			await f.events.publish({ ...publication, organizationId: RESPONSE }),
		).toBe(0);
		expect(await f.events.publish(publication)).toBe(1);
		expect(await f.events.publish(publication)).toBe(0);
		await f.events.alarm();
		expect(f.authorize).toHaveBeenCalledTimes(2);
		expect(f.send.mock.calls[1]?.[4]).toEqual({
			eventId: `evt_${RESPONSE}`,
			name: INTERACTION_REPLY_EVENT,
			timestamp: publication.respondedAt,
			data: {
				organization_id: ORG,
				request_id: REQUEST,
				response_id: RESPONSE,
			},
			cursor: null,
		});
		await f.events.alarm();
		expect(f.send).toHaveBeenCalledTimes(2);
		expect(
			[...f.rows.values()].find((v) => (v as { outcome?: string }).outcome),
		).toMatchObject({ outcome: "acknowledged" });
	});
	it("unavailable access withholds disclosure and recovers without losing the reply", async () => {
		vi.useFakeTimers();
		const f = fixture();
		await f.events.subscribe({ credential, params });
		await f.events.publish(publication);
		f.authorize.mockRejectedValueOnce(new Error("unknown access"));
		await f.events.alarm();
		expect(f.send).toHaveBeenCalledTimes(1);
		expect(f.rows.size).toBe(2);
		await vi.advanceTimersByTimeAsync(2001);
		await f.events.alarm();
		expect(f.send).toHaveBeenCalledTimes(2);
	});
	it("retries transient errors with stable ID after DO reconstruction", async () => {
		vi.useFakeTimers();
		const f = fixture();
		await f.events.subscribe({ credential, params });
		await f.events.publish(publication);
		f.send.mockResolvedValueOnce(new Response(null, { status: 503 }));
		await f.events.alarm();
		await vi.advanceTimersByTimeAsync(2001);
		await new InteractionEventSubscriptions(f.storage, {} as CloudflareEnv, {
			authorize: f.authorize,
			send: f.send,
		}).alarm();
		expect(f.send.mock.calls[1]?.[3]).toBe(`evt_${RESPONSE}`);
		expect(f.send.mock.calls[2]?.[3]).toBe(`evt_${RESPONSE}`);
	});
	it.each([410, 413])(
		"does not retry terminal status %i or call it acknowledged",
		async (status) => {
			const f = fixture();
			await f.events.subscribe({ credential, params });
			await f.events.publish(publication);
			f.send.mockResolvedValueOnce(new Response(null, { status }));
			await f.events.alarm();
			await f.events.alarm();
			expect(f.send).toHaveBeenCalledTimes(2);
			expect(
				[...f.rows.values()].find((v) => (v as { outcome?: string }).outcome),
			).toMatchObject({ outcome: "failed" });
		},
	);
	it("unsubscribes only the authenticated owner's exact original event filter and callback", async () => {
		const f = fixture();
		await f.events.subscribe({ credential, params });
		f.authorize.mockResolvedValueOnce({
			owner: "other",
			expiresAt: Date.now() + 60_000,
		});
		const unsubscribeParams = {
			name: params.name,
			arguments: params.arguments,
			delivery: { mode: params.delivery.mode, url: params.delivery.url },
		};
		await f.events.unsubscribe({ credential, params: unsubscribeParams });
		expect(await f.events.publish(publication)).toBe(1);
		await f.events.unsubscribe({
			credential,
			params: unsubscribeParams,
		});
		expect(await f.events.publish(publication)).toBe(0);
	});
	it("expires subscription credentials and delivery receipts", async () => {
		vi.useFakeTimers();
		const f = fixture();
		await f.events.subscribe({ credential, params });
		await f.events.publish(publication);
		await vi.advanceTimersByTimeAsync(60_001);
		await f.events.alarm();
		expect(f.rows.size).toBe(0);
		expect(f.send).toHaveBeenCalledTimes(1);
	});
});
it("signs one exact body with both current and previous keys during rotation", async () => {
	const newSecret = `whsec_${btoa("y".repeat(32))}`;
	const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
		const headers = new Headers(init.headers);
		const signatures = headers.get("webhook-signature")!.split(" ");
		expect(signatures).toHaveLength(2);
		for (const [index, keyBytes] of [
			"y".repeat(32),
			"x".repeat(32),
		].entries()) {
			const key = await crypto.subtle.importKey(
				"raw",
				new TextEncoder().encode(keyBytes),
				{ name: "HMAC", hash: "SHA-256" },
				false,
				["verify"],
			);
			const signature = Uint8Array.from(
				atob(signatures[index]!.slice(3)),
				(character) => character.charCodeAt(0),
			);
			expect(
				await crypto.subtle.verify(
					"HMAC",
					key,
					signature,
					new TextEncoder().encode(
						`evt_rotate.${headers.get("webhook-timestamp")}.${init.body as string}`,
					),
				),
			).toBe(true);
		}
		return Response.json({});
	});
	vi.stubGlobal("fetch", fetchMock);
	await sendInteractionWebhook(
		"https://callback.example/events",
		newSecret,
		"sub_test",
		"evt_rotate",
		{ text: "é" },
		SECRET,
	);
	expect(fetchMock).toHaveBeenCalledTimes(1);
});
it("signs exact bytes and refuses redirects", async () => {
	const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
		const headers = new Headers(init.headers),
			body = init.body as string;
		const key = await crypto.subtle.importKey(
			"raw",
			new TextEncoder().encode("x".repeat(32)),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["verify"],
		);
		const signature = Uint8Array.from(
			atob(headers.get("webhook-signature")!.slice(3)),
			(c) => c.charCodeAt(0),
		);
		expect(
			await crypto.subtle.verify(
				"HMAC",
				key,
				signature,
				new TextEncoder().encode(
					`evt_test.${headers.get("webhook-timestamp")}.${body}`,
				),
			),
		).toBe(true);
		expect(headers.get("X-MCP-Subscription-Id")).toBe("sub_test");
		expect(init.redirect).toBe("manual");
		return new Response(null, {
			status: 302,
			headers: { Location: "https://private.example/redirect" },
		});
	});
	vi.stubGlobal("fetch", fetchMock);
	await expect(
		sendInteractionWebhook(
			"https://callback.example/events",
			SECRET,
			"sub_test",
			"evt_test",
			{ text: "é" },
		),
	).rejects.toThrow("Redirect limit exceeded");
	expect(fetchMock).toHaveBeenCalledTimes(1);
});
