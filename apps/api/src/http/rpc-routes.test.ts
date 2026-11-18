import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { registerRpcRoutes } from "./rpc-routes";

const { handleRpc } = vi.hoisted(() => ({
	handleRpc: vi.fn(async () => ({
		matched: true,
		response: Response.json({ json: { status: "accepted" } }),
	})),
}));

vi.mock("../rpc/routers/index", () => ({ apiRouter: {} }));
vi.mock("../rpc/openapi-filter", () => ({ isPublicProcedure: () => true }));
vi.mock("../rpc/orpc", () => ({
	createContext: (_request: Request, env: CloudflareEnv) => ({
		env,
		serverTiming: ["auth-jwt;dur=1.0", "auth-identity;dur=20.0"],
		dbMetrics: { queries: 2, rowsRead: 3 },
		dbBookmark: () => "request-bookmark",
	}),
	logProcedureCall: ({ next }: { next: () => Promise<unknown> }) => next(),
}));
vi.mock("@orpc/server/fetch", () => ({
	RPCHandler: class {
		handle = handleRpc;
	},
}));

afterEach(() => vi.restoreAllMocks());

it("adds the RPC total without buffering the body or losing response metadata", async () => {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const body = new ReadableStream<Uint8Array>({
		start(value) {
			controller = value;
		},
	});
	handleRpc.mockResolvedValueOnce({
		matched: true,
		response: new Response(body, {
			status: 202,
			headers: { "Server-Timing": "upstream;dur=5.0" },
		}),
	});
	const app = new Hono<{ Bindings: CloudflareEnv }>();
	registerRpcRoutes(app);
	const response = await app.request(
		"https://api.example/rpc/userProfile/getMine",
		{ method: "POST" },
		{ ENVIRONMENT: "production" } as CloudflareEnv,
		{ waitUntil() {} } as unknown as ExecutionContext,
	);
	expect(response.status).toBe(202);
	expect(response.headers.get("x-d1-bookmark")).toBe("request-bookmark");
	const timing = response.headers.get("Server-Timing");
	expect(timing).toContain("upstream;dur=5.0");
	expect(timing).toContain("auth-jwt;dur=1.0");
	expect(timing).toContain("auth-identity;dur=20.0");
	expect(timing).toContain('db;desc="queries=2 rows=3"');
	expect(timing).toMatch(/api-rpc;dur=\d+\.\d/);
	controller.enqueue(new TextEncoder().encode("streamed"));
	controller.close();
	await expect(response.text()).resolves.toBe("streamed");
});

it.each(
	["development", "production"].flatMap((environment) =>
		["personalAgentInterfaces", "personalAgentConversation"].map(
			(procedure) => [environment, procedure] as const,
		),
	),
)(
	"keeps private protocol content out of %s %s request logs",
	async (environment, procedure) => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const app = new Hono<{ Bindings: CloudflareEnv }>();
		registerRpcRoutes(app);
		const response = await app.request(
			`https://api.example/rpc/osTenant/${procedure}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					json: {
						organizationId: "org-example",
						sessionToken: "private-session-proof",
						url: "https://public.example/mcp/poppy/conversations?private-query",
						body: {
							id: "request",
							message: {
								author: { type: "agent" },
								text: "private-conversation-text",
							},
						},
						report: {
							task: "private-feedback-task",
							description: "private-feedback-description",
						},
					},
				}),
			},
			{ ENVIRONMENT: environment } as CloudflareEnv,
			{
				waitUntil() {},
				passThroughOnException() {},
				props: {},
			} as ExecutionContext,
		);
		expect(response.status).toBe(200);
		const logged = JSON.stringify(log.mock.calls);
		expect(logged).not.toContain("private-session-proof");
		expect(logged).not.toContain("private-query");
		expect(logged).not.toContain("private-conversation-text");
		expect(logged).not.toContain("private-feedback-task");
		expect(logged).not.toContain("private-feedback-description");
		if (environment === "development") expect(logged).toContain("[REDACTED]");
	},
);
