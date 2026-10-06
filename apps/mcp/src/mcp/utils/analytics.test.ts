import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const createEvent = vi.fn();
const recordVerifiedMcpExecution = vi.fn();

vi.mock("../../lib/api-client", () => ({
	getApiClient: vi.fn(() => ({
		audit: { createEvent },
		externalAgentIdentity: { recordVerifiedMcpExecution },
	})),
}));

import { getApiClient } from "../../lib/api-client";

import {
	buildCallerTelemetryFields,
	emitMcpAuditEvent,
	type McpEvent,
	mergeMcpMetadata,
	normalizeMcpErrorCode,
	truncateErrorMessage,
} from "./analytics";

function baseEvent(overrides: Partial<McpEvent>): McpEvent {
	return {
		timestamp: "2026-05-18T15:38:05.000Z",
		eventType: "tool_call",
		appId: "app-1",
		appSlug: "acme-unified",
		organizationId: "org-1",
		toolName: "acme-api-acme__ccm_v7_quotas_list",
		success: true,
		durationMs: 42,
		...overrides,
	};
}

const serviceFetch = { fetch: vi.fn() } as unknown as Fetcher;

async function emit(event: McpEvent) {
	const pending: Promise<unknown>[] = [];
	emitMcpAuditEvent(
		{ API_SERVICE: serviceFetch } as unknown as CloudflareEnv,
		event,
		(promise) => pending.push(promise),
	);
	await Promise.all(pending);
}

describe("MCP audit actor mapping", () => {
	beforeEach(() => {
		vi.mocked(getApiClient).mockClear();
		createEvent.mockReset();
		recordVerifiedMcpExecution.mockReset();
	});

	it("emits through the service binding without an API URL", async () => {
		await emit(baseEvent({ authType: "oauth", userId: "user-1" }));
		expect(getApiClient).toHaveBeenCalledWith({
			serviceFetch,
			orgId: "org-1",
		});
		expect(createEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "org-1",
				actorId: "user-1",
				action: "mcp.tool.execute",
			}),
		);
	});

	it.each([{ appId: undefined }, { organizationId: undefined }])(
		"does not emit without event ownership: %j",
		async (missing) => {
			await emit(baseEvent(missing));
			expect(getApiClient).not.toHaveBeenCalled();
			expect(createEvent).not.toHaveBeenCalled();
			expect(recordVerifiedMcpExecution).not.toHaveBeenCalled();
		},
	);

	it("keeps client construction failures non-blocking", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.mocked(getApiClient).mockImplementationOnce(() => {
			throw new Error("Service binding unavailable");
		});
		try {
			await expect(emit(baseEvent({}))).resolves.toBeUndefined();
			expect(error).toHaveBeenCalled();
			expect(createEvent).not.toHaveBeenCalled();
		} finally {
			error.mockRestore();
		}
	});

	it("records AIH tedi M2M calls as tedi actors, not human users", async () => {
		await emit(
			baseEvent({
				authType: "tedi",
				userId: "TPA3Du4US8AKCN0AM3YQz29X3ePIQ0",
				clientId: "encoded-client-id",
			}),
		);

		expect(createEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				actorId: "TPA3Du4US8AKCN0AM3YQz29X3ePIQ0",
				actorType: "tedi",
				action: "mcp.tool.execute",
			}),
		);
	});

	it("keeps human OAuth calls as user actors", async () => {
		await emit(
			baseEvent({
				authType: "oauth",
				userId: "U-human",
				clientId: "oauth-client",
			}),
		);

		expect(createEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				actorId: "U-human",
				actorType: "user",
			}),
		);
	});

	it("records external agents under their stable principal and execution session", async () => {
		await emit(
			baseEvent({
				authType: "external_agent",
				executionId: "execution-1",
				metadata: {
					externalAgentPrincipalId: "00000000-0000-4000-8000-000000000002",
					externalAgentSessionId: "00000000-0000-4000-8000-000000000003",
					externalAgentClientRecordId: "aih-client-record-1",
					externalAgentHarness: "codex",
				},
			}),
		);

		expect(createEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				actorId: "00000000-0000-4000-8000-000000000002",
				actorType: "external_agent",
			}),
		);
		expect(recordVerifiedMcpExecution).toHaveBeenCalledWith(
			expect.objectContaining({
				principalId: "00000000-0000-4000-8000-000000000002",
				sessionId: "00000000-0000-4000-8000-000000000003",
				clientRecordId: "aih-client-record-1",
				occurredAt: "2026-05-18T15:38:05.000Z",
				targetId: "execution-1:tool_call:acme-api-acme__ccm_v7_quotas_list",
			}),
		);
	});

	it("uses service actor metadata for infrastructure calls", async () => {
		await emit(baseEvent({ authType: "service", clientId: "mcp-service" }));

		expect(createEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				actorId: "mcp-service",
				actorType: "service",
			}),
		);
	});

	it("records kernel calls as kernel actors with the acting human as actorId", async () => {
		await emit(
			baseEvent({
				authType: "service",
				userId: "U-human",
				metadata: buildCallerTelemetryFields({
					authType: "service",
					userId: "U-human",
					kernel: true,
					scopes: [],
				}).metadata,
			}),
		);

		expect(createEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				actorId: "U-human",
				actorType: "kernel",
				metadata: expect.objectContaining({
					delegationMode: "kernel",
					subjectUserId: "U-human",
				}),
			}),
		);
	});

	it("falls back to the literal kernel actorId for unattended kernel calls", async () => {
		await emit(
			baseEvent({
				authType: "service",
				metadata: { delegationMode: "kernel", grantedScopeCount: 0 },
			}),
		);

		expect(createEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				actorId: "kernel",
				actorType: "kernel",
			}),
		);
	});

	it("emits resource_read audit rows with stable resource identity", async () => {
		const event = baseEvent({
			eventType: "resource_read",
			authType: "oauth",
			userId: "U-human",
			success: true,
			metadata: {
				resourceUri: "ui://widgets/mcp-app/tedix/r/abc.html",
				resourceType: "mcp-app",
			},
		});
		delete event.toolName;
		await emit(event);

		expect(createEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "mcp.resource.read",
				resourceType: "mcp_resource",
				resourceId: "ui://widgets/mcp-app/tedix/r/abc.html",
			}),
		);
	});

	it("records pre-dispatch security decisions as request denials", async () => {
		await emit(
			baseEvent({
				eventType: "access_denied",
				authType: "oauth",
				userId: "U-human",
				toolName: "tools/call",
				success: false,
				errorCode: "insufficient_scope",
				metadata: {
					denialReason: "insufficient_scope",
					httpStatus: 403,
					mcpMethod: "tools/call",
				},
			}),
		);

		expect(createEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "mcp.access.denied",
				actorId: "U-human",
				actorType: "user",
				resourceType: "mcp_request",
				resourceId: "tools/call",
				metadata: expect.objectContaining({
					denialReason: "insufficient_scope",
					httpStatus: 403,
					mcpMethod: "tools/call",
				}),
			}),
		);
	});
});

