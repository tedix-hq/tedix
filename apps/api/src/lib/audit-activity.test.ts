import { describe, expect, it } from "vite-plus/test";
import { type AuditActivityRow, mapAuditActivityRow } from "./audit-activity";

const TS = 1781115040;

function row(p: Partial<AuditActivityRow>): AuditActivityRow {
	return {
		action: "mcp.tool.execute",
		actorId: "U3EGNW",
		actorType: "user",
		resourceId: "atlassian_acme__atlassianUserInfo",
		timestamp: TS,
		appId: "e9b24a5e",
		durationMs: 775,
		errorCode: null,
		executionId: "0afadce4",
		traceId: "187012d9",
		clientId: "Claude",
		...p,
	};
}

describe("mapAuditActivityRow", () => {
	it("maps a successful tool execute row with full attribution", () => {
		const out = mapAuditActivityRow(
			row({
				subjectUserId: "U-human",
				agentTediId: "tedi-1",
				oauthClientId: "Claude",
				delegationMode: "human_to_tedi",
			}),
		);
		expect(out).toMatchObject({
			actorId: "U3EGNW",
			actorType: "user",
			actor: { id: "U3EGNW", type: "user" },
			subject: { id: "U-human", type: "user" },
			agent: { id: "tedi-1", type: "tedi" },
			attribution: {
				mode: "human_to_tedi",
				client: { id: "Claude", label: "Claude" },
			},
			success: true,
			toolName: "atlassian_acme__atlassianUserInfo",
			tool: {
				label: "Atlassian User Info",
				toolName: "atlassian_acme__atlassianUserInfo",
				unresolved: true,
			},
			appId: "e9b24a5e",
			app: { id: "e9b24a5e", unresolved: true },
			executionId: "0afadce4",
			traceId: "187012d9",
			clientId: "Claude",
			delegationMode: "human_to_tedi",
			durationMs: 775,
			errorCode: null,
		});
		expect(out.identityCoverage.warnings).toEqual([
			"actor_unresolved",
			"subject_unresolved",
			"agent_unresolved",
			"app_unresolved",
			"tool_unresolved",
		]);
		expect(out.identityCoverage.warningDetails).toMatchObject([
			{
				code: "actor_unresolved",
				label: "Actor unresolved",
				severity: "warning",
				recommendedAction: expect.stringContaining("actorId/actorType"),
			},
			{
				code: "subject_unresolved",
				label: "Subject unresolved",
				severity: "warning",
			},
			{
				code: "agent_unresolved",
				label: "Agent unresolved",
				severity: "warning",
			},
			{
				code: "app_unresolved",
				label: "App unresolved",
				severity: "warning",
			},
			{
				code: "tool_unresolved",
				label: "Tool unresolved",
				severity: "warning",
			},
		]);
		expect(out.timestamp).toBe(new Date(TS * 1000).toISOString());
	});

	it("maps .error to success=false and carries errorCode", () => {
		const out = mapAuditActivityRow(
			row({ action: "mcp.tool.error", errorCode: "UpstreamError" }),
		);
		expect(out.success).toBe(false);
		expect(out.errorCode).toBe("UpstreamError");
	});

	it("maps pre-dispatch denials without inventing execution or risk evidence", () => {
		const out = mapAuditActivityRow(
			row({
				action: "mcp.access.denied",
				errorCode: "insufficient_scope",
				denialReason: "insufficient_scope",
				httpStatus: 403,
				mcpMethod: "tools/call",
				riskTier: null,
			}),
		);
		expect(out.success).toBe(false);
		expect(out.securityDecision).toEqual({
			disposition: "denied",
			denialReason: "insufficient_scope",
			httpStatus: 403,
			mcpMethod: "tools/call",
			riskTier: null,
		});
	});

	it("tolerates null actor/duration/ids", () => {
		const out = mapAuditActivityRow(
			row({
				actorId: null,
				actorType: null,
				durationMs: null,
				resourceId: null,
				traceId: null,
			}),
		);
		expect(out.actorId).toBe("");
		expect(out.actorType).toBe("");
		expect(out.durationMs).toBeNull();
		expect(out.toolName).toBeNull();
		expect(out.traceId).toBeNull();
		expect(out.identityCoverage.warnings).toContain("subject_missing");
		expect(out.identityCoverage.warningDetails).toContainEqual(
			expect.objectContaining({
				code: "subject_missing",
				label: "No human subject",
				severity: "info",
				recommendedAction: expect.stringContaining("subjectUserId"),
			}),
		);
	});
});
