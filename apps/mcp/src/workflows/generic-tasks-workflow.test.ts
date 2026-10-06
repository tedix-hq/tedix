import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

// In-memory fake of the drizzle slice the workflow uses, keyed by taskId.
type Row = Record<string, unknown>;
const rows: Row[] = [];

function fakeDb() {
	return {
		select(_columns?: Record<string, unknown>) {
			return {
				from() {
					return {
						where(predicate: (r: Row) => boolean) {
							return {
								async limit() {
									return rows.filter(predicate);
								},
							};
						},
					};
				},
			};
		},
		update() {
			return {
				set(patch: Row) {
					return {
						async where(predicate: (r: Row) => boolean) {
							for (const row of rows) {
								if (predicate(row)) Object.assign(row, patch);
							}
						},
					};
				},
			};
		},
	};
}

vi.mock("drizzle-orm", () => ({
	eq: (_col: unknown, value: unknown) => (r: Row) => r.taskId === value,
}));
vi.mock("@tedix/db/client", () => ({ createDbClient: () => fakeDb() }));
vi.mock("@tedix/db/schema/mcp-tasks", () => ({
	mcpTasks: {
		taskId: "task_id",
		status: "status",
		cancelRequestedAt: "cancel_requested_at",
		orgId: "org_id",
		toolName: "tool_name",
		inputRequests: "input_requests",
	},
}));
// WorkflowEntrypoint just needs to expose `this.env`; the workflow does not call
// any base methods.
vi.mock("cloudflare:workers", () => ({
	WorkflowEntrypoint: class {
		env: unknown;
		constructor(_ctx: unknown, env: unknown) {
			this.env = env;
		}
	},
}));

import {
	GENERIC_TASK_ENDPOINT_SCOPES,
	GenericTasksWorkflow,
} from "./generic-tasks-workflow";

// `step.do` just runs the closure inline for the test.
const step = {
	async do<T>(_name: string, fn: () => Promise<T>): Promise<T> {
		return fn();
	},
} as never;

function makeWorkflow(fetchImpl: ReturnType<typeof vi.fn>) {
	const env = {
		DB: {} as never,
		API_SERVICE: { fetch: fetchImpl },
	} as unknown as CloudflareEnv;
	return new GenericTasksWorkflow({} as never, env);
}

function requestFromCall(call: unknown[]): Request {
	return call[0] as Request;
}

function isMembersCall(call: unknown[]): boolean {
	return requestFromCall(call).url.includes("/members/listMembers");
}

function seedTask(overrides: Row = {}): string {
	const taskId = `generic-${crypto.randomUUID()}`;
	rows.push({
		taskId,
		status: "working",
		cancelRequestedAt: null,
		orgId: "org-1",
		toolName: "home__async_canary",
		inputRequests: {
			input: { limit: 5 },
			execConfig: {
				transport: "rpc",
				endpoint: "kernelRuntime/readRunSet",
				responsePath: "json",
			},
		},
		...overrides,
	});
	return taskId;
}

beforeEach(() => {
	rows.length = 0;
});

