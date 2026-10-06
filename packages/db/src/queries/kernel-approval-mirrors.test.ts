import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import {
	clearKernelApprovalMirrors,
	createKernelApprovalMirror,
	escalateKernelApprovalMirrors,
	listActiveKernelApprovalMirrors,
} from "./kernel-approval-mirrors";

const REAL_DDL = `
PRAGMA foreign_keys = ON;
CREATE TABLE organizations (id TEXT PRIMARY KEY NOT NULL);
CREATE TABLE tedis (id TEXT PRIMARY KEY NOT NULL, organization_id TEXT NOT NULL);
CREATE TABLE tedi_approval_requests (
	id TEXT PRIMARY KEY NOT NULL,
	tedi_id TEXT NOT NULL,
	org_id TEXT NOT NULL,
	action_type TEXT NOT NULL,
	description TEXT NOT NULL,
	payload TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'pending',
	created_at TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	resolved_at TEXT,
	resolved_by TEXT,
	resolution TEXT,
	workflow_id TEXT
);
CREATE TABLE kernel_home_approval_mirrors (
	id TEXT PRIMARY KEY NOT NULL,
	organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
	parent_conversation_id TEXT NOT NULL,
	child_run_id TEXT NOT NULL,
	approval_request_id TEXT NOT NULL REFERENCES tedi_approval_requests(id) ON DELETE CASCADE,
	delegated_tedi_id TEXT REFERENCES tedis(id) ON DELETE SET NULL,
	status TEXT NOT NULL DEFAULT 'pending',
	blocked_at TEXT NOT NULL,
	escalate_at INTEGER NOT NULL,
	escalated_at TEXT,
	cleared_at TEXT,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

function realDb(): { db: DbClient; sqlite: DatabaseSync } {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(REAL_DDL);
	return { db: createDbClient(createD1Facade(sqlite)), sqlite };
}

function seed(sqlite: DatabaseSync): void {
	sqlite.exec(`
		INSERT INTO organizations (id) VALUES ('org-1'), ('org-2');
		INSERT INTO tedis (id, organization_id) VALUES ('tedi-1', 'org-1');
		INSERT INTO tedi_approval_requests (
			id, tedi_id, org_id, action_type, description, payload, status,
			created_at, expires_at
		) VALUES (
			'approval-1', 'tedi-1', 'org-1', 'custom', 'Approve child', '{}',
			'pending', '2026-07-18T08:00:00.000Z', '2026-07-19T08:00:00.000Z'
		);
	`);
}

describe("kernel Home approval mirrors — real SQLite lifecycle", () => {
	it("persists urgency without becoming a second approval state machine", async () => {
		const { db, sqlite } = realDb();
		seed(sqlite);
		const base = {
			id: "home:main:child-1:approval-1",
			organizationId: "org-1",
			parentConversationId: "home:main",
			childRunId: "child-1",
			approvalRequestId: "approval-1",
			delegatedTediId: "tedi-1",
			blockedAt: "2026-07-18T08:00:00.000Z",
			escalateAt: 1_752_825_690_000,
		};
		await createKernelApprovalMirror(db, base);
		expect(
			await listActiveKernelApprovalMirrors(db, {
				organizationId: "org-1",
				parentConversationId: "home:main",
			}),
		).toMatchObject([{ id: base.id, status: "pending" }]);

		expect(
			await escalateKernelApprovalMirrors(db, {
				ids: [base.id],
				escalatedAt: "2026-07-18T08:02:00.000Z",
			}),
		).toEqual([{ id: base.id, approvalRequestId: "approval-1" }]);
		expect(
			(
				await listActiveKernelApprovalMirrors(db, {
					organizationId: "org-1",
					parentConversationId: "home:main",
				})
			)[0]?.status,
		).toBe("escalated");

		// A retry repairs a missing insert but never de-escalates an existing row.
		await createKernelApprovalMirror(db, base);
		expect(
			(
				await listActiveKernelApprovalMirrors(db, {
					organizationId: "org-1",
					parentConversationId: "home:main",
				})
			)[0]?.status,
		).toBe("escalated");

		// Canonical resolution alone suppresses a stale uncleared projection row.
		sqlite.exec(
			"UPDATE tedi_approval_requests SET status = 'approved' WHERE id = 'approval-1'",
		);
		expect(
			await listActiveKernelApprovalMirrors(db, {
				organizationId: "org-1",
				parentConversationId: "home:main",
			}),
		).toEqual([]);
	});

	it("returns only the rows THIS call escalated, so a human is paged once", async () => {
		const { db, sqlite } = realDb();
		seed(sqlite);
		const id = "home:main:child-1:approval-1";
		await createKernelApprovalMirror(db, {
			id,
			organizationId: "org-1",
			parentConversationId: "home:main",
			childRunId: "child-1",
			approvalRequestId: "approval-1",
			blockedAt: "2026-07-18T08:00:00.000Z",
			escalateAt: 1_752_825_690_000,
		});

		// The CAS predicate (pending + uncleared) plus `returning()` is the
		// exactly-once latch the escalation notifier pages off.
		expect(
			await escalateKernelApprovalMirrors(db, {
				ids: [id],
				escalatedAt: "2026-07-18T08:02:00.000Z",
			}),
		).toEqual([{ id, approvalRequestId: "approval-1" }]);

		// A re-armed alarm or a second DO activation re-runs the same update.
		expect(
			await escalateKernelApprovalMirrors(db, {
				ids: [id],
				escalatedAt: "2026-07-18T08:04:00.000Z",
			}),
		).toEqual([]);

		// An id that was never blocked, and the empty batch, both stay silent.
		expect(
			await escalateKernelApprovalMirrors(db, {
				ids: ["home:main:child-2:approval-1"],
				escalatedAt: "2026-07-18T08:04:00.000Z",
			}),
		).toEqual([]);
		expect(
			await escalateKernelApprovalMirrors(db, {
				ids: [],
				escalatedAt: "2026-07-18T08:04:00.000Z",
			}),
		).toEqual([]);
	});

	it("never escalates a cleared row", async () => {
		const { db, sqlite } = realDb();
		seed(sqlite);
		const id = "home:main:child-1:approval-1";
		await createKernelApprovalMirror(db, {
			id,
			organizationId: "org-1",
			parentConversationId: "home:main",
			childRunId: "child-1",
			approvalRequestId: "approval-1",
			blockedAt: "2026-07-18T08:00:00.000Z",
			escalateAt: 1_752_825_690_000,
		});
		await clearKernelApprovalMirrors(db, {
			organizationId: "org-1",
			parentConversationId: "home:main",
			childRunId: "child-1",
			clearedAt: "2026-07-18T08:01:00.000Z",
		});

		expect(
			await escalateKernelApprovalMirrors(db, {
				ids: [id],
				escalatedAt: "2026-07-18T08:02:00.000Z",
			}),
		).toEqual([]);
	});

	it("clears idempotently and isolates organization and conversation reads", async () => {
		const { db, sqlite } = realDb();
		seed(sqlite);
		const id = "home:main:child-1:approval-1";
		await createKernelApprovalMirror(db, {
			id,
			organizationId: "org-1",
			parentConversationId: "home:main",
			childRunId: "child-1",
			approvalRequestId: "approval-1",
			blockedAt: "2026-07-18T08:00:00.000Z",
			escalateAt: 1_752_825_690_000,
		});
		expect(
			await listActiveKernelApprovalMirrors(db, {
				organizationId: "org-2",
				parentConversationId: "home:main",
			}),
		).toEqual([]);
		expect(
			await listActiveKernelApprovalMirrors(db, {
				organizationId: "org-1",
				parentConversationId: "home:other",
			}),
		).toEqual([]);

		for (let attempt = 0; attempt < 2; attempt++) {
			await clearKernelApprovalMirrors(db, {
				organizationId: "org-1",
				parentConversationId: "home:main",
				childRunId: "child-1",
				clearedAt: "2026-07-18T08:03:00.000Z",
			});
		}
		expect(
			await listActiveKernelApprovalMirrors(db, {
				organizationId: "org-1",
				parentConversationId: "home:main",
			}),
		).toEqual([]);
	});
});
