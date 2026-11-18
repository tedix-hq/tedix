import type {
	ContentPublishStateChangeEvent,
	PluginContext,
} from "emdash/plugin";
import { describe, expect, it, vi } from "vite-plus/test";

import { deliveryFixture } from "./test-utils/publish-delivery";
import { DELIVERY_TASK } from "../templates/tedix/src/lib/publish-delivery";

import newsletter from "../templates/tedix/src/plugins/emdash-newsletter/index";
import tediBridge from "../templates/tedix/src/plugins/tedix-tedi-bridge/index";

vi.mock("cloudflare:workers", () => ({ env: { ORG_SLUG: "acme" } }));
vi.mock("emdash", () => ({
	getCollectionInfo: async () => ({ urlPattern: "/blog/{slug}" }),
}));

describe("tedix-tedi-bridge publish hook", () => {
	it("learns the published event.content item with grouped taxonomies", async () => {
		const requests: Array<{ input: string; init?: RequestInit }> = [];
		const termCalls: unknown[][] = [];
		const settings = new Map<string, unknown>([
			["settings:tedi.platformApiUrl", "https://platform.example/"],
			["settings:tedi.platformApiKey", "sk_test"],
			["settings:tedi.id", "tedi-1"],
			["settings:tedi.domain", "release-notes"],
			["settings:tedi.collections", "posts, updates"],
		]);
		const fixture = deliveryFixture();
		const ctx = {
			...fixture.ctx,
			http: {
				fetch: async (input: string, init?: RequestInit) => {
					requests.push({ input, init });
					return Response.json({ json: {} });
				},
			},
			kv: { get: async (key: string) => settings.get(key) },
			taxonomies: {
				getEntryTerms: async (...args: unknown[]) => {
					termCalls.push(args);
					return [
						{ taxonomy: "tag", slug: "mcp", label: "MCP" },
						{ taxonomy: "tag", slug: "agents", label: "Agents" },
						{ taxonomy: "category", slug: "product", label: "Product" },
					];
				},
			},
			log: { info: () => {}, warn: () => {} },
		} as unknown as PluginContext;
		const event = {
			collection: "updates",
			content: {
				id: "post-1",
				liveRevisionId: "revision-1",
				slug: "july-release",
				locale: "de",
				data: { title: "July release", excerpt: "Strong growth." },
			},
		} as unknown as ContentPublishStateChangeEvent;

		await tediBridge.hooks["content:afterPublish"].handler(event, ctx);
		expect(requests).toHaveLength(0);
		await tediBridge.hooks.cron.handler(
			{ name: DELIVERY_TASK, scheduledAt: new Date().toISOString() },
			ctx,
		);

		expect(termCalls).toEqual([["updates", "post-1", { locale: "de" }]]);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.input).toBe(
			"https://platform.example/rpc/memory/learn",
		);
		const headers = new Headers(requests[0]?.init?.headers);
		expect(headers.get("Authorization")).toBe("Bearer sk_test");
		const wireBody = JSON.parse(String(requests[0]?.init?.body));
		expect(wireBody.json).toMatchObject({
			content:
				'Published article: "July release" (slug: july-release). Strong growth. Taxonomies: tag: MCP, Agents; category: Product.',
			domain: "release-notes",
			source: "cms://updates/july-release",
			tediId: "tedi-1",
		});
	});
});

describe("emdash-newsletter digest hook", () => {
	it("renders the digest from the published event.content item", async () => {
		const settings = new Map<string, unknown>([
			["settings:newsletter.platformApiKey", "sk_test"],
			["settings:newsletter.platformApiUrl", "https://platform.example"],
		]);
		const bodies: Array<{ json: Record<string, unknown> }> = [];
		const fixture = deliveryFixture();
		const ctx = {
			...fixture.ctx,
			kv: { get: async (key: string) => settings.get(key) },
			storage: {
				deliveries: fixture.deliveries,
				subscribers: {
					get: async () => ({ email: "reader@example.com", status: "active" }),
					query: async () => ({
						items: [
							{
								id: "sub_1",
								data: { email: "reader@example.com", unsubscribeToken: "u1" },
							},
						],
						hasMore: false,
					}),
				},
			},
			http: {
				fetch: async (_url: string, init?: RequestInit) => {
					bodies.push(JSON.parse(String(init?.body)));
					return Response.json({ json: { ok: true } });
				},
			},
			site: { name: "Acme", url: "https://acme.example" },
			url: (path: string) => `https://acme.example${path}`,
			log: { info: () => {}, warn: () => {} },
		} as unknown as PluginContext;
		const event = {
			collection: "posts",
			content: {
				id: "post-1",
				liveRevisionId: "revision-1",
				slug: "launch-day",
				data: { title: "Launch day", excerpt: "We shipped." },
			},
		} as unknown as ContentPublishStateChangeEvent;

		await newsletter.hooks["content:afterPublish"].handler(event, ctx);
		expect(bodies).toHaveLength(0);
		const tick = { name: DELIVERY_TASK, scheduledAt: new Date().toISOString() };
		await newsletter.hooks.cron.handler(tick, ctx);
		expect(bodies).toHaveLength(0);
		await newsletter.hooks.cron.handler(tick, ctx);

		expect(bodies).toHaveLength(1);
		expect(bodies[0]?.json).toMatchObject({
			appSlug: "acme",
			subject: "New on Acme: Launch day",
			to: [{ email: "reader@example.com" }],
		});
		expect(String(bodies[0]?.json.text)).toContain(
			"Read more: https://acme.example/blog/launch-day",
		);
	});
});

