/**
 * Tedix OS audit emission, end to end through the real routers.
 *
 * Every assertion reads back through `getAuditEventsByResource` — the exact
 * query `audit.get_audit_by_resource` runs (three equality predicates: org,
 * resourceType, resourceId, no prefix or fallback) — so a row that this test
 * finds is a row the product surface finds, and a near-miss resourceType is a
 * red test rather than a silent zero.
 */

import { DatabaseSync } from "node:sqlite";
import { createRouterClient, implement } from "@orpc/server";
import { osWorkspacesContract } from "@tedix/api-contract/contracts/os-workspaces";
import { createDbClient } from "@tedix/db/client";
import { getAuditEventsByResource } from "@tedix/db/queries/audit";
import { auditEvents } from "@tedix/db/schema/audit-events";
import { osApprovalRules } from "@tedix/db/schema/os-approval-rules";
import { osShareLinks, osShareSessions } from "@tedix/db/schema/os-shares";
import {
	osBlueprintRevisions,
	osBlueprints,
	osCollaborationProposals,
	osGadgetExecutions,
	osGadgetRevisions,
	osGadgets,
	osOutputRevisions,
	osOutputs,
	osWorkspaces,
} from "@tedix/db/schema/os-workspaces";
import { userConfigs } from "@tedix/db/schema/user-configs";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { AUTHZ, type BaseContext, withAuth } from "../orpc";
import { osAudit } from "../os-audit";
import { osApprovalRulesContractRouter } from "./os-approval-rules";
import { osSharesContractRouter } from "./os-shares";
import { osWorkspacesContractRouter } from "./os-workspaces";

function createEnv(): CloudflareEnv {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(
		schemaDdl(
			osWorkspaces,
			osGadgets,
			osGadgetRevisions,
			osGadgetExecutions,
			osBlueprints,
			osBlueprintRevisions,
			osOutputs,
			osOutputRevisions,
			osCollaborationProposals,
			osShareLinks,
			osShareSessions,
			osApprovalRules,
			userConfigs,
			auditEvents,
		),
	);
	sqlite.exec(`
		CREATE TABLE organizations (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);
		INSERT INTO organizations (id, name)
			VALUES ('org-1', 'First Org'), ('org-2', 'Second Org');
	`);
	return {
		ENVIRONMENT: "test",
		API_URL: "https://api.tedix.test",
		DB: createD1Facade(sqlite),
	} as unknown as CloudflareEnv;
}

function baseContext(env: CloudflareEnv, organizationId: string): BaseContext {
	return {
		db: createDbClient(env.DB) as BaseContext["db"],
		env,
		headers: new Headers({
			"CF-Connecting-IP": "203.0.113.7",
			"User-Agent": "os-audit-test/1.0",
		}),
		organizationId,
		url: new URL("https://api.tedix.test/rpc/os-workspaces"),
	} as BaseContext;
}

function userContext(env: CloudflareEnv, organizationId: string): BaseContext {
	return {
		...baseContext(env, organizationId),
		authType: "user",
		user: {
			aud: "test",
			dct: "tenant-1",
			exp: 2,
			iat: 1,
			iss: "https://auth.tedix.test",
			permissions: ["settings:manage"],
			roles: [],
			sub: "user-1",
		},
	} as BaseContext;
}

function apiKeyContext(env: CloudflareEnv): BaseContext {
	return {
		...baseContext(env, "org-1"),
		apiKey: {
			id: "key-1",
			name: "ci",
			organizationId: "org-1",
			scopes: ["apps:read", "apps:write"],
		},
		authType: "apikey",
	} as BaseContext;
}

const TEDI_ID = "3f1a5e4c-0d0a-4f6f-9a3e-3c1d2b7a9f01";
const AGENT_PRINCIPAL_ID = "6d6f0f2c-6b1e-4c0c-8b6e-2f9f4f0f5a11";
const AGENT_SESSION_ID = "b1c1a3f8-1e2c-4a11-9c5e-7a1e5c9d2b33";

