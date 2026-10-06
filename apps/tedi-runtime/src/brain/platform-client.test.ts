import { afterEach, describe, expect, it, vi } from "bun:test";
import { HttpPlatformClient } from "./platform-client";

describe("HttpPlatformClient", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it("uses the shared access-key exchange and reuses its cached JWT", async () => {
		const jwt = [
			"eyJhbGciOiJub25lIn0",
			btoa(
				JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 900 }),
			).replace(/=/g, ""),
			"signature",
		].join(".");
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith("/v1/auth/accesskey/exchange")) {
					return new Response(JSON.stringify({ sessionJwt: jwt }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				expect(new Headers(init?.headers).get("Authorization")).toBe(
					`Bearer ${jwt}`,
				);
				return new Response(JSON.stringify({ json: { entries: [] } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			},
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		const client = new HttpPlatformClient({
			apiBaseUrl: "https://api.tedix.dev",
			descopeAccessKey: "ak_test",
			descopeProjectId: "P123",
			tediId: "tedi-1",
		});

		await client.findSkills("first");
		await client.findSkills("second");
		await client
			.forRequest({
				signal: new AbortController().signal,
				traceId: "learning-run",
			})
			.findSkills("third");

		expect(
			fetchMock.mock.calls.filter(([input]) =>
				String(input).endsWith("/v1/auth/accesskey/exchange"),
			),
		).toHaveLength(1);
	});

	it("threads org and tedi identity through service-bound API calls", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ json: { entries: [] } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const client = new HttpPlatformClient({
			apiBaseUrl: "http://127.0.0.1:8787",
			apiAuthMode: "service-binding",
			tediId: "tedi-1",
			organizationId: "org-1",
			serviceBindingScopes: ["tedis:read", "tedis:write", "billing:read"],
		});

		await client.findSkills("cron");

		expect(fetchMock).toHaveBeenCalledOnce();
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("http://127.0.0.1:8787/rpc/skills/find");
		const headers = new Headers(init.headers);
		expect(headers.get("X-Service-Binding")).toBe("true");
		expect(headers.get("X-Tedix-Org-Id")).toBe("org-1");
		expect(headers.get("X-Tedix-Tedi-Id")).toBe("tedi-1");
		expect(headers.get("X-Tedix-Tedi-Scopes")).toBe(
			"tedis:read tedis:write billing:read",
		);
	});

	it("routes RPC over the injected service-binding fetcher (not global fetch)", async () => {
		// Global fetch must NOT be used when a binding fetcher is supplied — the
		// public edge strips the binding marker and apps/api would reject the
		// call as a non-service-binding caller.
		const globalFetchMock = vi.fn(async () => new Response("nope"));
		globalThis.fetch = globalFetchMock as unknown as typeof fetch;

		const bindingFetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ json: { factId: "f-1" } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);

		const client = new HttpPlatformClient({
			apiBaseUrl: "https://api.tedix.dev",
			apiAuthMode: "service-binding",
			fetch: bindingFetch as unknown as typeof fetch,
			tediId: "tedi-1",
			organizationId: "org-1",
		});

		await client.memoryLearn({
			summary: "fact summary",
			content: "fact body",
			factType: "observation",
			confidence: 0.9,
		});

		expect(globalFetchMock).not.toHaveBeenCalled();
		expect(bindingFetch).toHaveBeenCalledTimes(1);

		const [url, init] = bindingFetch.mock.calls[0] as [
			string,
			{ headers: Record<string, string>; body: string },
		];
		expect(url).toBe("https://api.tedix.dev/rpc/memoryGraph/learn");
		const headers = new Headers(init.headers);
		expect(headers.get("X-Service-Binding")).toBe("true");
		expect(headers.get("X-Tedix-Tedi-Id")).toBe("tedi-1");
		expect(headers.get("X-Tedix-Org-Id")).toBe("org-1");
		// No Descope bearer on the service-binding path.
		expect(init.headers).not.toHaveProperty("Authorization");
		// tedi identity also travels in the payload so apps/api attributes the
		// write from input.tediId (org-scoped) on the service-binding path.
		expect(JSON.parse(init.body)).toMatchObject({
			json: { tediId: "tedi-1", content: "fact body" },
		});
	});

	it("can write an org-scoped memory fact without tedi attribution", async () => {
		const bindingFetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ json: { factId: "f-org" } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);

		const client = new HttpPlatformClient({
			apiBaseUrl: "https://api.tedix.dev",
			apiAuthMode: "service-binding",
			fetch: bindingFetch as unknown as typeof fetch,
			tediId: "tedi-1",
			organizationId: "org-1",
		});

		await client.memoryLearn({
			summary: "Firecrawl credential is connected",
			content: "Firecrawl credential validation succeeded for acme.",
			factType: "technical",
			confidence: 0.9,
			memoryScope: "org",
			topicKey: "org:acme.connector.firecrawl.credential_state",
			reviewStatus: "confirmed",
		});

		const [, init] = bindingFetch.mock.calls[0] as [string, { body: string }];
		expect(JSON.parse(init.body)).toMatchObject({
			json: {
				content: "Firecrawl credential validation succeeded for acme.",
				memoryScope: "org",
				reviewStatus: "confirmed",
				topicKey: "org:acme.connector.firecrawl.credential_state",
			},
		});
		expect(JSON.parse(init.body).json).not.toHaveProperty("tediId");
	});

	it("threads tedi readability through id-addressed skill reads", async () => {
		const bindingFetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ json: { entry: null } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);
		const client = new HttpPlatformClient({
			apiBaseUrl: "https://api.tedix.dev",
			apiAuthMode: "service-binding",
			fetch: bindingFetch as unknown as typeof fetch,
			tediId: "tedi-1",
			organizationId: "org-1",
		});

		await client.getSkillForMcp({ id: "skill-1" });

		const [, init] = bindingFetch.mock.calls[0] as [string, { body: string }];
		expect(JSON.parse(init.body).json).toEqual({
			id: "skill-1",
			tediId: "tedi-1",
		});
	});

	it("threads tedi ownership through id-addressed artifact reads", async () => {
		const bindingFetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						json: {
							artifact: {
								id: "artifact-1",
								tediId: "tedi-1",
								kind: "document",
								name: "brief.md",
								createdAt: "2026-08-08T00:00:00.000Z",
							},
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		);
		const client = new HttpPlatformClient({
			apiBaseUrl: "https://api.tedix.dev",
			apiAuthMode: "service-binding",
			fetch: bindingFetch as unknown as typeof fetch,
			tediId: "tedi-1",
			organizationId: "org-1",
		});

		await client.getArtifact({ artifactId: "artifact-1" });

		const [url, init] = bindingFetch.mock.calls[0] as [
			string,
			{ body: string },
		];
		expect(url).toBe("https://api.tedix.dev/rpc/cognitiveRuntime/getArtifact");
		expect(JSON.parse(init.body).json).toEqual({
			tediId: "tedi-1",
			artifactId: "artifact-1",
		});
	});

	it("forwards rationale idempotency and terminal episode fields", async () => {
		const bindingFetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ json: { id: "rationale-1" } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);
		const client = new HttpPlatformClient({
			apiBaseUrl: "https://api.tedix.dev",
			apiAuthMode: "service-binding",
			fetch: bindingFetch as unknown as typeof fetch,
			tediId: "tedi-1",
			organizationId: "org-1",
		});

		await client.createRationaleRecord({
			idempotencyKey: "turn-episode:abc",
			action: "Cron health read completed",
			rationale: "All schedules returned terminal health",
			runId: "run-1",
			outcomeStatus: "partial",
			outcome: "Runtime settled; business impact not measured",
		});

		const [url, init] = bindingFetch.mock.calls[0] as [
			string,
			{ body: string },
		];
		expect(url).toBe("https://api.tedix.dev/rpc/rationaleRecords/create");
		expect(JSON.parse(init.body).json).toMatchObject({
			idempotencyKey: "turn-episode:abc",
			runId: "run-1",
			outcomeStatus: "partial",
			outcome: "Runtime settled; business impact not measured",
		});
	});

	it("routes exact tedi Work approval inbox and decision calls", async () => {
		const bindingFetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ json: { data: [], hasMore: false } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);
		const client = new HttpPlatformClient({
			apiBaseUrl: "https://api.tedix.dev",
			apiAuthMode: "service-binding",
			fetch: bindingFetch as unknown as typeof fetch,
			tediId: "tedi-approver",
			organizationId: "org-1",
			serviceBindingScopes: ["mcp:messaging.read", "mcp:messaging.write"],
		});

		await client.listWorkApprovalInbox({ limit: 20 });
		await client.decideWorkApproval({
			proposalId: "5eed0010-0000-4000-8000-000000000010",
			expectedProposalVersion: 1,
			decision: "approved",
			rationale: "Independent exact-version review passed.",
		});

		expect(bindingFetch).toHaveBeenCalledTimes(2);
		const [inboxUrl, inboxInit] = bindingFetch.mock.calls[0] as [
			string,
			{ body: string; headers: Record<string, string> },
		];
		expect(inboxUrl).toBe("https://api.tedix.dev/rpc/workApprovals/listInbox");
		expect(JSON.parse(inboxInit.body)).toEqual({ json: { limit: 20 } });
		expect(new Headers(inboxInit.headers).get("X-Tedix-Tedi-Id")).toBe(
			"tedi-approver",
		);
		const [decisionUrl, decisionInit] = bindingFetch.mock.calls[1] as [
			string,
			{ body: string },
		];
		expect(decisionUrl).toBe("https://api.tedix.dev/rpc/workApprovals/decide");
		expect(JSON.parse(decisionInit.body)).toEqual({
			json: {
				proposalId: "5eed0010-0000-4000-8000-000000000010",
				expectedProposalVersion: 1,
				decision: "approved",
				rationale: "Independent exact-version review passed.",
			},
		});
	});
});