describe("newsletter durable fan-out", () => {
	it("checkpoints subscriber pages, retries one failed recipient and honors unsubscribe before retry", async () => {
		vi.useFakeTimers();
		try {
			const fixture = deliveryFixture();
			const subscribers = new Map([
				[
					"s1",
					{
						email: "one@example.com",
						status: "active",
						unsubscribeToken: "u1",
					},
				],
				[
					"s2",
					{
						email: "two@example.com",
						status: "active",
						unsubscribeToken: "u2",
					},
				],
			]);
			const query = vi.fn(async (options: { cursor?: string }) => ({
				items: options.cursor
					? [{ id: "s2", data: subscribers.get("s2") }]
					: [{ id: "s1", data: subscribers.get("s1") }],
				hasMore: !options.cursor,
				cursor: options.cursor ? undefined : "page2",
			}));
			const sends: string[] = [];
			const ctx = {
				...fixture.ctx,
				kv: {
					get: async (key: string) =>
						key === "settings:newsletter.platformApiKey"
							? "sk_test"
							: undefined,
				},
				storage: {
					deliveries: fixture.deliveries,
					subscribers: {
						query,
						get: async (id: string) => subscribers.get(id),
					},
				},
				http: {
					fetch: async (_url: string, init?: RequestInit) => {
						const input = JSON.parse(String(init?.body)).json;
						const recipient = input.to[0].email;
						sends.push(recipient);
						if (recipient === "two@example.com")
							return Response.json({ json: { ok: false } });
						return Response.json({ json: { ok: true, messageId: "email-1" } });
					},
				},
				url: (path: string) => `https://acme.example${path}`,
				log: { warn: vi.fn() },
			} as unknown as PluginContext;
			const event = {
				collection: "posts",
				content: {
					id: "post-1",
					liveRevisionId: "live-1",
					data: { title: "Publication" },
				},
			};
			const tick = {
				name: DELIVERY_TASK,
				scheduledAt: new Date().toISOString(),
			};
			await newsletter.hooks["content:afterPublish"].handler(event, ctx);
			await newsletter.hooks["content:afterPublish"].handler(event, ctx);
			expect(fixture.rows.size).toBe(1);
			expect(query).not.toHaveBeenCalled();
			await newsletter.hooks.cron.handler(tick, ctx);
			expect(query).toHaveBeenCalledTimes(1);
			expect(sends).toEqual([]);
			await newsletter.hooks.cron.handler(tick, ctx);
			expect(query.mock.calls[1]?.[0].cursor).toBe("page2");
			await newsletter.hooks.cron.handler(tick, ctx);
			expect(sends).toEqual(["one@example.com", "two@example.com"]);
			const failed = [...fixture.rows.values()].find(
				(row) => row.value.recipient === "two@example.com",
			);
			expect(failed?.value).toMatchObject({ status: "failed", attempts: 1 });
			subscribers.get("s2")!.status = "unsubscribed";
			vi.advanceTimersByTime(60_000);
			await newsletter.hooks.cron.handler(tick, ctx);
			expect(sends).toEqual(["one@example.com", "two@example.com"]);
			expect(
				[...fixture.rows.values()].find(
					(row) => row.value.recipient === "two@example.com",
				)?.value.status,
			).toBe("skipped");
		} finally {
			vi.useRealTimers();
		}
	});
	it("keeps publication successful when durable enqueue is unavailable", async () => {
		const fixture = deliveryFixture();
		fixture.deliveries.compareAndSet.mockRejectedValue(
			new Error("storage unavailable"),
		);
		const warn = vi.fn();
		const ctx = {
			...fixture.ctx,
			kv: { get: async () => undefined },
			log: { warn },
			url: (path: string) => `https://acme.example${path}`,
		} as unknown as PluginContext;
		const event = {
			collection: "posts",
			content: { id: "post-1", liveRevisionId: "live-1" },
		};
		await expect(
			newsletter.hooks["content:afterPublish"].handler(event, ctx),
		).resolves.toBeUndefined();
		await expect(
			tediBridge.hooks["content:afterPublish"].handler(event, ctx),
		).resolves.toBeUndefined();
		expect(warn).toHaveBeenCalledTimes(2);
	});
});
