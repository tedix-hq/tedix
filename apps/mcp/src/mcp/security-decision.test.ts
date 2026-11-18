import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { ledger, appendChangeRecord } = await vi.hoisted(async () => {
	const { createGatewayLedgerApi } = await import("../../test/gateway-ledger");
	const ledger = createGatewayLedgerApi();
	return { ledger, appendChangeRecord: vi.fn(ledger.appendChangeRecord) };
});
vi.mock("../lib/api-client", () => ({
	getApiClient: vi.fn(() => ({ audit: { ...ledger, appendChangeRecord } })),
}));
const { trackMcpEvent, emitMcpAuditEvent } = vi.hoisted(() => ({
	trackMcpEvent: vi.fn(),
	emitMcpAuditEvent: vi.fn(),
}));

vi.mock("./server-factory", () => ({
	extractCallerIdentity: vi.fn(() => ({
		authType: "oauth",
		userId: "U-1",
		clientId: "client-1",
		scopes: ["mcp:read"],
	})),
}));

vi.mock("./utils/analytics", async (importOriginal) => {
	const original = await importOriginal<typeof import("./utils/analytics")>();
	return { ...original, trackMcpEvent, emitMcpAuditEvent };
});

import {
	classifyProtocolDenial,
	MCP_ACCESS_DENIAL_REASONS,
	recordMcpAccessDenial,
} from "./security-decision";

const resolvedApp = {
	app: {
		id: "app-1",
		slug: "tedix",
		name: "Tedix",
		domain: "tedix.mcp.tedix.dev",
		organizationId: "org-1",
		visibility: "private",
	},
	metadata: null,
	tools: [],
} as never;

describe("MCP pre-dispatch security decisions", () => {
	beforeEach(() => {
		appendChangeRecord.mockClear();
		trackMcpEvent.mockReset();
		emitMcpAuditEvent.mockReset();
	});

	it.each(MCP_ACCESS_DENIAL_REASONS)(
		"emits the stable %s denial without request arguments",
		async (reason) => {
			const request = new Request("https://tedix.mcp.tedix.dev/mcp", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Mcp-Method": "tools/call",
					"Mcp-Name": "run_tedi_turn",
					"x-tedix-auth-type": "oauth",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: {
						name: "run_tedi_turn",
						arguments: { secretCustomerPrompt: "must-not-escape" },
					},
				}),
			});
			const waitUntil = vi.fn();

			await recordMcpAccessDenial({
				request,
				resolvedApp,
				env: { ENVIRONMENT: "production" } as CloudflareEnv,
				ctx: { waitUntil } as unknown as ExecutionContext,
				reason,
				httpStatus: 403,
			});

			// No verified caller, or a throttled request: telemetry only.
			const unrecorded = [
				"authentication_required",
				"authentication_failed",
				"oauth_audience_not_configured",
				"rate_limited",
			].includes(reason);
			expect(appendChangeRecord).toHaveBeenCalledTimes(unrecorded ? 0 : 1);
			if (!unrecorded)
				expect(appendChangeRecord).toHaveBeenCalledWith(
					expect.objectContaining({
						operation: "run_tedi_turn",
						outcome: "denied",
						actor: expect.objectContaining({ organizationId: "org-1" }),
						decision: expect.objectContaining({
							gate: "edge_access",
							reason,
						}),
					}),
				);
			expect(JSON.stringify(appendChangeRecord.mock.calls)).not.toContain(
				"must-not-escape",
			);
			expect(trackMcpEvent).toHaveBeenCalledTimes(1);
			const event = trackMcpEvent.mock.calls[0]?.[1];
			expect(event).toMatchObject({
				eventType: "access_denied",
				toolName: "run_tedi_turn",
				errorCode: reason,
				success: false,
				metadata: {
					gate: "edge_access",
					gateDecision: "deny",
					gateReason: reason,
					denialReason: reason,
					httpStatus: 403,
					mcpMethod: "tools/call",
				},
			});
			expect(JSON.stringify(event)).not.toContain("must-not-escape");
			expect(emitMcpAuditEvent).toHaveBeenCalledTimes(1);
		},
	);

	it.each([
		[-32_020, "protocol_header_mismatch"],
		[-32_021, "missing_client_capability"],
		[-32_022, "unsupported_protocol_version"],
	] as const)("classifies protocol error %i", async (code, expected) => {
		const response = new Response(
			JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code } }),
			{ status: 400 },
		);
		await expect(classifyProtocolDenial(response)).resolves.toBe(expected);
	});

	it("ignores ordinary handler failures", async () => {
		const response = new Response(
			JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32_000 } }),
			{ status: 400 },
		);
		await expect(classifyProtocolDenial(response)).resolves.toBeNull();
	});
});
