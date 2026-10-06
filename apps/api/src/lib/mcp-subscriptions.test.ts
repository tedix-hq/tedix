import { describe, expect, it } from "vite-plus/test";
import {
	purgeMcpAggregateCache,
	publishMcpCatalogInventoryEvents,
	publishMcpListChangedEvents,
	publishMcpListChangedEventsSoon,
	publishMcpSubscriptionEvent,
	publishMcpSubscriptionEventSoon,
	publishMcpInteractionResponse,
} from "./mcp-subscriptions";

describe("publishMcpInteractionResponse", () => {
	const input = {
		organizationId: "00000000-0000-4000-8000-000000000001",
		requestId: "00000000-0000-4000-8000-000000000002",
		responseId: "00000000-0000-4000-8000-000000000003",
		respondedAt: "2026-10-05T00:00:00.000Z",
	};

	it("publishes only exact receipt IDs over the trusted binding", async () => {
		let received: Request | undefined;
		const env = makeEnv(async (request) => {
			received = request;
			return Response.json({ ok: true, delivered: 0 });
		});
		const withPrivateFields = {
			...input,
			body: "private answer",
			metadata: { secret: "private" },
		};
		expect(await publishMcpInteractionResponse(env, withPrivateFields)).toBe(
			"accepted",
		);
		expect(received?.url).toBe("https://mcp/__internal/subscriptions/publish");
		expect(received?.headers.get("X-Service-Binding")).toBe("true");
		expect(await received?.json()).toEqual({
			kind: "interaction_response",
			...input,
		});
	});

	it("keeps committed replies successful when the publisher fails", async () => {
		for (const env of [
			{ MCP_SERVICE: undefined } as unknown as CloudflareEnv,
			makeEnv(async () => {
				throw new Error("private provider detail");
			}),
			makeEnv(async () => Response.json({ ok: false }, { status: 503 })),
			makeEnv(async () => Response.json({ ok: false })),
		]) {
			expect(await publishMcpInteractionResponse(env, input)).toBe(
				"unavailable",
			);
		}
	});

	it("bounds an unresponsive binding even if it ignores abort", async () => {
		const env = makeEnv(() => new Promise<Response>(() => {}));
		expect(
			await publishMcpInteractionResponse(env, input, { timeoutMs: 1 }),
		).toBe("unavailable");
	});
});

describe("purgeMcpAggregateCache", () => {
	it("uses the service-binding-only aggregate invalidation route", async () => {
		const requests: Array<{ url: string; headers: Headers; body: unknown }> =
			[];
		const env = makeEnv(async (request) => {
			requests.push({
				url: request.url,
				headers: request.headers,
				body: await request.json(),
			});
			return Response.json({ ok: true, r2Deleted: 1 });
		});

		await purgeMcpAggregateCache(env, "tenant-catalog-install");

		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({
			url: "https://mcp/__internal/purge-aggregate-cache",
			body: { reason: "tenant-catalog-install" },
		});
		expect(requests[0].headers.get("X-Service-Binding")).toBe("true");
	});

	it("is non-fatal when the MCP binding is unavailable", async () => {
		await expect(
			purgeMcpAggregateCache(
				{ MCP_SERVICE: undefined } as unknown as CloudflareEnv,
				"tenant-catalog-install",
			),
		).resolves.toBeUndefined();
	});
});

function makeEnv(
	fetchImpl?: (req: Request) => Promise<Response>,
): CloudflareEnv {
	return {
		MCP_SERVICE: fetchImpl
			? { fetch: fetchImpl }
			: {
					fetch: async () => Response.json({ ok: true }),
				},
	} as unknown as CloudflareEnv;
}