it("isolates a canceled learning request from the cached platform client", async () => {
	const controller = new AbortController();
	const seen: string[] = [];
	let started!: () => void;
	const requestStarted = new Promise<void>((resolve) => {
		started = resolve;
	});
	const client = new HttpPlatformClient({
		apiBaseUrl: "https://api.tedix.dev",
		apiAuthMode: "service-binding",
		tediId: "tedi-1",
		fetch: (async (_input: unknown, init?: RequestInit) => {
			const trace = new Headers(init?.headers).get("X-Trace-Id") ?? "none";
			seen.push(trace);
			if (trace === "learning-run") {
				started();
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener(
						"abort",
						() => reject(init.signal?.reason),
						{ once: true },
					);
				});
			}
			return new Response(JSON.stringify({ json: { entries: [] } }), {
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch,
	});
	const scoped = client.forRequest({
		signal: controller.signal,
		traceId: "learning-run",
	});
	const pending = scoped.findSkills("first stage");
	await requestStarted;
	controller.abort(new Error("learning deadline"));
	await expect(pending).rejects.toThrow();
	await expect(scoped.findSkills("later stage")).rejects.toThrow(
		"learning deadline",
	);
	await client.findSkills("unrelated foreground request");
	expect(seen).toEqual(["learning-run", "none"]);
});

it("forwards runtime skill IDs with service-bound tedi and run attribution", async () => {
	const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
		expect(new Headers(init?.headers).get("X-Tedix-Tedi-Id")).toBe("tedi-1");
		expect(new Headers(init?.headers).get("X-Tedix-Org-Id")).toBe("org-1");
		expect(String(init?.body)).toContain('"runId":"run-1"');
		return new Response(
			JSON.stringify({
				json: {
					skillIds: null,
					executionAttempts: [],
					usagePersistence: "not_dispatched",
				},
			}),
			{ headers: { "Content-Type": "application/json" } },
		);
	});
	const client = new HttpPlatformClient({
		apiBaseUrl: "https://api",
		apiAuthMode: "service-binding",
		tediId: "tedi-1",
		organizationId: "org-1",
		fetch: fetcher as typeof fetch,
	});
	await client.rankSkills({
		runId: "run-1",
		query: "Find accounting skills",
		skillIds: ["a", "b"],
	});
	expect(String(fetcher.mock.calls[0]?.[0])).toContain(
		"cognitiveRuntime/rankSkills",
	);
});