/**
 * A gateway call, resolved by the REAL `withAuth` service-binding branch from
 * the headers the MCP edge stamps — not by hand-setting the resolved fields,
 * which would prove nothing about what a live gateway write records.
 */
function gatewayContext(
	env: CloudflareEnv,
	headers: Record<string, string>,
): BaseContext {
	return {
		...baseContext(env, "org-1"),
		headers: new Headers({
			"User-Agent": "os-audit-test/1.0",
			"X-Service-Binding": "true",
			...headers,
		}),
	} as BaseContext;
}

function tediContext(env: CloudflareEnv): BaseContext {
	return gatewayContext(env, {
		"X-Tedix-Mcp-Tool-Id": "os:audit",
		"X-Tedix-Tedi-Id": TEDI_ID,
		"X-Tedix-Tedi-Scopes": "apps:read apps:write",
	});
}

function externalAgentContext(env: CloudflareEnv): BaseContext {
	return gatewayContext(env, {
		"X-Tedix-Mcp-Tool-Id": "os:audit",
		"X-Tedix-Caller-Type": "mcp-edge-external-agent",
		"X-Tedix-External-Agent-Principal-Id": AGENT_PRINCIPAL_ID,
		"X-Tedix-External-Agent-Session-Id": AGENT_SESSION_ID,
		"X-Tedix-External-Agent-Client-Record-Id": "harness.claude-code",
		"X-Tedix-End-User-Id": "descope-user-9",
	});
}

function osClient(context: BaseContext) {
	return createRouterClient(osWorkspacesContractRouter, { context });
}

/** The reader `audit.get_audit_by_resource` uses, nothing else. */
function readAudit(
	env: CloudflareEnv,
	resourceType: string,
	resourceId: string,
	organizationId = "org-1",
) {
	return getAuditEventsByResource(
		createDbClient(env.DB) as never,
		organizationId,
		resourceType,
		resourceId,
	);
}

async function countAllAuditRows(env: CloudflareEnv): Promise<number> {
	const result = await env.DB.prepare(
		"SELECT COUNT(*) AS total FROM audit_events",
	).first<{ total: number }>();
	return result?.total ?? 0;
}

