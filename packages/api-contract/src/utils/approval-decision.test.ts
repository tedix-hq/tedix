import { describe, expect, it } from "vite-plus/test";
import { approvalDecision } from "./approval-decision";
describe("approval decision catalog", () => {
	const skillRequest = {
		actionType: "mcp.tool_call",
		review: { intent: "unknown" },
		description:
			"Run skill: nightly-check improvement abc12345. Nothing has run yet; approving allows one identical retry of this call.",
		payload: {
			kind: "mcp_tool_call",
			target: { transport: "rpc", endpoint: "skills/runWorkflow" },
			args: { params: { probe: true } },
		},
	};
	it("names a saved skill proposal probe without claiming approval executes it", () => {
		const result = approvalDecision(skillRequest);
		expect(result.what).toBe("Run a test of the nightly-check skill proposal.");
		expect(result.ifApproved).toContain(
			"Approval alone does not start it or activate the proposal",
		);
		expect(result.reason).not.toContain("can't describe");
		expect(result.recommendation).toBe("rejected");
	});
	it("distinguishes normal runs and missing names from a proposal probe", () => {
		expect(
			approvalDecision({
				...skillRequest,
				payload: {
					...skillRequest.payload,
					args: { params: { probe: false } },
				},
			}).what,
		).toBe("Run the nightly-check skill.");
		expect(approvalDecision({ ...skillRequest, description: "" }).what).toBe(
			"Run a test of the saved skill proposal.",
		);
	});
	it("does not trust a skill-looking description for a different action", () => {
		const result = approvalDecision({
			...skillRequest,
			payload: {
				...skillRequest.payload,
				target: { transport: "rpc", endpoint: "billing/pay" },
			},
		});
		expect(result.what).not.toContain("skill proposal");
		expect(result.details).toContain("Tool: billing/pay");
		expect(result.recommendation).toBe("rejected");
	});
	it("names a parked tool call and its inputs in plain words", () => {
		const result = approvalDecision({
			actionType: "mcp.tool_call",
			review: { intent: "unknown" },
			description:
				"Create api key. Nothing has run yet; approving allows one identical retry of this call.",
			payload: {
				kind: "mcp_tool_call",
				target: { transport: "rpc", endpoint: "organizations/createApiKey" },
				args: {
					organizationId: "00000000-0000-4000-8000-000000000001",
					name: "External agent laptop",
					scopes: ["work:read", "work:write"],
				},
			},
		});
		expect(result.what).toBe("Create api key.");
		expect(result.details).toEqual([
			"Name: External agent laptop",
			"Scopes: work:read, work:write",
			"Tool: organizations/createApiKey",
		]);
		expect(result.reason).toContain("credential");
	});
	it("names a parked Home write by its tool and risk", () => {
		const result = approvalDecision({
			actionType: "home.tool_write",
			review: { intent: "tool_write" },
			description: "Create factory — name: Instinct diagnostic plan",
			payload: {
				kind: "home_tool_write",
				riskTier: "high",
				args: { name: "Instinct diagnostic plan", dryRun: true },
			},
		});
		expect(result.what).toBe("Create factory.");
		expect(result.details).toEqual([
			"Name: Instinct diagnostic plan",
			"Dry run: yes",
		]);
		expect(result.reason).toContain("High-risk");
	});
	it("does not invent effects for unknown runtime actions", () => {
		const result = approvalDecision({
			actionType: "fictional_action",
			review: { intent: "unknown" },
		});
		expect(result.recommendation).toBe("rejected");
		expect(result.reason).toBe(
			"Tedix can't describe this action, so it's safer to reject.",
		);
	});
	it("recommends approving a low-risk Home write and reviewing anything riskier", () => {
		const write = (riskTier?: string) =>
			approvalDecision({
				actionType: "home_request",
				review: { intent: "home_write" },
				riskTier,
			});
		expect(write("low")).toMatchObject({
			recommendation: "approved",
			reason: expect.stringContaining("Low-risk"),
		});
		for (const risk of ["medium", "high", undefined])
			expect(write(risk).recommendation).toBe("rejected");
	});
	it("keeps sign-in and consent with the person", () => {
		expect(
			approvalDecision({
				actionType: "browser.live_view_takeover",
				review: { intent: "browser_takeover" },
			}),
		).toMatchObject({
			recommendation: "rejected",
			reason: expect.stringContaining("your presence"),
		});
	});
});
