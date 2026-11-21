import { DatabaseSync } from "node:sqlite";
import { dispatcherHealthReports } from "@tedix/db/schema/dispatcher-health";
import { machineToolCalls, machineToolPolls } from "@tedix/db/schema/machines";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import {
	osWorkspaceAccessEdges,
	osWorkspaceCollaborators,
	osWorkspaceEvents,
	osWorkspaceShareLinks,
} from "@tedix/db/schema/os-collaborators";
import { osWorkspaces } from "@tedix/db/schema/os-workspaces";
import { tedis } from "@tedix/db/schema/tedis";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { expect, it, onTestFinished } from "vite-plus/test";
import { COMPUTER_ACCESS_OFF } from "@tedix/api-contract/schemas/workspace-agent-access";
import { useWorkspaceMachine } from "./workspace-machine";

function setup() {
	const sqlite = new DatabaseSync(":memory:");
	onTestFinished(() => sqlite.close());
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(
		schemaDdl(
			tedis,
			osWorkspaces,
			osWorkspaceCollaborators,
			osWorkspaceAccessEdges,
			osWorkspaceShareLinks,
			osWorkspaceEvents,
			organizationMembers,
			dispatcherHealthReports,
			machineToolCalls,
			machineToolPolls,
		),
	);
	const now = new Date().toISOString();
	sqlite.exec(`
		INSERT INTO organization_members (id, organization_id, descope_user_id, user_id, email, role, status)
		VALUES ('m-robin','org-1','member-robin','robin','robin@example.test','member','active');
		INSERT INTO tedis (id, organization_id, name, slug, display_name, status, scope)
		VALUES ('tedi-research', 'org-1', 'research', 'research', 'Research Tedi', 'active', 'organization');
		INSERT INTO os_workspaces (id, organization_id, name, visibility, owner_user_id, created_by_kind, created_by_id, created_at, updated_at)
		VALUES ('ws-private', 'org-1', 'Private', 'private', 'member-robin', 'user', 'member-robin', '2026-11-01', '2026-11-01');
		INSERT INTO os_workspaces (id, organization_id, name, visibility, owner_user_id, created_by_kind, created_by_id, created_at, updated_at)
		VALUES ('ws-team', 'org-1', 'Team', 'org', NULL, 'user', 'member-robin', '2026-11-01', '2026-11-01');
		INSERT INTO dispatcher_health_reports (org_id, reporter_id, executor, lane, running, observed_at, reported_at, machine_name, machine_tools, reported_by)
		VALUES
			('org-1', 'reporter-1', 'codex', 'codex', 1, '${now}', '${now}', 'Studio', '["read_file"]', 'user:robin'),
			('org-1', 'reporter-2', 'codex', 'codex', 1, '${now}', '${now}', 'Desk', '["read_file"]', 'user:kai'),
			('org-1', 'reporter-3', 'codex', 'codex', 1, '${now}', '${now}', 'Lab', '["read_file"]', NULL);
	`);
	return { sqlite, env: { DB: createD1Facade(sqlite) } as CloudflareEnv };
}

it("queues a read on a machine under the tedi the person addressed, and reads it back", async () => {
	const { sqlite, env } = setup();
	const acting = {
		organizationId: "org-1",
		workspaceId: "ws-private",
		userId: "member-robin",
		tediId: "tedi-research",
	};

	const queued = await useWorkspaceMachine(env, {
		...acting,
		op: "call",
		call: {
			machine: "studio",
			tool: "read_file",
			input: { path: "README.md" },
		},
	});
	expect(queued).toMatchObject({ status: "queued", callStatus: "pending" });
	if (queued.status !== "queued") return;
	expect(
		sqlite
			.prepare(
				"SELECT requested_by_type AS type, requested_by_id AS id FROM machine_tool_calls WHERE id = ?",
			)
			.get(queued.callId),
	).toEqual({ type: "tedi", id: "tedi-research" });
	expect(
		await useWorkspaceMachine(env, {
			...acting,
			op: "read",
			callId: queued.callId,
		}),
	).toMatchObject({
		status: "call",
		call: { machine: "Studio", tool: "read_file", status: "pending" },
	});
	// A person without build access to the workspace is refused before any machine rule.
	expect(
		await useWorkspaceMachine(env, {
			...acting,
			userId: "member-other",
			op: "list",
		}),
	).toMatchObject({ status: "refused" });
});

it("uses only the sender's own computer where other people can open the workspace", async () => {
	const { sqlite, env } = setup();
	const acting = {
		organizationId: "org-1",
		workspaceId: "ws-team",
		userId: "member-robin",
	};
	const call = (machine: string) =>
		useWorkspaceMachine(env, {
			...acting,
			op: "call",
			call: { machine, tool: "read_file", input: { path: "README.md" } },
		});
	// Off until someone who can edit the workspace switches it on.
	expect(await call("Studio")).toEqual({
		status: "refused",
		message: COMPUTER_ACCESS_OFF,
	});
	sqlite.exec(
		"UPDATE os_workspaces SET machine_access = 1 WHERE id = 'ws-team'",
	);
	const listed = await useWorkspaceMachine(env, { ...acting, op: "list" });
	expect(
		listed.status === "machines" && listed.machines.map((m) => m.machineName),
	).toEqual(["Studio"]);
	expect(await call("Desk")).toMatchObject({
		status: "refused",
		message: expect.stringContaining("another person's computer"),
	});
	expect(await call("Lab")).toMatchObject({
		status: "refused",
		message: expect.stringContaining("does not know whose computer"),
	});
	expect(await call("Studio")).toMatchObject({ status: "queued" });
});
