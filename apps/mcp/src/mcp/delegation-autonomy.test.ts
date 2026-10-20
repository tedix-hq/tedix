import { describe, expect, it, vi } from "vite-plus/test";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	requireDestructiveToolApproval,
	callToolResultText,
} from "./governance";
import type { ServerContext } from "./server-context";
import { buildAggregateTediTools } from "./aggregate-tedis";

function context(autonomy = true) {
	return {
		server: { server: { elicitInput: vi.fn() } },
		callerIdentity: { authType: "tedi", tediId: "tedi" },
		appSlug: "work",
		app: { organizationId: "org" },
		apiClient: {
			mcpGovernance: {
				resolveAgentTransportPolicy: vi.fn(async () => ({
					requireExplicitApprovalPolicy: false,
					...(autonomy ? { autonomy: { version: 1, maxRisk: "medium" } } : {}),
				})),
				resolveToolApprovalGrant: vi.fn(async () => ({
					approved: false,
					grantId: null,
				})),
			},
		},
	} as unknown as Pick<ServerContext, "server">;
}
describe("tedi autonomous actions", () => {
	it.each([
		[true, "once", true],
		[true, "always", false],
		[false, "once", true],
		[false, "always", false],
	] as const)(
		"bounded writes use standing consent=%s over %s, independently of self-confirm=%s",
		async (autonomy, approvalPolicy, autoConfirmAgent) => {
			const result = await requireDestructiveToolApproval(
				context(autonomy),
				{
					toolId: "add_comment",
					title: "Add comment",
					config: { transport: "rpc", approvalPolicy },
					meta: {
						"com.tedix/policy": {
							riskTier: "bounded_write",
							blastRadius: "single_resource",
						},
					},
				},
				{ destructiveHint: false },
				{ autoConfirmAgent },
			);
			if (autonomy) expect(result).toBeNull();
			else expect(result?.isError).toBe(true);
		},
	);
	it.each([
		"send_email",
		"publish_content",
		"delete_records",
		"grant_role",
		"increase_budget",
		"oauth_consent",
	])(
		"never self-confirms critical %s even with a low/medium declaration or confirmDestructive",
		async (toolId) => {
			const result = await requireDestructiveToolApproval(
				context(),
				{
					toolId,
					title: "Critical action",
					config: { transport: "rpc" },
					meta: {
						"com.tedix/policy": {
							riskTier: "bounded_write",
							blastRadius: "single_resource",
						},
					},
				},
				{ readOnlyHint: false, destructiveHint: false },
				{
					autoConfirmAgent: true,
					args: { confirmDestructive: true, reason: "agent says approved" },
				},
			);
			expect(result?.isError).toBe(true);
			expect(callToolResultText(result!)).toContain("Human approval required");
		},
	);
	it("retains human approval for high and unclassified writes", async () => {
		for (const meta of [
			{
				"com.tedix/policy": {
					riskTier: "high_impact_write",
					blastRadius: "tenant",
				},
			},
			{},
		] as Array<Record<string, JsonValue>>) {
			const result = await requireDestructiveToolApproval(
				context(),
				{
					toolId: "run_operation",
					title: "Run operation",
					config: { transport: "rpc" },
					meta,
				},
				{ destructiveHint: true },
				{ autoConfirmAgent: true },
			);
			expect(result?.isError).toBe(true);
		}
	});
});

it.each<{
	destructiveHint: boolean;
	config: Record<string, JsonValue>;
	meta: Record<string, JsonValue>;
}>([
	{
		destructiveHint: true,
		config: { transport: "rpc" as const },
		meta: {
			"com.tedix/policy": {
				riskTier: "bounded_write",
				blastRadius: "single_resource",
			},
		},
	},
	{ destructiveHint: false, config: { transport: "rpc" as const }, meta: {} },
	{
		destructiveHint: false,
		config: { transport: "rpc" as const, approvalPolicy: "work_item" as const },
		meta: {
			"com.tedix/policy": {
				riskTier: "bounded_write",
				blastRadius: "single_resource",
			},
		},
	},
])(
	"never lets org autonomy bypass destructive, unknown or Work-authorization gates",
	async ({ destructiveHint, config, meta }) => {
		const result = await requireDestructiveToolApproval(
			context(),
			{ toolId: "add_comment", title: "Comment", config, meta },
			{ readOnlyHint: false, destructiveHint },
			{ autoConfirmAgent: true },
		);
		expect(result?.isError).toBe(true);
	},
);
it("auto-approves explicitly classified bounded writes without a stricter gate", async () => {
	expect(
		await requireDestructiveToolApproval(
			context(),
			{
				toolId: "add_comment",
				title: "Comment",
				config: { transport: "rpc" },
				meta: {
					"com.tedix/policy": {
						riskTier: "bounded_write",
						blastRadius: "single_resource",
					},
				},
			},
			{ destructiveHint: false },
			{ autoConfirmAgent: true },
		),
	).toBeNull();
});

