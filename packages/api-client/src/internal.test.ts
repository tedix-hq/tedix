import { os, ORPCError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { describe, expect, it, vi } from "vite-plus/test";
import { callRpc, getInternalApiClient, serviceBindingFetch } from "./internal";

describe("getInternalApiClient", () => {
	it("uses the service binding, canonical headers, and typed procedure path", async () => {
		const serviceFetch = {
			fetch: vi.fn(async (input: Request) => {
				expect(input.url).toBe("https://api/rpc/apps/get");
				expect(input.method).toBe("POST");
				const headers = input.headers;
				expect(headers.get("X-Service-Binding")).toBe("true");
				expect(headers.get("X-Tedix-Org-Id")).toBe("org-1");
				expect(headers.get("X-Tedix-Tedi-Id")).toBe("tedi-1");
				expect(headers.get("X-Tedix-Caller")).toBe("test-runtime");
				expect(headers.get("X-Tedix-Tedi-Scopes")).toBe("apps:read tedis:read");
				expect(await input.json()).toEqual({
					json: { appId: "00000000-0000-4000-8000-000000000001" },
				});
				return Response.json({ json: { id: "app-1", slug: "test" } });
			}),
		};
		const client = getInternalApiClient(
			{ API_SERVICE: serviceFetch },
			{
				organizationId: "org-1",
				tediId: "tedi-1",
				caller: "test-runtime",
				scopes: ["apps:read", "tedis:read", "apps:read"],
			},
		);

		const result = await client.apps.get({
			appId: "00000000-0000-4000-8000-000000000001",
		});

		expect(result).toEqual({ id: "app-1", slug: "test" });
		expect(serviceFetch.fetch).toHaveBeenCalledOnce();
	});

	it("fails closed when a service binding is unavailable", () => {
		expect(() => getInternalApiClient({})).toThrow(
			"API_SERVICE binding is required",
		);
	});
});

describe("callRpc", () => {
	it("delegates a runtime-selected path to the official oRPC link", async () => {
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(input)).toBe(
					"https://api.tedix.dev/rpc/cognitiveRuntime/recordEvent",
				);
				expect(new Headers(init?.headers).get("X-API-Key")).toBe("sk_test");
				expect(JSON.parse(String(init?.body))).toEqual({
					json: { id: "event-1" },
				});
				return Response.json({ json: { recorded: true } });
			},
		);

		const result = await callRpc<{ recorded: boolean }>(
			"cognitiveRuntime/recordEvent",
			{ id: "event-1" },
			{
				apiUrl: "https://api.tedix.dev/",
				fetch: fetchMock as typeof fetch,
				headers: { "X-API-Key": "sk_test" },
			},
		);

		expect(result).toEqual({ recorded: true });
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("rejects empty procedure paths before transport", async () => {
		await expect(
			callRpc("", {}, { apiUrl: "https://api.tedix.dev" }),
		).rejects.toThrow("must not be empty");
	});

	it("does not retry writes unless the caller explicitly opts in", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json(
				{ json: { message: "unavailable" } },
				{ status: 503, statusText: "Service Unavailable" },
			),
		);

		await expect(
			callRpc(
				"memory/learn",
				{ content: "fact" },
				{
					apiUrl: "https://api.tedix.dev",
					fetch: fetchMock as typeof fetch,
				},
			),
		).rejects.toMatchObject({
			name: "RpcCallError",
			path: "memory/learn",
			status: 503,
		});
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("supports an explicit retry for idempotent calls", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				Response.json({ json: { message: "unavailable" } }, { status: 503 }),
			)
			.mockResolvedValueOnce(Response.json({ json: { ok: true } }));

		await expect(
			callRpc<{ ok: boolean }>(
				"health/check",
				{},
				{
					apiUrl: "https://api.tedix.dev",
					fetch: fetchMock as typeof fetch,
					retry: 1,
					retryDelayMs: 0,
				},
			),
		).resolves.toEqual({ ok: true });
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("honors an already-aborted caller signal when a timeout is configured", async () => {
		const caller = new AbortController();
		caller.abort(new Error("caller stopped"));
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				if (init?.signal?.aborted) throw init.signal.reason;
				return Response.json({ json: { ok: true } });
			},
		);

		await expect(
			callRpc(
				"health/check",
				{},
				{
					apiUrl: "https://api.tedix.dev",
					fetch: fetchMock as typeof fetch,
					signal: caller.signal,
					timeoutMs: 10_000,
				},
			),
		).rejects.toThrow("caller stopped");
	});
});

describe("official RPCHandler wire responses", () => {
	it.each(["typed", "dynamic"] as const)(
		"decodes JSON, errors and event streams through %s calls",
		async (mode) => {
			const observed: Array<{ status: number; contentType: string | null }> =
				[];
			const handler = new RPCHandler({
				apps: {
					get: os.handler(() => ({ id: "app-1" })),
					fail: os.handler(() => {
						throw new ORPCError("BAD_REQUEST", { message: "wire failure" });
					}),
					stream: os.handler(async function* () {
						yield { id: 1 };
						yield { id: 2 };
					}),
				},
			});
			// Route every scenario through the statically typed apps.get client too.
			let selected = "get";
			const service = {
				fetch: async (request: Request) => {
					const url = new URL(request.url);
					url.pathname = `/rpc/apps/${selected}`;
					const { response } = await handler.handle(new Request(url, request), {
						prefix: "/rpc",
					});
					if (!response) throw new Error("Unmatched fixture procedure");
					observed.push({
						status: response.status,
						contentType: response.headers.get("content-type"),
					});
					return response;
				},
			};
			const client = getInternalApiClient({ API_SERVICE: service });
			const invoke = (): Promise<unknown> =>
				mode === "typed"
					? client.apps.get({ appId: "00000000-0000-4000-8000-000000000001" })
					: callRpc(
							"apps/get",
							{},
							{ apiUrl: "https://api", fetch: serviceBindingFetch(service) },
						);
			expect(await invoke()).toEqual({ id: "app-1" });
			selected = "fail";
			await expect(invoke()).rejects.toThrow("wire failure");
			selected = "stream";
			const chunks = [];
			for await (const chunk of (await invoke()) as AsyncIterable<unknown>)
				chunks.push(chunk);
			expect(chunks).toEqual([{ id: 1 }, { id: 2 }]);
			expect(observed).toEqual([
				{ status: 200, contentType: "application/json" },
				{ status: 400, contentType: "application/json" },
				{ status: 200, contentType: "text/event-stream" },
			]);
		},
	);
});
