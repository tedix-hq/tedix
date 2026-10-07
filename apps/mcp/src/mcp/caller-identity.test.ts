import { describe, expect, it } from "vite-plus/test";
import {
	buildCallerAuditMetadata,
	normalizeCallerIdentity,
	shouldBypassCodeModeForCaller,
} from "./caller-identity";

describe("configured direct transport eligibility", () => {
	const row = {
		toolId: "get_work",
		enabled: true,
		config: { nativeDirect: true },
	};
	it.each([
		"user",
		"m2m",
		"tedi",
		"service",
		"apiKey",
		"oauth",
		"external_agent",
	] as const)(
		"uses exact configured opt-in for validated %s callers",
		(authType) => {
			expect(
				shouldBypassCodeModeForCaller({ authType }, "get_work", [row]),
			).toBe(true);
			expect(
				shouldBypassCodeModeForCaller(
					{ authType, forceCodeMode: true },
					"get_work",
					[row],
				),
			).toBe(false);
		},
	);
	it("refuses anonymous, absent, duplicate, disabled and wrong configured rows", () => {
		expect(
			shouldBypassCodeModeForCaller({ authType: "anonymous" }, "get_work", [
				row,
			]),
		).toBe(false);
		expect(shouldBypassCodeModeForCaller(undefined, "get_work", [row])).toBe(
			false,
		);
		for (const rows of [
			[],
			[row, row],
			[{ ...row, enabled: false }],
			[{ ...row, toolId: "other" }],
			[{ ...row, config: { nativeDirect: "true" } }],
		]) {
			expect(
				shouldBypassCodeModeForCaller({ authType: "oauth" }, "get_work", rows),
			).toBe(false);
		}
		expect(
			shouldBypassCodeModeForCaller({ authType: "oauth" }, "code", [row]),
		).toBe(false);
	});
});

