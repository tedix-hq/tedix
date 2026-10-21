import { describe, expect, it, vi } from "vite-plus/test";
import { builtinToolPolicyMetadata } from "@tedix/api-contract/utils/approval-policy";
import {
	callToolResultText,
	requireDestructiveToolApproval,
} from "./governance";
import type { ServerContext } from "./server-context";

function context() {
	return {
		server: { server: { elicitInput: vi.fn() } },
		app: { organizationId: "example-org" },
		appSlug: "example-unified",
		callerIdentity: {
			authType: "external_agent",
			organizationId: "example-org",
			externalAgentPrincipalId: "example-agent",
			externalAgentSessionId: "example-session",
			externalAgentClientRecordId: "example-client",
		},
		apiClient: {
			mcpGovernance: {
				resolveAgentTransportPolicy: vi.fn(async () => ({
					autonomy: { version: 1, maxRisk: "medium" },
				})),
			},
		},
	} as unknown as ServerContext;
}

const tool = {
	toolId: "external__end_external_agent_session",
	title: "End external agent session",
	config: { transport: "rpc", endpoint: "externalAgentIdentity/endSession" },
};
const args = {
	organizationId: "example-org",
	principalId: "example-agent",
	sessionId: "example-session",
};

describe("verified own-session shutdown", () => {
	it.each([false, true])(
		"allows own shutdown under standing consent (metadata: %s)",
		async (metadata) => {
			const ctx = context();
			expect(
				await requireDestructiveToolApproval(
					ctx,
					{
						...tool,
						...(metadata
							? {
									meta: {
										"com.tedix/policy": builtinToolPolicyMetadata(
											"end_external_agent_session",
										)!,
									},
								}
							: {}),
					},
					{ destructiveHint: true },
					{ args },
				),
			).toBeNull();
			expect(ctx.server.server.elicitInput).not.toHaveBeenCalled();
		},
	);

	it.each([
		{ principalId: "other-agent" },
		{ sessionId: "another-session-of-the-same-agent" },
		{ organizationId: "other-org" },
	])("requires human approval for a different target: %j", async (target) => {
		const result = await requireDestructiveToolApproval(
			context(),
			tool,
			{ destructiveHint: true },
			{ args: { ...args, ...target } },
		);
		expect(result?.isError).toBe(true);
		expect(callToolResultText(result!)).toContain("Human approval required");
	});

	it("keeps another session gated even without a destructive annotation", async () => {
		const result = await requireDestructiveToolApproval(
			context(),
			tool,
			{ destructiveHint: false },
			{ args: { ...args, sessionId: "other-session" } },
		);
		expect(result?.isError).toBe(true);
		expect(callToolResultText(result!)).toContain("Human approval required");
	});

	it.each([
		"externalAgentPrincipalId",
		"externalAgentSessionId",
		"externalAgentClientRecordId",
		"organizationId",
	] as const)("requires verified %s", async (field) => {
		const ctx = context();
		delete ctx.callerIdentity![field];
		const result = await requireDestructiveToolApproval(
			ctx,
			tool,
			{ destructiveHint: true },
			{ args },
		);
		expect(result?.isError).toBe(true);
	});

	it.each(["oauth", "service", "tedi"] as const)(
		"does not trust session-shaped metadata from %s",
		async (authType) => {
			const ctx = context();
			ctx.callerIdentity!.authType = authType;
			const result = await requireDestructiveToolApproval(
				ctx,
				tool,
				{ destructiveHint: true },
				{ args, extra: { _meta: { agentSession: "example-session" } } },
			);
			expect(result?.isError).toBe(true);
		},
	);

	it("retains an explicit always-ask policy for own shutdown", async () => {
		const result = await requireDestructiveToolApproval(
			context(),
			{ ...tool, config: { ...tool.config, approvalPolicy: "always" } },
			{ destructiveHint: true },
			{ args },
		);
		expect(result?.isError).toBe(true);
	});

	it("does not lower risk on another route", async () => {
		const result = await requireDestructiveToolApproval(
			context(),
			{
				...tool,
				config: {
					...tool.config,
					endpoint: "externalAgentIdentity/retireAbandonedSession",
				},
			},
			{ destructiveHint: true },
			{ args },
		);
		expect(result?.isError).toBe(true);
	});
});