describe("publishMcpSubscriptionEvent", () => {
	it("posts to the internal publish endpoint with correct body", async () => {
		const requests: { url: string; body: unknown; headers: Headers }[] = [];
		const env = makeEnv(async (req) => {
			requests.push({
				url: req.url,
				body: await req.json(),
				headers: req.headers,
			});
			return new Response(null, { status: 200 });
		});

		await publishMcpSubscriptionEvent(env, {
			appId: "app-1",
			organizationId: "org-1",
			method: "notifications/tools/list_changed",
		});

		expect(requests).toHaveLength(1);
		expect(requests[0].url).toBe(
			"https://mcp/__internal/subscriptions/publish",
		);
		expect(requests[0].headers.get("X-Service-Binding")).toBe("true");
		expect(requests[0].body).toMatchObject({
			appId: "app-1",
			organizationId: "org-1",
			method: "notifications/tools/list_changed",
		});
	});

	it("returns without throwing when MCP_SERVICE is absent", async () => {
		const envWithNoService = {
			MCP_SERVICE: undefined,
		} as unknown as CloudflareEnv;

		await expect(
			publishMcpSubscriptionEvent(envWithNoService, {
				organizationId: "org-1",
				method: "notifications/tools/list_changed",
			}),
		).resolves.toBeUndefined();
	});

	it("swallows fetch failures without throwing", async () => {
		const env = makeEnv(async () => {
			throw new Error("network failure");
		});

		await expect(
			publishMcpSubscriptionEvent(env, {
				organizationId: "org-1",
				method: "notifications/tools/list_changed",
			}),
		).resolves.toBeUndefined();
	});

	it("swallows non-ok responses without throwing", async () => {
		const env = makeEnv(async () => new Response(null, { status: 503 }));

		await expect(
			publishMcpSubscriptionEvent(env, {
				organizationId: "org-1",
				method: "notifications/tools/list_changed",
			}),
		).resolves.toBeUndefined();
	});

	it("forwards taskId and state for task notifications", async () => {
		const requests: unknown[] = [];
		const env = makeEnv(async (req) => {
			requests.push(await req.json());
			return new Response(null, { status: 200 });
		});

		await publishMcpSubscriptionEvent(env, {
			organizationId: "org-1",
			method: "notifications/tasks",
			taskId: "task-123",
			state: { status: "completed", result: { ok: true } },
		});

		expect(requests[0]).toMatchObject({
			organizationId: "org-1",
			method: "notifications/tasks",
			taskId: "task-123",
			state: { status: "completed", result: { ok: true } },
		});
	});
});

describe("publishMcpSubscriptionEventSoon", () => {
	it("passes the publish promise to waitUntil", () => {
		const captured: Promise<unknown>[] = [];
		const waitUntil = (p: Promise<unknown>) => {
			captured.push(p);
		};

		const env = makeEnv(async () => new Response(null, { status: 200 }));

		publishMcpSubscriptionEventSoon(waitUntil, env, {
			organizationId: "org-1",
			method: "notifications/tools/list_changed",
		});

		expect(captured).toHaveLength(1);
		expect(captured[0]).toBeInstanceOf(Promise);
	});

	it("works without a waitUntil function", () => {
		const env = makeEnv(async () => new Response(null, { status: 200 }));

		expect(() =>
			publishMcpSubscriptionEventSoon(undefined, env, {
				organizationId: "org-1",
				method: "notifications/tools/list_changed",
			}),
		).not.toThrow();
	});
});