describe("caller identity normalization", () => {
	it("treats tedi callers as delegated agent actors", () => {
		const normalized = normalizeCallerIdentity({
			authType: "tedi",
			userId: "descope-user-1",
			tediId: "tedi-1",
			clientId: "client-1",
			scopes: ["mcp:tools.call", "mcp:prompts.read"],
		});

		expect(normalized).toMatchObject({
			actorId: "tedi-1",
			actorType: "tedi",
			delegationMode: "agent",
			agentTediId: "tedi-1",
			oauthClientId: "client-1",
			grantedScopeCount: 2,
		});
		expect(normalized.subjectUserId).toBeUndefined();
	});

	it("keeps external agents separate from tedis and humans", () => {
		const normalized = normalizeCallerIdentity({
			authType: "external_agent",
			externalAgentPrincipalId: "principal-1",
			externalAgentSessionId: "session-1",
			externalAgentClientRecordId: "client-record-1",
			externalAgentHarness: "codex",
			externalAgentModel: "openai:gpt-5:2026-07-20",
			credentialMode: "aih-m2m",
			scopes: ["platform:admin"],
		});
		expect(normalized).toMatchObject({
			actorId: "principal-1",
			actorType: "external_agent",
			delegationMode: "machine_to_machine",
			externalAgentSessionId: "session-1",
			externalAgentClientRecordId: "client-record-1",
		});
		expect(normalized.agentTediId).toBeUndefined();
		expect(
			buildCallerAuditMetadata({
				authType: "external_agent",
				externalAgentPrincipalId: "principal-1",
				externalAgentSessionId: "session-1",
				externalAgentClientRecordId: "client-record-1",
				externalAgentHarness: "codex",
				externalAgentModel: "openai:gpt-5:2026-07-20",
				scopes: [],
			}),
		).toMatchObject({
			externalAgentPrincipalId: "principal-1",
			externalAgentSessionId: "session-1",
			externalAgentClientRecordId: "client-record-1",
			externalAgentHarness: "codex",
		});
	});

	it("marks oauth callers with a resolved tedi as human-to-tedi delegation", () => {
		expect(
			buildCallerAuditMetadata({
				authType: "oauth",
				userId: "human-1",
				tediId: "tedi-1",
				scopes: [],
			}),
		).toEqual({
			agentTediId: "tedi-1",
			subjectUserId: "human-1",
			delegationMode: "human_to_tedi",
			grantedScopeCount: 0,
		});
	});

	it("treats oauth callers WITHOUT a resolved tedi as the human principal", () => {
		// This is the bindHumanToTedi=false path: no tedi binding means the human
		// stays the acting principal (actorType "user") with their own scopes,
		// rather than being demoted to subject of a delegated tedi.
		const normalized = normalizeCallerIdentity({
			authType: "oauth",
			userId: "human-1",
			clientId: "https://claude.ai/oauth/mcp-oauth-client-metadata",
			scopes: ["mcp:messaging", "mcp:observe"],
		});

		expect(normalized).toMatchObject({
			actorId: "human-1",
			actorType: "user",
			delegationMode: "oauth",
			subjectUserId: "human-1",
			grantedScopeCount: 2,
		});
		expect(normalized.agentTediId).toBeUndefined();

		expect(
			buildCallerAuditMetadata({
				authType: "oauth",
				userId: "human-1",
				scopes: [],
			}),
		).toMatchObject({
			subjectUserId: "human-1",
			delegationMode: "oauth",
		});
	});

	it("maps kernel service callers to the kernel actor with the acting human as actorId", () => {
		const normalized = normalizeCallerIdentity({
			authType: "service",
			userId: "human-1",
			organizationId: "org-1",
			kernel: true,
			scopes: [],
		});

		expect(normalized).toMatchObject({
			authType: "service",
			actorId: "human-1",
			actorType: "kernel",
			delegationMode: "kernel",
			subjectUserId: "human-1",
		});
		// No fake tedi identity: the acting user is never conflated into tediId.
		expect(normalized.agentTediId).toBeUndefined();
	});

	it("falls back to the literal kernel actorId when no acting user initiated the turn", () => {
		const normalized = normalizeCallerIdentity({
			authType: "service",
			kernel: true,
			scopes: [],
		});

		expect(normalized).toMatchObject({
			actorId: "kernel",
			actorType: "kernel",
			delegationMode: "kernel",
		});
		expect(normalized.subjectUserId).toBeUndefined();
	});

	it("keeps plain service callers (no kernel flag) as service actors", () => {
		expect(
			normalizeCallerIdentity({
				authType: "service",
				userId: "human-1",
				scopes: [],
			}),
		).toMatchObject({
			actorId: "human-1",
			actorType: "service",
			delegationMode: "service",
		});
	});

	it("includes kernel delegationMode in audit metadata", () => {
		expect(
			buildCallerAuditMetadata({
				authType: "service",
				userId: "human-1",
				kernel: true,
				scopes: [],
			}),
		).toEqual({
			subjectUserId: "human-1",
			delegationMode: "kernel",
			grantedScopeCount: 0,
		});
	});

	it("includes trusted workflow execution provenance in audit metadata", () => {
		expect(
			buildCallerAuditMetadata({
				authType: "service",
				scopes: [],
				skillRunId: "run-1",
				skillId: "skill-1",
				workflowStepId: "step-1",
				workflowStepName: "fetch offers",
				workflowStepCount: 2,
				workflowStepAttempt: 3,
				workflowCallId: "call-1",
				workflowIdempotencyKey: "idem-1",
			}),
		).toMatchObject({
			skillRunId: "run-1",
			skillId: "skill-1",
			workflowStepId: "step-1",
			workflowStepName: "fetch offers",
			workflowStepCount: 2,
			workflowStepAttempt: 3,
			workflowCallId: "call-1",
			workflowIdempotencyKey: "idem-1",
		});
	});

	it("routes programmatic MCP callers to the expected Code Mode shape", () => {
		expect(
			shouldBypassCodeModeForCaller({
				authType: "service",
			}),
		).toBe(false);
		expect(
			shouldBypassCodeModeForCaller({
				authType: "tedi",
				credentialMode: "aih-m2m",
			}),
		).toBe(false);
		expect(
			shouldBypassCodeModeForCaller(
				{
					authType: "service",
				},
				"cpo__get_tedi_runtime_status",
			),
		).toBe(true);
		expect(
			shouldBypassCodeModeForCaller({
				authType: "service",
				forceCodeMode: true,
			}),
		).toBe(false);
		expect(
			shouldBypassCodeModeForCaller(
				{
					authType: "service",
				},
				"code",
			),
		).toBe(false);
	});
});

describe("configured tool dispatch", () => {
	it.each(["execute_muscle_code", "save_muscle_code"])(
		"routes %s through ordinary service tool dispatch",
		(name) => {
			expect(shouldBypassCodeModeForCaller({ authType: "service" }, name)).toBe(
				true,
			);
		},
	);
});