it("forwards a bounded discovery shortlist through the tenant service binding", async () => {
	const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
		const headers = new Headers(init?.headers);
		expect(headers.get("X-Tedix-Org-Id")).toBe("org-1");
		expect(headers.get("X-Tedix-Tedi-Id")).toBe("tedi-1");
		expect(JSON.parse(String(init?.body)).json).toEqual({
			query: "Find overdue orders",
			candidates: [
				{ id: "shop.list_orders", kind: "tool", description: "list orders" },
				{ id: "shop.get_order", kind: "tool", description: "get order" },
			],
			runId: "run-2",
		});
		return new Response(
			JSON.stringify({
				json: {
					rankedIds: ["shop.list_orders", "shop.get_order"],
					executionAttempts: [],
					usagePersistence: "persisted",
				},
			}),
			{ headers: { "Content-Type": "application/json" } },
		);
	});
	const client = new HttpPlatformClient({
		apiBaseUrl: "https://api",
		apiAuthMode: "service-binding",
		tediId: "tedi-1",
		organizationId: "org-1",
		fetch: fetcher as typeof fetch,
	});
	const ranked = await client.rankDiscovery({
		query: "Find overdue orders",
		candidates: [
			{ id: "shop.list_orders", kind: "tool", description: "list orders" },
			{ id: "shop.get_order", kind: "tool", description: "get order" },
		],
		runId: "run-2",
	});
	expect(ranked.rankedIds?.[0]).toBe("shop.list_orders");
	expect(String(fetcher.mock.calls[0]?.[0])).toContain(
		"cognitiveRuntime/rankDiscovery",
	);
});
