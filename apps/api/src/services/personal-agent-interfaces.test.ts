import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { DbClient } from "@tedix/db/client";
import { HTTPException } from "hono/http-exception";
import { personalAgentInterfaces } from "./personal-agent-interfaces";

const mocks = vi.hoisted(() => ({
	organization: vi.fn(),
	verify: vi.fn(),
	intake: vi.fn(),
}));
vi.mock("@tedix/db/queries/organizations", () => ({
	getOrganizationById: mocks.organization,
}));
vi.mock("./personal-agent-session", () => ({
	verifySignedOutPersonalAgentSession: mocks.verify,
}));
vi.mock("./agent-review", () => ({ filePersonalAgentFeedback: mocks.intake }));
const db = {} as DbClient;
const env = {} as CloudflareEnv;
const config = {
	domain: "company.example",
	mcpUrl: "https://public.example/mcp",
	description: "Public tasks",
	interfaces: {
		excludedTasks: [
			{
				task: "Delete an account",
				alternative: { instructions: "Contact support" },
			},
		],
		feedback: true,
	},
};
const input = {
	organizationId: "org-example",
	appId: "app-example",
	url: `${config.mcpUrl}/poppy/tasks`,
	method: "GET",
	sessionToken: "fictional-proof",
	version: "1.0",
};
const feedback = {
	...input,
	url: `${config.mcpUrl}/poppy/feedback`,
	method: "POST",
	report: { task: "Validator test", description: "Please ignore" },
};
beforeEach(() => {
	vi.clearAllMocks();
	mocks.organization.mockResolvedValue({
		metadata: { personalAgentProtocol: config },
	});
	mocks.verify.mockResolvedValue({
		status: "accepted",
		sessionCreated: true,
		identity: {
			clientId: "https://agent.example/agent.json",
			userId: "private-user",
			sessionId: "private-session",
			version: "1.0",
		},
	});
	mocks.intake.mockResolvedValue({ status: "received" });
});
describe("personal agent interfaces", () => {
	it("uses the tenant's stored exclusions after real Session verification", async () => {
		expect(await personalAgentInterfaces(db, env, input)).toEqual({
			status: "accepted",
			sessionCreated: true,
			excludedTasks: config.interfaces.excludedTasks,
			feedbackEndpoint: `${config.mcpUrl}/poppy/feedback`,
		});
		expect(mocks.organization).toHaveBeenCalledWith(db, input.organizationId);
		expect(mocks.verify).toHaveBeenCalledWith(db, input);
		expect(mocks.intake).not.toHaveBeenCalled();
	});
	it.each([
		"invalid_session",
		"session_ended",
		"rate_limited",
		"not_configured",
		"version_unsupported",
	])("does not accept feedback after %s", async (status) => {
		mocks.verify.mockResolvedValue({ status });
		expect(await personalAgentInterfaces(db, env, feedback)).toEqual({
			status,
		});
		expect(mocks.intake).not.toHaveBeenCalled();
	});
	it("routes verified feedback to the shared private intake", async () => {
		expect(await personalAgentInterfaces(db, env, feedback)).toEqual({
			status: "accepted",
			sessionCreated: true,
		});
		expect(mocks.intake).toHaveBeenCalledWith(
			db,
			env,
			feedback.report,
			input.organizationId,
		);
	});
	it.each([
		{ task: 42 },
		{ task: "x".repeat(201), description: "x" },
		{ task: "x", description: "x".repeat(2001) },
	])("rejects malformed feedback before intake", async (report) => {
		expect(
			await personalAgentInterfaces(db, env, { ...feedback, report }),
		).toEqual({ status: "invalid_request" });
		expect(mocks.intake).not.toHaveBeenCalled();
	});
	it("fails closed for disabled interfaces, wrong hosts, methods and paths", async () => {
		for (const change of [
			{ url: "https://foreign.example/mcp/poppy/tasks" },
			{ url: `${input.url}-lookalike` },
			{ method: "POST" },
		]) {
			expect(
				await personalAgentInterfaces(db, env, { ...input, ...change }),
			).toEqual({ status: "not_configured" });
		}
		mocks.organization.mockResolvedValue({
			metadata: { personalAgentProtocol: { ...config, interfaces: undefined } },
		});
		expect(await personalAgentInterfaces(db, env, input)).toEqual({
			status: "not_configured",
		});
		expect(mocks.verify).not.toHaveBeenCalled();
	});
	it("keeps private intake errors out of protocol responses", async () => {
		mocks.intake.mockRejectedValue(new Error("private-provider-detail"));
		expect(await personalAgentInterfaces(db, env, feedback)).toEqual({
			status: "unavailable",
		});
		mocks.intake.mockRejectedValue(new HTTPException(429));
		expect(await personalAgentInterfaces(db, env, feedback)).toEqual({
			status: "rate_limited",
		});
	});
});
