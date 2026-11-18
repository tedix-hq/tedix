import type {
	ContentPublishStateChangeEvent,
	PluginContext,
} from "emdash/plugin";
import { describe, expect, it, vi } from "vite-plus/test";

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
		const ctx = {
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
				slug: "july-release",
				locale: "de",
				data: { title: "July release", excerpt: "Strong growth." },
			},
		} as unknown as ContentPublishStateChangeEvent;

		await tediBridge.hooks["content:afterPublish"].handler(event, ctx);

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
		const ctx = {
			kv: { get: async (key: string) => settings.get(key) },
			storage: {
				subscribers: {
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
				slug: "launch-day",
				data: { title: "Launch day", excerpt: "We shipped." },
			},
		} as unknown as ContentPublishStateChangeEvent;

		await newsletter.hooks["content:afterPublish"].handler(event, ctx);

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