describe("Tedix OS audit emission", () => {
	let env: CloudflareEnv;
	let os: ReturnType<typeof osClient>;

	beforeEach(() => {
		env = createEnv();
		os = osClient(userContext(env, "org-1"));
	});

	it("records the workspace lifecycle against the workspace id", async () => {
		const { workspace } = await os.workspaces.create({
			name: "Operations",
			description: "ops hub",
		});
		await os.workspaces.update({
			workspaceId: workspace.id,
			name: "Operations Center",
		});
		await os.workspaces.archive({ workspaceId: workspace.id });
		await os.workspaces.delete({ workspaceId: workspace.id });

		const rows = await readAudit(env, "os_workspace", workspace.id);
		expect(rows.map((row) => row.action).sort()).toEqual([
			"os.workspace.archived",
			"os.workspace.created",
			"os.workspace.deleted",
			"os.workspace.updated",
		]);
		for (const row of rows) {
			expect(row).toMatchObject({
				organizationId: "org-1",
				actorId: "user-1",
				actorType: "user",
				resourceType: "os_workspace",
				resourceId: workspace.id,
				ipAddress: "203.0.113.7",
				userAgent: "os-audit-test/1.0",
			});
		}
		expect(
			rows.find((row) => row.action === "os.workspace.updated")?.metadata,
		).toMatchObject({ changed: ["name"] });
	});

	it("records the gadget lifecycle, including a delete whose output carries no id", async () => {
		const { workspace } = await os.workspaces.create({ name: "Operations" });
		const { gadget } = await os.gadgets.create({
			workspaceId: workspace.id,
			name: "Inbox Triage",
		});
		await os.gadgets.revise({
			workspaceId: workspace.id,
			gadgetId: gadget.id,
			manifest: { entry: "main.ts", capabilities: [] },
		});
		await os.gadgets.archive({
			workspaceId: workspace.id,
			gadgetId: gadget.id,
		});
		await os.gadgets.delete({
			workspaceId: workspace.id,
			gadgetId: gadget.id,
		});

		const rows = await readAudit(env, "os_gadget", gadget.id);
		expect(rows.map((row) => row.action).sort()).toEqual([
			"os.gadget.archived",
			"os.gadget.created",
			"os.gadget.deleted",
			"os.gadget.revised",
		]);
		expect(
			rows.find((row) => row.action === "os.gadget.revised")?.metadata,
		).toMatchObject({ revision: 1 });
	});

	it("keys governed Gadget requests on the gadget under os_gadget_execution", async () => {
		const { workspace } = await os.workspaces.create({ name: "Operations" });
		const { gadget } = await os.gadgets.create({
			workspaceId: workspace.id,
			name: "Inbox Triage",
		});
		await os.gadgets.revise({
			workspaceId: workspace.id,
			gadgetId: gadget.id,
			manifest: { entry: "main.ts", capabilities: [] },
		});
		const { execution } = await os.gadgets.run({
			workspaceId: workspace.id,
			gadgetId: gadget.id,
			tediId: "11111111-1111-4111-8111-111111111111",
			capabilities: ["test:undeclared"],
		});
		expect(execution.status).toBe("denied");

		// The parity runner probes exactly this pair: resourceType
		// "os_gadget_execution", resourceId = the GADGET id.
		const rows = await readAudit(env, "os_gadget_execution", gadget.id);
		expect(rows.map((row) => row.action)).toEqual([
			"os.gadget_execution.requested",
		]);
		for (const row of rows) {
			expect(row.metadata).toMatchObject({ executionId: execution.id });
		}
	});

	it("records the output lifecycle against the output id", async () => {
		const { workspace } = await os.workspaces.create({ name: "Operations" });
		const created = await os.outputs.create({
			workspaceId: workspace.id,
			kind: "document",
			title: "Weekly Brief",
			content: { kind: "document", blocks: [] },
		});
		const outputId = created.output.id;
		await os.outputs.rename({ outputId, title: "Weekly Brief v2" });
		await os.outputs.revise({
			outputId,
			content: {
				kind: "document",
				blocks: [{ type: "paragraph", text: "hello" }],
			},
		});
		await os.outputs.patchDocument({
			outputId,
			ops: [
				{
					op: "insert",
					index: 1,
					block: { type: "paragraph", text: "second" },
				},
			],
		});
		await os.outputs.archive({ outputId });
		await os.outputs.delete({ outputId });

		const rows = await readAudit(env, "os_output", outputId);
		expect(rows.map((row) => row.action).sort()).toEqual([
			"os.output.archived",
			"os.output.created",
			"os.output.deleted",
			"os.output.document_patched",
			"os.output.renamed",
			"os.output.revised",
		]);
		expect(
			rows.find((row) => row.action === "os.output.document_patched")?.metadata,
		).toMatchObject({ operations: 1 });
	});

	it("records slide patches without copying presentation contents into audit metadata", async () => {
		const created = await os.outputs.create({
			kind: "presentation",
			title: "Deck",
		});
		const patched = await os.outputs.patchSlides({
			outputId: created.output.id,
			ops: [
				{
					op: "insert",
					index: 0,
					slide: { title: "Private slide", bullets: ["Confidential text"] },
				},
			],
		});
		const rows = await readAudit(env, "os_output", created.output.id);
		const events = rows.filter(
			(row) => row.action === "os.output.slides_patched",
		);
		expect(events).toHaveLength(1);
		expect(events[0]?.metadata).toMatchObject({
			operations: 1,
			revision: patched.revision.revision,
		});
		expect(JSON.stringify(events[0]?.metadata)).not.toContain(
			"Confidential text",
		);
	});

	it("records blueprint authoring and both sides of an instantiation", async () => {
		const { workspace } = await os.workspaces.create({ name: "Source" });
		const { gadget } = await os.gadgets.create({
			workspaceId: workspace.id,
			name: "Triage",
		});
		await os.gadgets.revise({
			workspaceId: workspace.id,
			gadgetId: gadget.id,
			manifest: { entry: "main.ts", capabilities: [] },
		});
		const { blueprint } = await os.blueprints.create({
			name: "Ops Starter",
			description: "starter",
		});
		await os.blueprints.revise({
			blueprintId: blueprint.id,
			definition: {
				version: 1,
				gadgets: [
					{
						name: "Triage",
						description: null,
						manifest: { entry: "main.ts", capabilities: [] },
					},
				],
			},
		});
		await os.blueprints.publish({ blueprintId: blueprint.id });
		await os.blueprints.setVisibility({
			blueprintId: blueprint.id,
			visibility: "catalog",
		});
		const instantiated = await os.blueprints.instantiate({
			blueprintId: blueprint.id,
			workspaceName: "Ops From Blueprint",
		});
		await os.blueprints.archive({ blueprintId: blueprint.id });
		await os.blueprints.delete({ blueprintId: blueprint.id });

		const blueprintRows = await readAudit(env, "os_blueprint", blueprint.id);
		expect(blueprintRows.map((row) => row.action).sort()).toEqual([
			"os.blueprint.archived",
			"os.blueprint.created",
			"os.blueprint.deleted",
			"os.blueprint.instantiated",
			"os.blueprint.published",
			"os.blueprint.revised",
			"os.blueprint.visibility_set",
		]);

		// The materialized workspace carries its own row, so "where did this
		// workspace come from" is answerable from the workspace id alone.
		const workspaceRows = await readAudit(
			env,
			"os_workspace",
			instantiated.workspace.id,
		);
		expect(workspaceRows.map((row) => row.action)).toContain(
			"os.blueprint.instantiated",
		);
		expect(
			workspaceRows.find((row) => row.action === "os.blueprint.instantiated")
				?.metadata,
		).toMatchObject({ blueprintId: blueprint.id });
	});

	it("records share-link governance without ever recording the token", async () => {
		const { workspace } = await os.workspaces.create({ name: "Operations" });
		const shares = createRouterClient(osSharesContractRouter, {
			context: userContext(env, "org-1"),
		});
		const created = await shares.shares.create({
			resourceType: "workspace",
			resourceId: workspace.id,
			role: "build",
			revisionMode: "living",
		});
		await shares.shares.restrict({
			shareId: created.share.id,
			maxRole: "use",
			reason: "policy review",
		});
		await shares.shares.revoke({ shareId: created.share.id });
		await shares.shares.delete({ shareId: created.share.id });

		const rows = await readAudit(env, "os_share_link", created.share.id);
		expect(rows.map((row) => row.action).sort()).toEqual([
			"os.share_link.created",
			"os.share_link.deleted",
			"os.share_link.restricted",
			"os.share_link.revoked",
		]);
		for (const row of rows) {
			if (row.action !== "os.share_link.deleted") {
				expect(row.metadata).toMatchObject({
					sharedResourceType: "workspace",
					sharedResourceId: workspace.id,
				});
			}
			expect(JSON.stringify(row.metadata)).not.toContain(created.token);
		}
	});

	it("records the collaboration-proposal decision trail", async () => {
		const { workspace } = await os.workspaces.create({ name: "Operations" });
		const created = await os.outputs.create({
			workspaceId: workspace.id,
			kind: "document",
			title: "Draft",
			content: { kind: "document", blocks: [] },
		});
		const producer = osClient(externalAgentContext(env));
		const proposalOf = async () =>
			(
				await producer.collaboration.create({
					workspaceId: workspace.id,
					documentType: "output",
					documentId: created.output.id,
					sourceKind: "agent_session",
					sourceId: AGENT_SESSION_ID,
					content: {
						kind: "document",
						blocks: [{ type: "paragraph", text: "preview" }],
					},
				})
			).proposal;

		const merging = await proposalOf();
		await os.collaboration.accept({
			proposalId: merging.id,
			expectedSequence: 0,
			rationale: "Reviewed",
		});
		await os.collaboration.merge({
			proposalId: merging.id,
			expectedSequence: 0,
			rationale: "Approved for the immutable history",
		});
		const mergedRows = await readAudit(
			env,
			"os_collaboration_proposal",
			merging.id,
		);
		expect(mergedRows.map((row) => row.action).sort()).toEqual([
			"os.collaboration_proposal.accepted",
			"os.collaboration_proposal.created",
			"os.collaboration_proposal.merged",
		]);

		const rejected = await proposalOf();
		await os.collaboration.reject({
			proposalId: rejected.id,
			expectedSequence: 0,
			rationale: "Evidence did not support the edit",
		});
		expect(
			(await readAudit(env, "os_collaboration_proposal", rejected.id)).map(
				(row) => row.action,
			),
		).toContain("os.collaboration_proposal.rejected");
	});

	it("records approval-rule governance changes", async () => {
		const rules = createRouterClient(osApprovalRulesContractRouter, {
			context: userContext(env, "org-1"),
		});
		const { rule } = await rules.create({ actionKind: "os_gadget_execution" });
		await rules.setEnabled({ ruleId: rule.id, enabled: false });
		await rules.delete({ ruleId: rule.id });

		const rows = await readAudit(env, "os_approval_rule", rule.id);
		expect(rows.map((row) => row.action).sort()).toEqual([
			"os.approval_rule.created",
			"os.approval_rule.deleted",
			"os.approval_rule.enabled_set",
		]);
		expect(
			rows.find((row) => row.action === "os.approval_rule.created")?.metadata,
		).toMatchObject({ actionKind: "os_gadget_execution", decision: "approve" });
	});

	it("emits nothing for reads", async () => {
		const { workspace } = await os.workspaces.create({ name: "Operations" });
		const { gadget } = await os.gadgets.create({
			workspaceId: workspace.id,
			name: "Triage",
		});
		const before = await countAllAuditRows(env);

		await os.workspaces.list({});
		await os.workspaces.get({ workspaceId: workspace.id });
		await os.gadgets.list({ workspaceId: workspace.id });
		await os.gadgets.get({ workspaceId: workspace.id, gadgetId: gadget.id });
		await os.outputs.list({ workspaceId: workspace.id });
		await os.outputs.library({});
		await os.blueprints.list({});
		await os.blueprints.gallery({});
		await os.executions.list({
			workspaceId: workspace.id,
			gadgetId: gadget.id,
		});
		const shares = createRouterClient(osSharesContractRouter, {
			context: userContext(env, "org-1"),
		});
		await shares.shares.list({
			resourceType: "workspace",
			resourceId: workspace.id,
		});
		const rules = createRouterClient(osApprovalRulesContractRouter, {
			context: userContext(env, "org-1"),
		});
		await rules.list({});

		expect(await countAllAuditRows(env)).toBe(before);
	});

	it("refuses to emit for a GET even when one is wired into a registry", async () => {
		// The read/write split is structural, not conventional: this deliberately
		// MIS-wires `workspaces.list` (GET) and the middleware still writes
		// nothing, because it reads the procedure's own declared method.
		const impl = implement(osWorkspacesContract).$context<BaseContext>();
		const misconfigured = impl
			.use(withAuth)
			.use(
				osAudit({
					"workspaces.list": {
						action: "os.workspace.listed",
						resourceType: "os_workspace",
						resourceId: () => "should-never-be-written",
					},
				}),
			)
			.use(AUTHZ.osRead);
		const client = createRouterClient(
			impl.router({
				workspaces: { list: misconfigured.workspaces.list.handler(() => list) },
			} as never),
			{ context: userContext(env, "org-1") },
		) as { workspaces: { list: (input: unknown) => Promise<unknown> } };
		const list = { items: [], truncated: false };

		await client.workspaces.list({});

		expect(await countAllAuditRows(env)).toBe(0);
	});

	it("emits nothing when the mutation throws", async () => {
		const { workspace } = await os.workspaces.create({ name: "Operations" });
		const foreign = osClient(userContext(env, "org-2"));
		const before = await countAllAuditRows(env);

		await expect(
			foreign.workspaces.archive({ workspaceId: workspace.id }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			foreign.workspaces.update({ workspaceId: workspace.id, name: "Nope" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		// A duplicate name fails inside the handler, after validation.
		await expect(
			os.workspaces.create({ name: "Operations" }),
		).rejects.toMatchObject({ code: "CONFLICT" });
		// An authorization failure never reaches the handler at all.
		await expect(
			createRouterClient(osWorkspacesContractRouter, {
				context: {
					...userContext(env, "org-1"),
					user: {
						...(userContext(env, "org-1").user as object),
						permissions: [],
					},
				} as BaseContext,
			}).workspaces.create({ name: "Unauthorized" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		expect(await countAllAuditRows(env)).toBe(before);
	});

	it("distinguishes user, api_key, tedi and external_agent principals", async () => {
		const cases: [BaseContext, string, string][] = [
			[userContext(env, "org-1"), "user", "user-1"],
			[apiKeyContext(env), "api_key", "key-1"],
			[tediContext(env), "tedi", TEDI_ID],
			[externalAgentContext(env), "external_agent", AGENT_PRINCIPAL_ID],
		];
		for (const [context, actorType, actorId] of cases) {
			const { workspace } = await osClient(context).workspaces.create({
				name: `Workspace ${actorType}`,
			});
			const [row] = await readAudit(env, "os_workspace", workspace.id);
			expect(row).toMatchObject({
				action: "os.workspace.created",
				actorType,
				actorId,
			});
		}
	});

	it("stamps agent attribution from a well-formed WebMCP invocation header", async () => {
		const attributed = userContext(env, "org-1");
		attributed.headers.set(
			"X-Tedix-Webmcp-Invocation",
			"5B2F0F9C-7F68-4A3A-9A58-0B6A9A1C2D3E",
		);
		const { workspace } = await osClient(attributed).workspaces.create({
			name: "Agent Made This",
		});

		const [row] = await readAudit(env, "os_workspace", workspace.id);
		// Normalized to lowercase, actor identity untouched: the header is
		// telemetry metadata, never authority.
		expect(row).toMatchObject({ actorType: "user", actorId: "user-1" });
		expect(row?.metadata).toMatchObject({
			webmcpInvocationId: "5b2f0f9c-7f68-4a3a-9a58-0b6a9a1c2d3e",
			agentInitiated: true,
		});
	});

	it("ignores a malformed WebMCP invocation header instead of storing it", async () => {
		const malformed = userContext(env, "org-1");
		malformed.headers.set(
			"X-Tedix-Webmcp-Invocation",
			"ssn 123-45-6789 jane@acme.example",
		);
		const { workspace } = await osClient(malformed).workspaces.create({
			name: "Not Attributable",
		});

		const [row] = await readAudit(env, "os_workspace", workspace.id);
		const metadata = row?.metadata as Record<string, unknown>;
		expect(metadata.webmcpInvocationId).toBeUndefined();
		expect(metadata.agentInitiated).toBeUndefined();
		expect(JSON.stringify(metadata)).not.toContain("123-45-6789");
	});

	it("leaves rows without the header unmarked (human clicks stay human)", async () => {
		const { workspace } = await os.workspaces.create({ name: "Hand Made" });
		const [row] = await readAudit(env, "os_workspace", workspace.id);
		const metadata = row?.metadata as Record<string, unknown>;
		expect("webmcpInvocationId" in metadata).toBe(false);
		expect("agentInitiated" in metadata).toBe(false);
	});

	it("keeps the mutation successful when the audit write fails", async () => {
		await env.DB.prepare("DROP TABLE audit_events").run();
		const errors: unknown[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => {
			errors.push(args);
		};
		try {
			const { workspace } = await os.workspaces.create({ name: "Resilient" });
			expect(workspace.name).toBe("Resilient");
		} finally {
			console.error = original;
		}
		// Fail-soft, never silent: the lost governance event is logged.
		expect(JSON.stringify(errors)).toContain("os.workspace.created");
	});
});