describe("publishMcpListChangedEvents", () => {
	it("publishes one event per method with the shared target", async () => {
		const published: Array<{ appId?: string; method: string }> = [];
		const env = makeEnv(async (req) => {
			const body = (await req.json()) as { appId?: string; method?: string };
			if (req.url.endsWith("/subscriptions/publish")) {
				published.push(body as { appId?: string; method: string });
			}
			return Response.json({ ok: true });
		});

		await publishMcpListChangedEvents(env, { appId: "app-1" }, [
			"notifications/tools/list_changed",
			"notifications/resources/list_changed",
		]);

		expect(published).toEqual([
			{ appId: "app-1", method: "notifications/tools/list_changed" },
			{ appId: "app-1", method: "notifications/resources/list_changed" },
		]);
	});

	it("invalidates aggregate and exact app caches before notifying", async () => {
		const requests: Array<{ url: string; body: unknown }> = [];
		const env = makeEnv(async (req) => {
			requests.push({ url: req.url, body: await req.json() });
			return Response.json({ ok: true });
		});

		await publishMcpListChangedEvents(
			env,
			{
				appId: "app-1",
				organizationId: "org-1",
				appResolutionKeys: ["mcp-subdomain:alpha", "custom:mcp.example.com"],
			},
			["notifications/tools/list_changed"],
		);

		expect(requests.map(({ url }) => url)).toEqual([
			"https://mcp/__internal/purge-discovery-cache",
			"https://mcp/__internal/purge-aggregate-cache",
			"https://mcp/__internal/subscriptions/publish",
		]);
		expect(requests[0]?.body).toEqual({
			appId: "app-1",
			appResolutionKeys: ["mcp-subdomain:alpha", "custom:mcp.example.com"],
		});
	});

	it("does not send a misleading notification when invalidation fails", async () => {
		const urls: string[] = [];
		const env = makeEnv(async (req) => {
			urls.push(req.url);
			return Response.json({ ok: false });
		});

		await publishMcpListChangedEvents(
			env,
			{ appId: "app-1", appResolutionKeys: ["mcp-subdomain:alpha"] },
			["notifications/tools/list_changed"],
		);

		expect(urls).toEqual(["https://mcp/__internal/purge-discovery-cache"]);
	});

	it("no-ops when MCP_SERVICE is absent", async () => {
		const envWithNoService = {
			MCP_SERVICE: undefined,
		} as unknown as CloudflareEnv;

		await expect(
			publishMcpListChangedEvents(envWithNoService, { appId: "app-1" }, [
				"notifications/tools/list_changed",
			]),
		).resolves.toBeUndefined();
	});
});

describe("publishMcpListChangedEventsSoon", () => {
	it("hands one publish promise per method to waitUntil", () => {
		const captured: Promise<unknown>[] = [];
		const env = makeEnv(async () => Response.json({ ok: true }));

		publishMcpListChangedEventsSoon(
			(promise) => {
				captured.push(promise);
			},
			env,
			{ appIds: ["app-1", "app-2"] },
			[
				"notifications/tools/list_changed",
				"notifications/prompts/list_changed",
				"notifications/resources/list_changed",
			],
		);

		expect(captured).toHaveLength(1);
		return captured[0];
	});
});

describe("publishMcpCatalogInventoryEvents", () => {
	it("publishes resource and prompt events for every app sharing the catalog", async () => {
		const published: unknown[] = [];
		const env = makeEnv(async (req) => {
			published.push(await req.json());
			return new Response(null, { status: 200 });
		});

		const db = {
			select: () => ({
				from: () => ({
					where: async () => [
						{ id: "app-a", organizationId: "org-1" },
						{ id: "app-b", organizationId: "org-2" },
					],
				}),
			}),
		};

		await publishMcpCatalogInventoryEvents({
			db: db as never,
			env,
			catalogAppId: "catalog-1",
			resourceListChanged: true,
			promptListChanged: true,
		});

		const methods = (published as Array<{ method: string }>).map(
			(p) => p.method,
		);
		expect(methods).toEqual([
			"notifications/resources/list_changed",
			"notifications/prompts/list_changed",
			"notifications/resources/list_changed",
			"notifications/prompts/list_changed",
		]);

		const appIds = (published as Array<{ appId: string }>).map((p) => p.appId);
		expect(appIds).toEqual(["app-a", "app-a", "app-b", "app-b"]);
	});

	it("skips publishing when no apps share the catalog", async () => {
		const published: unknown[] = [];
		const env = makeEnv(async (req) => {
			published.push(await req.json());
			return new Response(null, { status: 200 });
		});

		const db = {
			select: () => ({
				from: () => ({
					where: async () => [],
				}),
			}),
		};

		await publishMcpCatalogInventoryEvents({
			db: db as never,
			env,
			catalogAppId: "catalog-empty",
			resourceListChanged: true,
		});

		expect(published).toHaveLength(0);
	});

	it("skips publishing when no change flags are set", async () => {
		const published: unknown[] = [];
		const env = makeEnv(async (req) => {
			published.push(await req.json());
			return new Response(null, { status: 200 });
		});

		const db = {
			select: () => ({
				from: () => ({
					where: async () => [{ id: "app-a", organizationId: "org-1" }],
				}),
			}),
		};

		await publishMcpCatalogInventoryEvents({
			db: db as never,
			env,
			catalogAppId: "catalog-1",
		});

		expect(published).toHaveLength(0);
	});
});
