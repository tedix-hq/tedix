import { describe, expect, it, vi } from "vite-plus/test";
import { requireDestructiveToolApproval } from "./governance";
import type { ServerContext } from "./server-context";

const tool = {
	toolId: "home__cancel_home_run",
	title: "Stop Home run",
	config: { transport: "rpc", endpoint: "kernelRuntime/cancelRun" },
};

function context(startedBy: string | null = "user-1") {
	return {
		server: { server: { elicitInput: vi.fn() } },
		app: { organizationId: "example-org" },
		appSlug: "example-unified",
		callerIdentity: {
			authType: "oauth",
			userId: "user-1",
			organizationId: "example-org",
		},
		apiClient: {
			kernelRuntime: {
				readRun: vi.fn(async () => ({
					run: {
						id: "run-1",
						organizationId: "example-org",
						metadata: { redriveInput: { descopeUserId: startedBy } },
					},
				})),
			},
			mcpGovernance: {
				resolveAgentTransportPolicy: vi.fn(async () => ({
					autonomy: { version: 1, maxRisk: "medium" },
				})),
			},
		},
	} as unknown as ServerContext;
}

const annotations = { destructiveHint: true };
const options = { args: { runId: "run-1" } };

describe("own Home run cancellation", () => {
	it("does not ask for approval when the authenticated user owns the run", async () => {
		const ctx = context();
		expect(
			await requireDestructiveToolApproval(ctx, tool, annotations, options),
		).toBeNull();
		expect(ctx.apiClient.kernelRuntime.readRun).toHaveBeenCalledWith({
			organizationId: "example-org",
			runId: "run-1",
		});
		expect(ctx.server.server.elicitInput).not.toHaveBeenCalled();
	});

	it.each(["another-user", null])(
		"retains approval when the saved owner is %s",
		async (startedBy) => {
			expect(
				await requireDestructiveToolApproval(
					context(startedBy),
					tool,
					annotations,
					options,
				),
			).not.toBeNull();
		},
	);

	it("fails closed when ownership lookup fails", async () => {
		const ctx = context();
		vi.mocked(ctx.apiClient.kernelRuntime.readRun).mockRejectedValue(
			new Error("unavailable"),
		);
		expect(
			await requireDestructiveToolApproval(ctx, tool, annotations, options),
		).not.toBeNull();
	});

	it.each(["tedi", "external_agent", "service"] as const)(
		"does not accept user-shaped fields from %s",
		async (authType) => {
			const ctx = context();
			ctx.callerIdentity!.authType = authType;
			expect(
				await requireDestructiveToolApproval(ctx, tool, annotations, options),
			).not.toBeNull();
			expect(ctx.apiClient.kernelRuntime.readRun).not.toHaveBeenCalled();
		},
	);

	it("retains explicit approval policy even for the owner", async () => {
		expect(
			await requireDestructiveToolApproval(
				context(),
				{
					...tool,
					config: { ...tool.config, approvalPolicy: "always" },
				},
				annotations,
				options,
			),
		).not.toBeNull();
	});

	it("does not trust a different tenant supplied in arguments", async () => {
		const ctx = context();
		expect(
			await requireDestructiveToolApproval(ctx, tool, annotations, {
				args: { runId: "run-1", organizationId: "another-org" },
			}),
		).not.toBeNull();
		expect(ctx.apiClient.kernelRuntime.readRun).not.toHaveBeenCalled();
	});
});