describe("generated tools under org standing consent", () => {
	const tools = buildAggregateTediTools(
		[
			{
				slug: "echo",
				runtimeKind: "agent",
				tediId: "tedi",
				organizationId: "org",
			},
		],
		{ MCP_URL: "https://mcp.example.test" } as CloudflareEnv,
	);
	it("auto-approves the real bounded Work-comment binding", async () => {
		const tool = tools.find(
			(candidate) => candidate.toolId === "echo__work_item_comment",
		)!;
		expect(tool).toBeDefined();
		expect(
			await requireDestructiveToolApproval(context(), tool, tool.annotations),
		).toBeNull();
	});
	it.each(["email_send", "reconcile_work_item_sources"])(
		"does not let preview or confirmation arguments authorize %s",
		async (name) => {
			const tool = tools.find(
				(candidate) => candidate.toolId === `echo__${name}`,
			)!;
			expect(tool).toBeDefined();
			const result = await requireDestructiveToolApproval(
				context(),
				tool,
				tool.annotations,
				{
					autoConfirmAgent: true,
					allowSyncMrtr: false,
					args: {
						dryRun: true,
						confirmDestructive: true,
						reason: "agent request",
					},
				},
			);
			expect(result?.isError).toBe(true);
		},
	);
});

it.each([true, false])(
	"preview and confirmation arguments cannot create authority (autonomy=%s)",
	async (autonomy) => {
		for (const [toolId, config] of [
			["add_comment", { transport: "rpc", approvalPolicy: "always" }],
			["stripe:create_checkout_session", { transport: "rpc" }],
			["linkedin:create_post", { transport: "rpc" }],
		] as Array<[string, Record<string, JsonValue>]>) {
			const result = await requireDestructiveToolApproval(
				context(autonomy),
				{
					toolId,
					title: toolId,
					config,
					meta: {
						"com.tedix/policy": {
							riskTier: "bounded_write",
							blastRadius: "single_resource",
						},
					},
				},
				{ destructiveHint: false, readOnlyHint: false },
				{
					autoConfirmAgent: true,
					args: {
						dryRun: true,
						confirmDestructive: true,
						reason: "agent-supplied preview claim",
					},
				},
			);
			if (autonomy && toolId === "add_comment") expect(result).toBeNull();
			else {
				expect(result).not.toBeNull();
				if (config.approvalPolicy === "always")
					expect(result?.isError).toBe(true);
			}
		}
	},
);

it("never approval policy still allows a classified, non-destructive bounded write", async () => {
	expect(
		await requireDestructiveToolApproval(
			context(),
			{
				toolId: "add_comment",
				title: "Comment",
				config: { transport: "rpc", approvalPolicy: "never" },
				meta: {
					"com.tedix/policy": {
						riskTier: "bounded_write",
						blastRadius: "single_resource",
					},
				},
			},
			{ destructiveHint: false },
			{ autoConfirmAgent: true },
		),
	).toBeNull();
});

it.each([true, false])(
	"unknown write risk cannot self-confirm (autonomy=%s)",
	async (autonomy) => {
		const result = await requireDestructiveToolApproval(
			context(autonomy),
			{
				toolId: "run_operation",
				title: "Operation",
				config: { transport: "rpc" },
			},
			{ destructiveHint: false, readOnlyHint: false },
			{
				allowSyncMrtr: false,
				autoConfirmAgent: true,
				args: {
					dryRun: true,
					confirmDestructive: true,
					reason: "agent assertion",
				},
			},
		);
		expect(result?.isError).toBe(true);
	},
);
it("retains bounded legacy writes with explicit risk metadata", async () => {
	expect(
		await requireDestructiveToolApproval(
			context(false),
			{
				toolId: "add_comment",
				title: "Comment",
				config: { transport: "rpc" },
				meta: {
					"com.tedix/policy": {
						riskTier: "bounded_write",
						blastRadius: "single_resource",
					},
				},
			},
			{ destructiveHint: false, readOnlyHint: false },
			{ autoConfirmAgent: true },
		),
	).toBeNull();
});
