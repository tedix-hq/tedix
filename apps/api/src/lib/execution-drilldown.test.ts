import { describe, expect, it } from "vite-plus/test";
import {
	type AuditDrilldownRow,
	buildDrilldownFromAuditRows,
} from "./execution-drilldown";

const TS = 1781115040; // unix seconds

function row(partial: Partial<AuditDrilldownRow>): AuditDrilldownRow {
	return {
		action: "mcp.tool.execute",
		actorId: "U39z24M",
		actorType: "user",
		resourceId: "atlassian_acme__atlassianUserInfo",
		timestamp: TS,
		durationMs: 12,
		errorCode: null,
		traceId: "trace-1",
		clientId: null,
		...partial,
	};
}

describe("buildDrilldownFromAuditRows", () => {
	it("splits the parent code_exec from inner tool calls", () => {
		const out = buildDrilldownFromAuditRows([
			row({ action: "mcp.code.execute", resourceId: null, durationMs: 2518 }),
			row({ action: "mcp.tool.execute", resourceId: "a_userInfo" }),
			row({ action: "mcp.tool.execute", resourceId: "a_getResources" }),
		]);
		expect(out.execution?.eventType).toBe("code_exec");
		expect(out.execution?.toolName).toBe("code");
		expect(out.toolCalls.map((t) => t.toolName)).toEqual([
			"a_userInfo",
			"a_getResources",
		]);
		expect(out.source).toBe("audit");
	});

	it("lifts the actor + traceId from the parent code row", () => {
		const out = buildDrilldownFromAuditRows([
			row({
				action: "mcp.code.execute",
				resourceId: null,
				actorId: "U3EGNW",
				actorType: "user",
				traceId: "187012d9",
				clientId: "Claude",
			}),
			row({ action: "mcp.tool.execute", actorId: "U3EGNW" }),
		]);
		expect(out.actor).toEqual({ actorId: "U3EGNW", actorType: "user" });
		expect(out.traceId).toBe("187012d9");
		expect(out.clientId).toBe("Claude");
	});

	it("maps .error actions to success=false and carries errorCode", () => {
		const out = buildDrilldownFromAuditRows([
			row({ action: "mcp.tool.error", errorCode: "UpstreamError" }),
		]);
		expect(out.toolCalls[0]?.success).toBe(false);
		expect(out.toolCalls[0]?.errorCode).toBe("UpstreamError");
	});

	it("maps .execute actions to success=true", () => {
		const out = buildDrilldownFromAuditRows([
			row({ action: "mcp.tool.execute" }),
		]);
		expect(out.toolCalls[0]?.success).toBe(true);
	});

	it("converts unix-second timestamps to ISO", () => {
		const out = buildDrilldownFromAuditRows([row({ timestamp: TS })]);
		expect(out.toolCalls[0]?.timestamp).toBe(new Date(TS * 1000).toISOString());
	});

	it("falls back to the first row for actor when there is no code parent", () => {
		const out = buildDrilldownFromAuditRows([
			row({
				action: "mcp.tool.execute",
				actorId: "U-first",
				actorType: "tedi",
			}),
		]);
		expect(out.execution).toBeNull();
		expect(out.actor).toEqual({ actorId: "U-first", actorType: "tedi" });
	});
});
