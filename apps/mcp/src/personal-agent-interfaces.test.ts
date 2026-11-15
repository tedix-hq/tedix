import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { handlePersonalAgentInterfaces } from "./personal-agent-interfaces";
const mocks = vi.hoisted(() => ({ interfaces: vi.fn(), index: vi.fn() }));
vi.mock("./lib/api-client", () => ({
	getApiClient: () => ({
		osTenant: { personalAgentInterfaces: mocks.interfaces },
	}),
}));
vi.mock("./well-known", () => ({ handlePublicSkillIndex: mocks.index }));
const base = "https://public.example/mcp/poppy/";
const report = { task: "Validator test report", description: "Please ignore" };
function call(path = "tasks", body?: unknown, headers?: HeadersInit) {
	return handlePersonalAgentInterfaces({
		request: new Request(`${base}${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: headers ?? {
				"Poppy-Session": "fictional-proof",
				"Poppy-Version": "1.0",
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		}),
		appId: "app-example",
		organizationId: "org-example",
		env: {} as CloudflareEnv,
	});
}
beforeEach(() => {
	vi.clearAllMocks();
	mocks.interfaces.mockResolvedValue({
		status: "accepted",
		excludedTasks: [{ task: "Delete an account" }],
		feedbackEndpoint: `${base}feedback`,
	});
	mocks.index.mockImplementation(async () =>
		Response.json({
			$schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
			skills: [],
		}),
	);
});
describe("public protocol interfaces", () => {
	it("returns the existing allowlisted skill index and tenant exclusions after Session verification", async () => {
		const response = await call();
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			excluded_tasks: [{ task: "Delete an account" }],
			skill_index: {
				$schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
				skills: [],
			},
			feedback: { endpoint: `${base}feedback` },
		});
		expect(mocks.interfaces).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionToken: "fictional-proof",
				version: "1.0",
				organizationId: "org-example",
				appId: "app-example",
				url: `${base}tasks`,
				method: "GET",
			}),
		);
	});
	it("responds to accepted feedback with 202 and an empty body", async () => {
		const response = await call("feedback", report);
		expect(response.status).toBe(202);
		expect(await response.text()).toBe("");
		expect(mocks.index).not.toHaveBeenCalled();
	});
	it("requires a verified Session even for unattributed feedback", async () => {
		mocks.interfaces.mockResolvedValue({ status: "invalid_session" });
		const response = await call("feedback", report, {});
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "invalid_session" });
		expect(mocks.interfaces).toHaveBeenCalledWith(
			expect.objectContaining({ sessionToken: null, version: null }),
		);
	});
	it.each([
		{ task: 42 },
		{ task: "x".repeat(201), description: "x" },
		{ task: "x", description: "x".repeat(2001) },
	])("rejects invalid feedback locally", async (body) => {
		const response = await call("feedback", body);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "invalid_request" });
		expect(mocks.interfaces).not.toHaveBeenCalled();
	});
	it.each([
		["not_configured", 404],
		["rate_limited", 429],
		["unavailable", 503],
		["session_ended", 400],
	] as const)(
		"propagates %s without publishing skills",
		async (status, code) => {
			mocks.interfaces.mockResolvedValue({ status });
			const response = await call();
			expect(response.status).toBe(code);
			expect(mocks.index).not.toHaveBeenCalled();
		},
	);
	it("bounds streamed feedback bodies", async () => {
		const response = await call("feedback", {
			task: "x",
			description: "x".repeat(32769),
		});
		expect(response.status).toBe(400);
		expect(mocks.interfaces).not.toHaveBeenCalled();
	});
	it("never substitutes an empty skill index for an upstream failure", async () => {
		mocks.index.mockResolvedValue(new Response(null, { status: 503 }));
		expect((await call()).status).toBe(503);
	});
});
