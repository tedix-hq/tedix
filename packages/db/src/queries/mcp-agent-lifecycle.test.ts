import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import { resolveAgentLifecycleAuthorization } from "./mcp-agent-lifecycle";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
	CREATE TABLE work_attempts (id TEXT, org_id TEXT, work_item_id TEXT, executor_type TEXT, executor_id TEXT, executor_session_id TEXT, external_session_key TEXT, runtime_state TEXT, expires_at TEXT);
	CREATE TABLE work_items (id TEXT, org_id TEXT, project_id TEXT, disposition TEXT);
	CREATE TABLE external_agent_sessions (id TEXT, organization_id TEXT, principal_id TEXT, external_session_key TEXT, status TEXT);
	CREATE TABLE external_agent_principals (id TEXT, organization_id TEXT, status TEXT);
	CREATE TABLE os_workspace_projects (organization_id TEXT, workspace_id TEXT, project_id TEXT, status TEXT);
	CREATE TABLE os_outputs (id TEXT, organization_id TEXT, workspace_id TEXT, status TEXT);
	INSERT INTO external_agent_principals VALUES ('agent','org','active');
	INSERT INTO external_agent_sessions VALUES ('session','org','agent','codex:own','active');
	INSERT INTO work_items VALUES ('work','org','project','accepted');
	INSERT INTO work_attempts VALUES ('attempt','org','work','external_agent','agent','session','codex:own','running','2099-01-01T00:00:00.000Z');
	INSERT INTO os_workspace_projects VALUES ('org','workspace','project','active');
	INSERT INTO os_outputs VALUES ('output','org','workspace','active');
	`);
	return { sqlite, db: createDbClient(createD1Facade(sqlite)) };
}
const identity = {
	organizationId: "org",
	principalId: "agent",
	sessionId: "session",
};
it("binds lifecycle writes to the exact live Attempt and external session", async () => {
	const { db, sqlite } = fixture();
	for (const endpoint of [
		"workItems/addComment",
		"workItems/heartbeatAttempt",
		"workItems/settleAttempt",
		"externalAgentIdentity/recordKnowledgeCheckpoint",
	]) {
		const args = {
			id: "work",
			workItemId: "work",
			attemptId: "attempt",
			principalId: "agent",
			sessionId: "session",
			organizationId: "org",
		};
		expect(
			await resolveAgentLifecycleAuthorization(db, {
				...identity,
				endpoint,
				args,
			}),
		).toBe(true);
		expect(
			await resolveAgentLifecycleAuthorization(db, {
				...identity,
				endpoint,
				args: { ...args, id: "other", workItemId: "other" },
			}),
		).toBe(false);
	}
	for (const patch of [
		"UPDATE work_attempts SET expires_at='2000-01-01'",
		"UPDATE work_attempts SET runtime_state='succeeded'",
		"UPDATE work_attempts SET external_session_key='codex:other'",
		"UPDATE work_items SET disposition='completed'",
		"UPDATE work_attempts SET executor_session_id='other'",
		"UPDATE external_agent_sessions SET status='ended'",
		"UPDATE external_agent_principals SET status='suspended'",
	]) {
		const isolated = fixture();
		isolated.sqlite.exec(patch);
		expect(
			await resolveAgentLifecycleAuthorization(isolated.db, {
				...identity,
				endpoint: "workItems/addComment",
				args: { id: "work" },
			}),
		).toBe(false);
		isolated.sqlite.close();
	}
	expect(
		await resolveAgentLifecycleAuthorization(db, {
			...identity,
			endpoint: "workItems/heartbeatAttempt",
			args: { id: "work", attemptId: "other" },
		}),
	).toBe(false);
	expect(
		await resolveAgentLifecycleAuthorization(db, {
			...identity,
			endpoint: "workItems/addComment",
			args: { id: "work", requestDelegation: true },
		}),
	).toBe(false);
	expect(
		await resolveAgentLifecycleAuthorization(db, {
			...identity,
			endpoint: "workItems/complete",
			args: { id: "work" },
		}),
	).toBe(false);
	sqlite.close();
});
it("limits Outputs to a workspace linked to a project held by this session", async () => {
	const { db, sqlite } = fixture();
	for (const [endpoint, args] of [
		["osWorkspaces/outputs/create", { workspaceId: "workspace" }],
		["osWorkspaces/outputs/revise", { outputId: "output" }],
	] as const) {
		expect(
			await resolveAgentLifecycleAuthorization(db, {
				...identity,
				endpoint,
				args,
			}),
		).toBe(true);
		expect(
			await resolveAgentLifecycleAuthorization(db, {
				...identity,
				principalId: "other",
				endpoint,
				args,
			}),
		).toBe(false);
		expect(
			await resolveAgentLifecycleAuthorization(db, {
				...identity,
				organizationId: "other",
				endpoint,
				args,
			}),
		).toBe(false);
	}
	sqlite.exec("UPDATE os_workspace_projects SET project_id='other'");
	expect(
		await resolveAgentLifecycleAuthorization(db, {
			...identity,
			endpoint: "osWorkspaces/outputs/create",
			args: { workspaceId: "workspace" },
		}),
	).toBe(false);
	expect(
		await resolveAgentLifecycleAuthorization(db, {
			...identity,
			endpoint: "osWorkspaces/outputs/create",
			args: {},
		}),
	).toBe(false);
	sqlite.close();
});
