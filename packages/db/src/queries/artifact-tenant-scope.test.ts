import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { skillRuns } from "../schema/cognitive";
import { osGadgetExecutions } from "../schema/os-workspaces";
import { createD1Facade } from "../test/d1-facade";
import { tableDdl } from "../test/schema-ddl";
import { resolveRunArtifactTenantScope } from "./skill-run-artifacts";

it("resolves signed artifact routing from either parent and refuses conflicting owners", async () => {
	const sqlite = new DatabaseSync(":memory:");
	try {
		sqlite.exec(
			[skillRuns, osGadgetExecutions]
				.flatMap((table) => tableDdl(table, { foreignKeys: false }))
				.join("\n"),
		);
		const db = createDbQueryClient(createD1Facade(sqlite));
		const run = sqlite.prepare(
			"INSERT INTO skill_runs (id, organization_id, skill_id, tedi_id, workflow_instance_id, runtime_environment) VALUES (?, ?, 'fictional-skill', 'fictional-tedi', ?, 'production')",
		);
		const gadget = sqlite.prepare(
			"INSERT INTO os_gadget_executions (id, organization_id, workspace_id, gadget_id, status, granted_capabilities, policy_decision, created_by_kind, created_by_id, created_at) VALUES (?, ?, 'fictional-workspace', 'fictional-gadget', 'completed', '[]', '{}', 'user', 'fictional-user', '2026-01-01T00:00:00.000Z')",
		);
		run.run("workflow-run", "fictional-org", "workflow-instance");
		gadget.run("gadget-run", "fictional-org");
		await expect(
			resolveRunArtifactTenantScope(db, "workflow-run"),
		).resolves.toEqual({ organizationId: "fictional-org" });
		await expect(
			resolveRunArtifactTenantScope(db, "gadget-run"),
		).resolves.toEqual({
			organizationId: "fictional-org",
			workspaceId: "fictional-workspace",
		});
		await expect(
			resolveRunArtifactTenantScope(db, "missing"),
		).resolves.toBeUndefined();
		run.run("gadget-run", "fictional-org", "gadget-instance");
		await expect(
			resolveRunArtifactTenantScope(db, "gadget-run"),
		).resolves.toEqual({
			organizationId: "fictional-org",
			workspaceId: "fictional-workspace",
		});
		sqlite
			.prepare(
				"UPDATE skill_runs SET organization_id = 'fictional-other' WHERE id = 'gadget-run'",
			)
			.run();
		await expect(
			resolveRunArtifactTenantScope(db, "gadget-run"),
		).rejects.toThrow("Artifact parent scope conflict");
	} finally {
		sqlite.close();
	}
});