describe("MCP caller telemetry helpers", () => {
	it("redacts credentials embedded in ordinary error strings before telemetry", () => {
		const message = truncateErrorMessage(
			"upstream rejected Authorization: Bearer eyJabcdefghijk.abcdefghijk.abcdefghijk and key ghp_12345678901234567890",
		);
		expect(message).not.toContain("eyJabcdefghijk");
		expect(message).not.toContain("ghp_");
		expect(message).toContain("[REDACTED]");
	});

	it("normalizes error constructors without inspecting the message", () => {
		const error = new Error("customer@example.com secret body");
		error.name = "OAuthTokenExchangeError";
		expect(normalizeMcpErrorCode(error)).toBe("OAUTH_TOKEN_EXCHANGE_ERROR");
		expect(normalizeMcpErrorCode(new Error("raw body"))).toBe(
			"UNHANDLED_ERROR",
		);
		expect(normalizeMcpErrorCode("raw body")).toBe("UNKNOWN_ERROR");
	});

	it("normalizes caller fields and metadata for non-tool events", () => {
		const callerFields = buildCallerTelemetryFields({
			authType: "tedi",
			userId: "U-tedi",
			tediId: "T-1",
			clientId: "client-1",
			scopes: ["mcp:observe.read"],
		});

		expect(callerFields).toMatchObject({
			userId: "U-tedi",
			tediId: "T-1",
			clientId: "client-1",
			authType: "tedi",
			registrationMethod: "pre_registered",
			metadata: {
				delegationMode: "agent",
				agentTediId: "T-1",
				oauthClientId: "client-1",
				grantedScopeCount: 1,
				registrationMethod: "pre_registered",
			},
		});
		expect(callerFields.metadata).not.toHaveProperty("subjectUserId");
	});

	it("labels CIMD and DCR OAuth cohorts", () => {
		expect(
			buildCallerTelemetryFields({
				authType: "oauth",
				clientId: "https://claude.ai/oauth/mcp-oauth-client-metadata",
			}),
		).toMatchObject({ registrationMethod: "cimd" });
		expect(
			buildCallerTelemetryFields({
				authType: "oauth",
				clientId: "dcr-client-1",
			}),
		).toMatchObject({ registrationMethod: "dcr" });
	});

	it("merges caller metadata with resource context", () => {
		expect(
			mergeMcpMetadata(
				{ delegationMode: "agent", grantedScopeCount: 1 },
				{ resourceType: "skill", skillId: "skill-1" },
			),
		).toEqual({
			delegationMode: "agent",
			grantedScopeCount: 1,
			resourceType: "skill",
			skillId: "skill-1",
		});
	});
});
