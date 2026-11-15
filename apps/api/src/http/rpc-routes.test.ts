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

it.each(["development", "production"])(
	"keeps private feedback out of %s request logs",
	async (environment) => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const app = new Hono<{ Bindings: CloudflareEnv }>();
		registerRpcRoutes(app);
		const response = await app.request(
			"https://api.example/rpc/osTenant/personalAgentInterfaces",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					json: {
						organizationId: "org-example",
						sessionToken: "private-session-proof",
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
		expect(logged).not.toContain("private-feedback-task");
		expect(logged).not.toContain("private-feedback-description");
		if (environment === "development") expect(logged).toContain("[REDACTED]");
	},
);
