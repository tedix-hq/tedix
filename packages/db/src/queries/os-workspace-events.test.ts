import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { createD1Facade } from "../test/d1-facade";
import {
	announceOsWorkspaceChange,
	getLatestOsWorkspaceEventCursor,
	listOsWorkspaceEventsAfter,
	recordOsWorkspaceEvent,
} from "./os-workspace-events";
import {
	createOsGadgetExecution,
	settleOsGadgetExecutionFromRun,
} from "./os-workspaces/executions";
import {
	grantOsWorkspaceAccess,
	updateOsWorkspaceShareLink,
} from "./os-collaborators";

const EVENTS_DDL = `
	CREATE TABLE os_workspace_events (
		seq INTEGER PRIMARY KEY AUTOINCREMENT,
		workspace_id TEXT NOT NULL,
		kind TEXT NOT NULL,
		created_at TEXT NOT NULL DEFAULT (datetime('now'))
	);
`;

function fixture(withEvents = true) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE os_gadget_executions (
			id TEXT PRIMARY KEY NOT NULL, organization_id TEXT NOT NULL,
			workspace_id TEXT NOT NULL, gadget_id TEXT NOT NULL, revision_id TEXT,
			revision INTEGER, status TEXT NOT NULL, granted_capabilities TEXT NOT NULL,
			policy_decision TEXT NOT NULL, input TEXT, output TEXT, error TEXT,
			costs TEXT, evidence_refs TEXT, run_id TEXT, workflow_instance_id TEXT,
			tedi_id TEXT, work_item_id TEXT, trace_bundle_id TEXT,
			billing_reservation_id TEXT, approval_request_id TEXT,
			runtime_environment TEXT, agent_session_id TEXT,
			resource_access_envelope TEXT,
			execution_epoch INTEGER NOT NULL DEFAULT 0, created_by_kind TEXT NOT NULL,
			created_by_id TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now')), completed_at TEXT
		);
		CREATE TABLE os_workspace_share_links (
			id TEXT PRIMARY KEY NOT NULL, organization_id TEXT NOT NULL,
			workspace_id TEXT NOT NULL, creator_user_id TEXT NOT NULL,
			role TEXT NOT NULL, label TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')), revoked_at TEXT
		);
		${withEvents ? EVENTS_DDL : ""}
	`);
	return { sqlite, db: createDbQueryClient(createD1Facade(sqlite)) };
}

const execution = (id: string, workspaceId: string) => ({
	id,
	organizationId: "org-1",
	workspaceId,
	gadgetId: "gd-1",
	status: "running" as const,
	grantedCapabilities: "[]",
	policyDecision: "{}",
	runId: `run-${id}`,
	createdByKind: "service" as const,
	createdById: "svc",
});

describe("workspace events", () => {
	it("returns events after a cursor, scoped to one workspace and oldest first", async () => {
		const { db } = fixture();
		expect(await getLatestOsWorkspaceEventCursor(db, "ws-1")).toBe(0);
		const first = await recordOsWorkspaceEvent(db, {
			workspaceId: "ws-1",
			kind: "access",
		});
		await recordOsWorkspaceEvent(db, { workspaceId: "ws-2", kind: "runs" });
		const last = await recordOsWorkspaceEvent(db, {
			workspaceId: "ws-1",
			kind: "proposals",
		});
		expect(await getLatestOsWorkspaceEventCursor(db, "ws-1")).toBe(last);
		expect(
			await listOsWorkspaceEventsAfter(db, {
				workspaceId: "ws-1",
				after: 0,
				limit: 10,
			}),
		).toEqual([
			{ cursor: first, kind: "access" },
			{ cursor: last, kind: "proposals" },
		]);
		expect(
			await listOsWorkspaceEventsAfter(db, {
				workspaceId: "ws-1",
				after: first,
				limit: 10,
			}),
		).toEqual([{ cursor: last, kind: "proposals" }]);
	});

	it("never fails the change when the hint cannot be written", async () => {
		const { db } = fixture(false);
		await expect(
			announceOsWorkspaceChange(db, "ws-1", "runs"),
		).resolves.toBeUndefined();
		await expect(
			createOsGadgetExecution(db, execution("a", "ws-1")),
		).resolves.toMatchObject({ id: "a" });
	});

	it("announces runs when a run starts and settles", async () => {
		const { db } = fixture();
		await createOsGadgetExecution(db, execution("a", "ws-1"));
		await settleOsGadgetExecutionFromRun(db, {
			runId: "run-a",
			status: "completed",
		});
		const events = await listOsWorkspaceEventsAfter(db, {
			workspaceId: "ws-1",
			after: 0,
			limit: 10,
		});
		expect(events.map((event) => event.kind)).toEqual(["runs", "runs"]);
		expect(
			await listOsWorkspaceEventsAfter(db, {
				workspaceId: "ws-2",
				after: 0,
				limit: 10,
			}),
		).toEqual([]);
	});

	it("announces access when a share link changes and stays quiet when nothing changed", async () => {
		const { sqlite, db } = fixture();
		sqlite.exec(
			`INSERT INTO os_workspace_share_links (id, organization_id, workspace_id, creator_user_id, role) VALUES ('l1','org-1','ws-1','u1','use')`,
		);
		const scope = { organizationId: "org-1", workspaceId: "ws-1" };
		await updateOsWorkspaceShareLink(db, {
			...scope,
			linkId: "missing",
			set: { role: "build" },
		});
		expect(await getLatestOsWorkspaceEventCursor(db, "ws-1")).toBe(0);
		await updateOsWorkspaceShareLink(db, {
			...scope,
			linkId: "l1",
			set: { role: "build" },
		});
		const events = await listOsWorkspaceEventsAfter(db, {
			workspaceId: "ws-1",
			after: 0,
			limit: 10,
		});
		expect(events.map((event) => event.kind)).toEqual(["access"]);
		await grantOsWorkspaceAccess(db, { ...scope, edges: [], now: "now" });
		expect(await getLatestOsWorkspaceEventCursor(db, "ws-1")).toBe(1);
	});
});
