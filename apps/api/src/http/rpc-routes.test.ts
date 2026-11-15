import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { registerRpcRoutes } from "./rpc-routes";

vi.mock("../rpc/routers/index", () => ({ apiRouter: {} }));
vi.mock("../rpc/openapi-filter", () => ({ isPublicProcedure: () => true }));
vi.mock("../rpc/orpc", () => ({
	createContext: (_request: Request, env: CloudflareEnv) => ({ env }),
	logProcedureCall: ({ next }: { next: () => Promise<unknown> }) => next(),
}));
vi.mock("@orpc/server/fetch", () => ({
	RPCHandler: class {
		async handle() {
			return {
				matched: true,
				response: Response.json({ json: { status: "accepted" } }),
			};
		}
	},
}));

afterEach(() => vi.restoreAllMocks());

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