describe("GenericTasksWorkflow", () => {
	it("keeps detached service-binding authority on an exact code-owned endpoint map", () => {
		expect(GENERIC_TASK_ENDPOINT_SCOPES).toEqual({
			"kernelRuntime/readRunSet": ["tedis:read"],
		});
	});

	it("encodes REST GET input as query parameters without a request body", async () => {
		const fetchImpl = vi.fn(
			async () =>
				new Response(JSON.stringify({ items: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		const taskId = seedTask({
			inputRequests: {
				input: {
					appId: "app/alpha",
					limit: 5,
					tags: ["stable", "public"],
					filter: { status: "active" },
				},
				execConfig: {
					transport: "rest",
					endpoint: "apps/{appId}/knowledge/list",
					method: "GET",
				},
			},
		});

		await makeWorkflow(fetchImpl).run({ payload: { taskId } } as never, step);

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(url).toBe(
			"https://api/v1/apps/app%2Falpha/knowledge/list?limit=5&tags=stable&tags=public&filter%5Bstatus%5D=active",
		);
		expect(init.method).toBe("GET");
		expect(init.body).toBeUndefined();
		expect(new Headers(init.headers).get("X-Tedix-Tedi-Scopes")).toBeNull();
		expect(rows.find((row) => row.taskId === taskId)?.status).toBe("completed");
	});

	it("dispatches the snapshotted rpc tool and writes a completed terminal", async () => {
		const fetchImpl = vi.fn(
			async () =>
				new Response(JSON.stringify({ json: { runs: [{ id: "r1" }] } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		const taskId = seedTask();
		const wf = makeWorkflow(fetchImpl);
		await wf.run({ payload: { taskId } } as never, step);

		// Hit the org-scoped rpc endpoint over the service binding.
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const request = requestFromCall(fetchImpl.mock.calls[0] as unknown[]);
		expect(request.url).toBe("https://api/rpc/kernelRuntime/readRunSet");
		expect(await request.clone().text()).toContain('"limit":5');
		expect(request.headers.get("X-Tedix-Tedi-Scopes")).toBe("tedis:read");

		const row = rows.find((r) => r.taskId === taskId)!;
		expect(row.status).toBe("completed");
		expect(row.result).toMatchObject({
			structuredContent: { runs: [{ id: "r1" }] },
		});
	});

	it("writes a failed terminal on an upstream error", async () => {
		const fetchImpl = vi.fn(
			async () =>
				new Response(JSON.stringify({ error: "nope" }), {
					status: 500,
					headers: { "content-type": "application/json" },
				}),
		);
		const taskId = seedTask();
		await makeWorkflow(fetchImpl).run({ payload: { taskId } } as never, step);

		const row = rows.find((r) => r.taskId === taskId)!;
		expect(row.status).toBe("failed");
		expect((row.error as { code: number }).code).toBe(-32_603);
	});

	it("reports external transport as the documented seam (-32601), no dispatch", async () => {
		const fetchImpl = vi.fn();
		const taskId = seedTask({
			inputRequests: {
				input: {},
				execConfig: { transport: "external", endpoint: "content/search" },
			},
		});
		await makeWorkflow(fetchImpl).run({ payload: { taskId } } as never, step);

		expect(fetchImpl).not.toHaveBeenCalled();
		const row = rows.find((r) => r.taskId === taskId)!;
		expect(row.status).toBe("failed");
		expect((row.error as { code: number }).code).toBe(-32_601);
	});

	it("honors a cancel requested before execution (no dispatch)", async () => {
		const fetchImpl = vi.fn();
		const taskId = seedTask({ cancelRequestedAt: new Date().toISOString() });
		await makeWorkflow(fetchImpl).run({ payload: { taskId } } as never, step);

		expect(fetchImpl).not.toHaveBeenCalled();
		const row = rows.find((r) => r.taskId === taskId)!;
		expect(row.status).toBe("cancelled");
	});

	it("lets a cancel that lands mid-execution win over a late completion", async () => {
		const fetchImpl = vi.fn(async () => {
			// Simulate the cancel landing while the dispatch is in flight.
			const row = rows[0]!;
			row.cancelRequestedAt = new Date().toISOString();
			return new Response(JSON.stringify({ json: { ok: true } }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});
		const taskId = seedTask();
		await makeWorkflow(fetchImpl).run({ payload: { taskId } } as never, step);

		const row = rows.find((r) => r.taskId === taskId)!;
		expect(row.status).toBe("cancelled");
	});

	it("no-ops on an already-terminal task", async () => {
		const fetchImpl = vi.fn();
		const taskId = seedTask({ status: "completed" });
		await makeWorkflow(fetchImpl).run({ payload: { taskId } } as never, step);
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});

// ── Members-listMembers responder for the dispatch-time authority re-check.
// Returns the RPC envelope `{ json: { data: [...] } }` shape apps/api emits.
function membersResponse(activeUserIds: string[]): Response {
	return new Response(
		JSON.stringify({
			json: {
				data: activeUserIds.map((id) => ({
					descopeUserId: id,
					status: "active",
				})),
				pagination: { limit: 100, offset: 0, total: activeUserIds.length },
			},
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

describe("GenericTasksWorkflow caller-auth replay", () => {
	function lastDispatchCall(
		fetchImpl: ReturnType<typeof vi.fn>,
	): Request | undefined {
		const dispatch = fetchImpl.mock.calls.find(
			(c) => !isMembersCall(c as unknown[]),
		);
		return dispatch ? requestFromCall(dispatch as unknown[]) : undefined;
	}

	it("replays X-Tedix-Acting-User (NOT tedi-id) for a non-tedi acting user", async () => {
		const fetchImpl = vi.fn(async (request: Request) =>
			request.url.includes("/members/listMembers")
				? membersResponse(["user-uuid"])
				: new Response(JSON.stringify({ json: { ok: true } }), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
		);
		const taskId = seedTask({
			inputRequests: {
				input: { limit: 5 },
				execConfig: {
					transport: "rpc",
					endpoint: "kernelRuntime/readRunSet",
					responsePath: "json",
				},
				caller: {
					authType: "oauth",
					userId: "user-uuid",
					organizationId: "org-1",
				},
			},
		});
		await makeWorkflow(fetchImpl).run({ payload: { taskId } } as never, step);

		const dispatch = lastDispatchCall(fetchImpl)!;
		const headers = dispatch.headers;
		expect(headers.get("X-Service-Binding")).toBe("true");
		expect(headers.get("X-Tedix-Org-Id")).toBe("org-1");
		expect(headers.get("X-Tedix-Acting-User")).toBe("user-uuid");
		// Never set the tedi-id leg for a non-tedi caller.
		expect(headers.get("X-Tedix-Tedi-Id")).toBeNull();
		// No Authorization bearer is replayed — service-binding is the trust anchor.
		expect(headers.get("Authorization")).toBeNull();
		// Stable taskId idempotency key rides the dispatch.
		expect(headers.get("Idempotency-Key")).toBe(taskId);
		expect(headers.get("X-Idempotency-Key")).toBe(taskId);

		const row = rows.find((r) => r.taskId === taskId)!;
		expect(row.status).toBe("completed");
	});

	it("replays X-Tedix-Tedi-Id (NOT acting-user) for a tedi caller and skips the membership check", async () => {
		const fetchImpl = vi.fn(
			async () =>
				new Response(JSON.stringify({ json: { ok: true } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		const taskId = seedTask({
			inputRequests: {
				input: { limit: 5 },
				execConfig: {
					transport: "rpc",
					endpoint: "kernelRuntime/readRunSet",
					responsePath: "json",
				},
				caller: {
					authType: "tedi",
					tediId: "tedi-uuid",
					userId: "user-uuid",
					organizationId: "org-1",
				},
			},
		});
		await makeWorkflow(fetchImpl).run({ payload: { taskId } } as never, step);

		// Tedi callers skip the membership re-check — only the dispatch fires.
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const headers = requestFromCall(
			fetchImpl.mock.calls[0] as unknown[],
		).headers;
		expect(headers.get("X-Tedix-Tedi-Id")).toBe("tedi-uuid");
		// Never set both — acting-user must be absent when a tedi is present.
		expect(headers.get("X-Tedix-Acting-User")).toBeNull();
		expect(rows.find((r) => r.taskId === taskId)!.status).toBe("completed");
	});

	it("replays X-Tedix-Kernel only for kernel turns", async () => {
		const fetchImpl = vi.fn(async (request: Request) =>
			request.url.includes("/members/listMembers")
				? membersResponse(["user-uuid"])
				: new Response(JSON.stringify({ json: { ok: true } }), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
		);
		const taskId = seedTask({
			inputRequests: {
				input: {},
				execConfig: { transport: "rpc", endpoint: "kernelRuntime/readRunSet" },
				caller: {
					authType: "service",
					userId: "user-uuid",
					organizationId: "org-1",
					kernel: true,
				},
			},
		});
		await makeWorkflow(fetchImpl).run({ payload: { taskId } } as never, step);

		const dispatch = lastDispatchCall(fetchImpl)!;
		const headers = dispatch.headers;
		expect(headers.get("X-Tedix-Kernel")).toBe("true");
		// Kernel acting human still rides as acting-user (no fake tedi).
		expect(headers.get("X-Tedix-Acting-User")).toBe("user-uuid");
		expect(headers.get("X-Tedix-Tedi-Id")).toBeNull();
	});

	it("fails closed (-32603) with NO fetch when neither caller org nor row org is present", async () => {
		const fetchImpl = vi.fn();
		const taskId = seedTask({
			orgId: "",
			inputRequests: {
				input: {},
				execConfig: { transport: "rpc", endpoint: "kernelRuntime/readRunSet" },
				caller: { authType: "service" },
			},
		});
		await makeWorkflow(fetchImpl).run({ payload: { taskId } } as never, step);

		expect(fetchImpl).not.toHaveBeenCalled();
		const row = rows.find((r) => r.taskId === taskId)!;
		expect(row.status).toBe("failed");
		expect((row.error as { code: number }).code).toBe(-32_603);
		expect((row.error as { message: string }).message).toContain(
			"caller org boundary",
		);
	});

	it("fails closed when the dispatch-time membership re-check denies the acting user (no dispatch)", async () => {
		const fetchImpl = vi.fn(async (request: Request) =>
			request.url.includes("/members/listMembers")
				? // The acting user is NOT in the active member set → revoked.
					membersResponse(["some-other-user"])
				: new Response(JSON.stringify({ json: { ok: true } }), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
		);
		const taskId = seedTask({
			inputRequests: {
				input: { limit: 5 },
				execConfig: { transport: "rpc", endpoint: "kernelRuntime/readRunSet" },
				caller: {
					authType: "oauth",
					userId: "revoked-user",
					organizationId: "org-1",
				},
			},
		});
		await makeWorkflow(fetchImpl).run({ payload: { taskId } } as never, step);

		// Only the membership check fired; the tool dispatch did not.
		const dispatchCall = fetchImpl.mock.calls.find(
			(c) => !isMembersCall(c as unknown[]),
		);
		expect(dispatchCall).toBeUndefined();
		const row = rows.find((r) => r.taskId === taskId)!;
		expect(row.status).toBe("failed");
		expect((row.error as { code: number }).code).toBe(-32_603);
		expect((row.error as { message: string }).message).toContain(
			"could not be re-confirmed",
		);
	});

	it("paginates the membership re-check — a user found on a LATER page is allowed (no false-deny in a >100-member org)", async () => {
		// Page 0 (offset 0): 100 other active members + hasMore:true.
		// Page 1 (offset 100): the acting user. A single first-page read would
		// FALSE-deny a legitimate caller; pagination must find them and dispatch.
		const pageZero = Array.from({ length: 100 }, (_, i) => `other-${i}`);
		const fetchImpl = vi.fn(async (request: Request) => {
			if (request.url.includes("/members/listMembers")) {
				const body = (await request.clone().json()) as {
					json?: { offset?: number };
				};
				const offset = body.json?.offset ?? 0;
				const data =
					offset === 0
						? pageZero.map((id) => ({ descopeUserId: id, status: "active" }))
						: [{ descopeUserId: "user-uuid", status: "active" }];
				return new Response(
					JSON.stringify({
						json: {
							data,
							pagination: {
								limit: 100,
								offset,
								total: 150,
								hasMore: offset === 0,
							},
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			return new Response(JSON.stringify({ json: { ok: true } }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});
		const taskId = seedTask({
			inputRequests: {
				input: { limit: 5 },
				execConfig: { transport: "rpc", endpoint: "kernelRuntime/readRunSet" },
				caller: {
					authType: "oauth",
					userId: "user-uuid",
					organizationId: "org-1",
				},
			},
		});
		await makeWorkflow(fetchImpl).run({ payload: { taskId } } as never, step);

		// Both membership pages were read, then the tool dispatched (user allowed).
		const memberCalls = fetchImpl.mock.calls.filter((c) =>
			isMembersCall(c as unknown[]),
		);
		expect(memberCalls.length).toBe(2);
		expect(lastDispatchCall(fetchImpl)).toBeDefined();
		expect(rows.find((r) => r.taskId === taskId)?.status).toBe("completed");
	});

	it("still reports external transport as the documented seam (-32601) — Part B deferred", async () => {
		const fetchImpl = vi.fn(async (request: Request) =>
			request.url.includes("/members/listMembers")
				? membersResponse(["user-uuid"])
				: new Response("", { status: 200 }),
		);
		const taskId = seedTask({
			inputRequests: {
				input: {},
				execConfig: { transport: "external", endpoint: "content/search" },
				caller: {
					authType: "oauth",
					userId: "user-uuid",
					organizationId: "org-1",
				},
			},
		});
		await makeWorkflow(fetchImpl).run({ payload: { taskId } } as never, step);

		// The membership check may run, but no tool dispatch happens for external.
		const dispatchCall = fetchImpl.mock.calls.find(
			(c) => !isMembersCall(c as unknown[]),
		);
		expect(dispatchCall).toBeUndefined();
		const row = rows.find((r) => r.taskId === taskId)!;
		expect(row.status).toBe("failed");
		expect((row.error as { code: number }).code).toBe(-32_601);
	});
});

describe("GenericTasksWorkflow dispatch step-split / idempotency", () => {
	it("does NOT re-dispatch on a re-run after a prior successful dispatch (terminal short-circuit)", async () => {
		let dispatches = 0;
		const fetchImpl = vi.fn(async (request: Request) => {
			if (request.url.includes("/members/listMembers")) {
				return membersResponse(["user-uuid"]);
			}
			dispatches += 1;
			return new Response(JSON.stringify({ json: { runs: [{ id: "r1" }] } }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});
		const taskId = seedTask({
			inputRequests: {
				input: { limit: 5 },
				execConfig: {
					transport: "rpc",
					endpoint: "kernelRuntime/readRunSet",
					responsePath: "json",
				},
				caller: {
					authType: "oauth",
					userId: "user-uuid",
					organizationId: "org-1",
				},
			},
		});
		const wf = makeWorkflow(fetchImpl);

		// Cloudflare Workflow step semantics: a COMPLETED step's result is
		// memoized and never re-run; only a still-failing step is retried. This
		// harness models that — `write-terminal` throws on its first attempt and is
		// retried, while `dispatch` (already completed + memoized) is not re-run.
		// The pre-split code shared dispatch+terminal in one step, so this retry
		// would have re-dispatched the side effect (double-dispatch). The split
		// makes the retry touch only the terminal write.
		const memo = new Map<string, unknown>();
		let writeTerminalAttempts = 0;
		const retryingStep = {
			async do<T>(name: string, fn: () => Promise<T>): Promise<T> {
				if (memo.has(name)) return memo.get(name) as T;
				if (name === "write-terminal") {
					writeTerminalAttempts += 1;
					if (writeTerminalAttempts === 1) {
						// First terminal-write attempt fails after dispatch already
						// completed; the framework retries the step.
						try {
							await fn();
						} catch {
							/* ignore */
						}
						throw new Error("simulated terminal-write failure (retry)");
					}
				}
				const result = await fn();
				memo.set(name, result);
				return result;
			},
		} as never;

		// First attempt: dispatch completes, terminal-write throws → step retried.
		await expect(
			wf.run({ payload: { taskId } } as never, retryingStep),
		).rejects.toThrow("simulated terminal-write failure");
		expect(dispatches).toBe(1);

		// Retry the run: `dispatch` is memoized (not re-run), only `write-terminal`
		// re-executes — so the side effect is not dispatched a second time.
		await wf.run({ payload: { taskId } } as never, retryingStep);
		expect(dispatches).toBe(1);
		const afterRetry = rows.find((r) => r.taskId === taskId)!;
		expect(afterRetry.status).toBe("completed");
		expect(afterRetry.result).toMatchObject({
			structuredContent: { runs: [{ id: "r1" }] },
		});
	});

	it("a cancel landing before the dispatch step yields cancelled without dispatch", async () => {
		const fetchImpl = vi.fn(async (request: Request) =>
			request.url.includes("/members/listMembers")
				? membersResponse(["user-uuid"])
				: new Response(JSON.stringify({ json: { ok: true } }), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
		);
		// cancelRequestedAt is set, but status is still working — Step 2 catches it.
		const taskId = seedTask({
			cancelRequestedAt: new Date().toISOString(),
			inputRequests: {
				input: {},
				execConfig: { transport: "rpc", endpoint: "kernelRuntime/readRunSet" },
				caller: {
					authType: "oauth",
					userId: "user-uuid",
					organizationId: "org-1",
				},
			},
		});
		await makeWorkflow(fetchImpl).run({ payload: { taskId } } as never, step);

		expect(fetchImpl).not.toHaveBeenCalled();
		expect(rows.find((r) => r.taskId === taskId)!.status).toBe("cancelled");
	});
});
