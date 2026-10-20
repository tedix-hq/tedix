import { describe, expect, it, vi } from "vite-plus/test";
import {
	requireDestructiveToolApproval,
	callToolResultText,
} from "./governance";
import { buildHomeSurfaceTools } from "./home-surface-tools";
import type { ServerContext } from "./server-context";
import {
	MCP_CLIENT_CAPABILITIES_META_KEY,
	MCP_TASKS_EXTENSION,
} from "@tedix/mcp-shared/protocol";

function context(authType = "external_agent") {
	return {
		server: { server: { elicitInput: vi.fn() } },
		callerIdentity:
			authType === "oauth" ? { authType, userId: "owner" } : { authType },
		app: { organizationId: "example-org" },
		appSlug: "example",
		apiClient: {
			mcpGovernance: {
				resolveAgentTransportPolicy: vi.fn(async () => ({
					autonomy: { version: 1, maxRisk: "medium" },
				})),
				resolveToolApprovalGrant: vi.fn(async () => ({
					approved: false,
					grantId: null,
				})),
			},
		},
	} as unknown as ServerContext;
}

const extra = {
	_meta: {
		[MCP_CLIENT_CAPABILITIES_META_KEY]: {
			extensions: { [MCP_TASKS_EXTENSION]: {} },
		},
	},
};
const approval = buildHomeSurfaceTools().find(
	(t) => t.toolId === "home__respond_home_approval",
)!;
const notion = {
	toolId: "notion_update_page",
	title: "Update page",
	config: {
		transport: "mcp",
		mcpToolName: "notion-update-page",
		auth: { type: "connection", connectionId: "notion" },
	},
	meta: {
		"com.tedix/policy": {
			riskTier: "bounded_write",
			blastRadius: "single_resource",
			argumentPolicy: "notion_page_update",
		},
	},
};

describe("authorized bounded writes", () => {
	it("lets a signed-in human answer a Home approval on a task-capable CLI", async () => {
		const ctx = context("oauth");
		expect(
			await requireDestructiveToolApproval(
				ctx,
				approval,
				approval.annotations,
				{ extra },
			),
		).toBeNull();
		expect(
			ctx.apiClient.mcpGovernance.resolveAgentTransportPolicy,
		).not.toHaveBeenCalled();
	});
	it.each(["external_agent", "tedi", "service"])(
		"does not let %s self-approve Home",
		async (authType) => {
			expect(
				(
					await requireDestructiveToolApproval(
						context(authType),
						approval,
						approval.annotations,
						{ extra },
					)
				)?.isError,
			).toBe(true);
		},
	);
	it.each(["once", "always", "work_item"])(
		"preserves explicit %s approval policy",
		async (approvalPolicy) => {
			expect(
				(
					await requireDestructiveToolApproval(
						context("oauth"),
						{ ...approval, config: { ...approval.config, approvalPolicy } },
						approval.annotations,
						{ extra },
					)
				)?.isError,
			).toBe(true);
		},
	);
	it("classifies Home Work cancellation as a bounded history-preserving write", async () => {
		const cancel = buildHomeSurfaceTools().find(
			(t) => t.toolId === "home__cancel_work_item",
		)!;
		expect(
			await requireDestructiveToolApproval(
				context(),
				cancel,
				cancel.annotations,
				{ args: { id: "example", reason: "User requested closure" } },
			),
		).toBeNull();
	});
	it.each([
		{
			page_id: "example",
			command: "update_properties",
			properties: { Status: "Done" },
		},
		{
			page_id: "example",
			command: "insert_content",
			content: "Close-out note",
		},
	])("permits reviewed Notion page edits: %j", async (args) => {
		expect(
			await requireDestructiveToolApproval(
				context(),
				notion,
				{ destructiveHint: true },
				{ args },
			),
		).toBeNull();
	});
	it.each([
		{ page_id: "example", command: "replace_content", content: "Overwrite" },
		{
			page_id: "example",
			command: "update_properties",
			properties: {},
			archived: true,
		},
		{
			page_id: "example",
			command: "update_content",
			content_updates: [{ old_str: "old", new_str: "" }],
			allow_deleting_content: true,
		},
		{ page_id: "example", command: "future_unknown_command" },
	])(
		"keeps destructive and unknown Notion commands gated: %j",
		async (args) => {
			const result = await requireDestructiveToolApproval(
				context(),
				notion,
				{ destructiveHint: true },
				{ args },
			);
			expect(result?.isError).toBe(true);
			expect(callToolResultText(result!)).toContain("Human approval required");
		},
	);
	it("does not apply a Notion policy to another configured provider", async () => {
		const result = await requireDestructiveToolApproval(
			context(),
			{
				...notion,
				config: {
					...notion.config,
					auth: { type: "connection", connectionId: "other" },
				},
			},
			{ destructiveHint: true },
			{
				args: {
					page_id: "example",
					command: "update_properties",
					properties: {},
				},
			},
		);
		expect(result?.isError).toBe(true);
	});
	it("leaves unreviewed Notion writes gated", async () => {
		expect(
			(
				await requireDestructiveToolApproval(
					context(),
					{ ...notion, meta: {} },
					{ destructiveHint: true },
					{
						args: {
							page_id: "example",
							command: "update_properties",
							properties: {},
						},
					},
				)
			)?.isError,
		).toBe(true);
	});
});
