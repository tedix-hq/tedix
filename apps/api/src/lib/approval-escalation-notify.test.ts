import { DatabaseSync } from "node:sqlite";
import { createDbClient, type DbClient } from "@tedix/db/client";
import { searchAuditEvents } from "@tedix/db/queries/audit";
import { auditEvents } from "@tedix/db/schema/audit-events";
import { tediApprovalRequests } from "@tedix/db/schema/approvals";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	HOME_TOOL_WRITE_KIND,
	type HomeToolWritePayload,
} from "../rpc/routers/kernel/write-executor";
import {
	type ApprovalEscalationEnv,
	notifyApprovalEscalation,
} from "./approval-escalation-notify";

const ORG = "org-1";
const APPROVAL_ID = "approval-1";
const MIRROR_ID = "home:main:child-1:approval-1";
const ESCALATED_AT = "2026-08-16T08:02:00.000Z";

/**
 * DDL for the tables under test comes from the real Drizzle objects, so a schema
 * change reaches this test for free. `organizations`/`tedis` exist only as FK
 * targets (node:sqlite enforces foreign keys) — the notifier never reads them.
 */
const FK_PARENT_DDL = `
CREATE TABLE organizations (id TEXT PRIMARY KEY NOT NULL);
CREATE TABLE tedis (id TEXT PRIMARY KEY NOT NULL);
INSERT INTO organizations (id) VALUES ('${ORG}');
INSERT INTO tedis (id) VALUES ('tedi-1');
`;

function fixture(): { db: DbClient; sqlite: DatabaseSync } {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(FK_PARENT_DDL);
	sqlite.exec(
		schemaDdl(tediApprovalRequests, organizationMembers, auditEvents),
	);
	return { db: createDbClient(createD1Facade(sqlite)), sqlite };
}

async function seedApproval(
	db: DbClient,
	opts: {
		status?: "pending" | "approved";
		payload?: Record<string, never> | HomeToolWritePayload;
	} = {},
): Promise<void> {
	await db.insert(tediApprovalRequests).values({
		id: APPROVAL_ID,
		tediId: "tedi-1",
		orgId: ORG,
		actionType: "home.tool_write",
		description: "Approve Kernel write: create_invoice on globex-tedix",
		// Drizzle owns the json encoding here exactly as the producer does.
		payload: (opts.payload ?? {}) as never,
		status: opts.status ?? "pending",
		createdAt: "2026-08-16T08:00:00.000Z",
		expiresAt: "2026-08-17T08:00:00.000Z",
	});
}

async function seedMember(
	db: DbClient,
	opts: {
		id: string;
		descopeUserId: string;
		email: string;
		role: "owner" | "admin" | "member";
		status?: "active" | "deactivated";
	},
): Promise<void> {
	await db.insert(organizationMembers).values({
		id: opts.id,
		organizationId: ORG,
		descopeUserId: opts.descopeUserId,
		email: opts.email,
		role: opts.role,
		status: opts.status ?? "active",
	});
}

/**
 * The producer shape, field for field: apps/api/src/rpc/routers/kernel/turn-work.ts
 * builds this `HomeToolWritePayload` and stores it in `tedi_approval_requests.payload`.
 * `initiatedByUserId` lives INSIDE the payload — there is no such column on the
 * approval row — so the fixture must nest it exactly the way the wire does.
 */
function homeToolWritePayload(initiatedByUserId: string): HomeToolWritePayload {
	return {
		kind: HOME_TOOL_WRITE_KIND,
		appSlug: "globex-tedix",
		toolName: "create_invoice",
		args: { amount: 10 },
		organizationId: ORG,
		homeRunId: "run-1",
		conversationId: "home:main",
		initiatedByUserId,
		transport: "direct",
	};
}

function escalation() {
	return {
		organizationId: ORG,
		escalated: [{ id: MIRROR_ID, approvalRequestId: APPROVAL_ID }],
		escalatedAt: ESCALATED_AT,
	};
}

function emailEnv(
	send = vi.fn().mockResolvedValue({ messageId: "m1" }),
): ApprovalEscalationEnv & { EMAIL: SendEmail } {
	return { EMAIL: { send } as unknown as SendEmail };
}

async function auditRows(db: DbClient) {
	const { data } = await searchAuditEvents(db, {
		organizationId: ORG,
		action: "approval.escalated",
	});
	return data;
}

function only<T>(values: T[]): T {
	expect(values).toHaveLength(1);
	const value = values[0];
	if (value === undefined) throw new Error("expected exactly one value");
	return value;
}

/** The message the `EMAIL` binding actually received (Cloudflare address shape). */
function sentMessage(env: { EMAIL: SendEmail }): {
	to: unknown;
	subject: string;
	text: string;
} {
	const call = (env.EMAIL.send as ReturnType<typeof vi.fn>).mock.calls[0];
	if (!call) throw new Error("EMAIL.send was never called");
	return call[0] as { to: unknown; subject: string; text: string };
}

function warnSignals(warn: {
	mock: { calls: unknown[][] };
}): Array<Record<string, unknown>> {
	return warn.mock.calls.map(
		(call) => JSON.parse(String(call[0])) as Record<string, unknown>,
	);
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("notifyApprovalEscalation", () => {
	it("pages the org's active owners and records the delivered channel", async () => {
		const { db } = fixture();
		await seedApproval(db);
		await seedMember(db, {
			id: "m-owner",
			descopeUserId: "U-owner",
			email: "owner@example.com",
			role: "owner",
		});
		await seedMember(db, {
			id: "m-member",
			descopeUserId: "U-member",
			email: "member@example.com",
			role: "member",
		});
		const env = emailEnv();

		const outcome = only(await notifyApprovalEscalation(env, db, escalation()));

		expect(outcome).toMatchObject({
			approvalRequestId: APPROVAL_ID,
			skipped: false,
			delivered: true,
			channels: ["email"],
			recipientSource: "owners",
			recipientCount: 1,
		});
		expect(env.EMAIL.send).toHaveBeenCalledTimes(1);
		const sent = sentMessage(env);
		expect(sent.to).toEqual(["owner@example.com"]);
		expect(sent.subject).toContain("create_invoice");
		expect(sent.text).toContain(APPROVAL_ID);

		const rows = await auditRows(db);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.resourceId).toBe(APPROVAL_ID);
		expect(rows[0]?.metadata?.notification).toMatchObject({
			delivered: true,
			channels: ["email"],
			recipientSource: "owners",
			recipientCount: 1,
			webhookConfigured: false,
		});
	});

	it("prefers the initiator carried inside the stored write payload", async () => {
		const { db } = fixture();
		await seedApproval(db, { payload: homeToolWritePayload("U-initiator") });
		await seedMember(db, {
			id: "m-initiator",
			descopeUserId: "U-initiator",
			email: "initiator@example.com",
			role: "member",
		});
		await seedMember(db, {
			id: "m-owner",
			descopeUserId: "U-owner",
			email: "owner@example.com",
			role: "owner",
		});
		const env = emailEnv();

		const outcome = only(await notifyApprovalEscalation(env, db, escalation()));

		expect(outcome).toMatchObject({
			recipientSource: "initiator",
			recipientCount: 1,
			delivered: true,
		});
		const sent = sentMessage(env);
		expect(sent.to).toEqual(["initiator@example.com"]);
	});

	it("falls back to owners when the initiator is no longer an active member", async () => {
		const { db } = fixture();
		await seedApproval(db, { payload: homeToolWritePayload("U-initiator") });
		await seedMember(db, {
			id: "m-initiator",
			descopeUserId: "U-initiator",
			email: "initiator@example.com",
			role: "member",
			status: "deactivated",
		});
		await seedMember(db, {
			id: "m-owner",
			descopeUserId: "U-owner",
			email: "owner@example.com",
			role: "owner",
		});
		const env = emailEnv();

		const outcome = only(await notifyApprovalEscalation(env, db, escalation()));

		expect(outcome.recipientSource).toBe("owners");
		const sent = sentMessage(env);
		expect(sent.to).toEqual(["owner@example.com"]);
	});

	it("falls back to active admins when the org has no active owner", async () => {
		const { db } = fixture();
		await seedApproval(db);
		await seedMember(db, {
			id: "m-owner",
			descopeUserId: "U-owner",
			email: "owner@example.com",
			role: "owner",
			status: "deactivated",
		});
		await seedMember(db, {
			id: "m-admin",
			descopeUserId: "U-admin",
			email: "admin@example.com",
			role: "admin",
		});

		const outcome = only(
			await notifyApprovalEscalation(emailEnv(), db, escalation()),
		);

		expect(outcome.recipientSource).toBe("admins");
	});

	it("does not page when the approval resolved before the send", async () => {
		const { db } = fixture();
		await seedApproval(db, { status: "approved" });
		await seedMember(db, {
			id: "m-owner",
			descopeUserId: "U-owner",
			email: "owner@example.com",
			role: "owner",
		});
		const env = emailEnv();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		const outcome = only(await notifyApprovalEscalation(env, db, escalation()));

		expect(outcome).toMatchObject({ skipped: true, delivered: false });
		expect(env.EMAIL.send).not.toHaveBeenCalled();
		// A resolved approval is not a broken route; it must not be reported as one.
		expect(warn).not.toHaveBeenCalled();
		expect(await auditRows(db)).toHaveLength(0);
	});

	it("makes a MISSING route loud instead of a silent no-op", async () => {
		const { db } = fixture();
		await seedApproval(db);
		// No members at all and no webhook: there is nowhere to send.
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const env = emailEnv();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		const outcome = only(await notifyApprovalEscalation(env, db, escalation()));

		expect(outcome).toMatchObject({
			skipped: false,
			delivered: false,
			channels: [],
			recipientSource: "none",
			recipientCount: 0,
			failure: "no_route_configured",
		});
		expect(env.EMAIL.send).not.toHaveBeenCalled();
		expect(fetchSpy).not.toHaveBeenCalled();

		const warned = warnSignals(warn);
		expect(warned).toContainEqual({
			signal: "approval.escalation.undelivered",
			organizationId: ORG,
			approvalRequestId: APPROVAL_ID,
			mirrorId: MIRROR_ID,
			recipientSource: "none",
			recipientCount: 0,
			webhookConfigured: false,
			reason: "no_route_configured",
		});

		// Recorded too — an escalation nobody received is still evidence, and the
		// row must not claim a delivery that never happened.
		const rows = await auditRows(db);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.metadata?.notification).toMatchObject({
			delivered: false,
			channels: [],
			failure: "no_route_configured",
		});
	});

	it("keeps a BROKEN route distinguishable from a missing one", async () => {
		const { db } = fixture();
		await seedApproval(db);
		await seedMember(db, {
			id: "m-owner",
			descopeUserId: "U-owner",
			email: "owner@example.com",
			role: "owner",
		});
		// A recipient exists, but the EMAIL binding is absent — configured, broken.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		const outcome = only(await notifyApprovalEscalation({}, db, escalation()));

		expect(outcome).toMatchObject({
			delivered: false,
			channels: [],
			recipientSource: "owners",
			recipientCount: 1,
			failure: "delivery_failed",
		});
		const warned = warnSignals(warn);
		expect(warned[0]).toMatchObject({
			signal: "approval.escalation.undelivered",
			reason: "delivery_failed",
			recipientSource: "owners",
		});
		expect((await auditRows(db))[0]?.metadata?.notification).toMatchObject({
			delivered: false,
			failure: "delivery_failed",
		});
	});

	it("uses the webhook backstop when the org has no reachable member", async () => {
		const { db } = fixture();
		await seedApproval(db);
		const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
		vi.stubGlobal("fetch", fetchSpy);

		const outcome = only(
			await notifyApprovalEscalation(
				{ HEALTH_ALERT_WEBHOOK: "https://hooks.example.com/ops" },
				db,
				escalation(),
			),
		);

		expect(outcome).toMatchObject({
			delivered: true,
			channels: ["webhook"],
			recipientSource: "none",
		});
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const post = only(fetchSpy.mock.calls)[1] as { body: string };
		const body = JSON.parse(post.body) as { meta: Record<string, unknown> };
		expect(body.meta).toMatchObject({
			kind: "approval.escalated",
			approvalRequestId: APPROVAL_ID,
			mirrorId: MIRROR_ID,
		});
	});

	it("records one evidence row even if the notifier is re-driven", async () => {
		const { db } = fixture();
		await seedApproval(db);
		await seedMember(db, {
			id: "m-owner",
			descopeUserId: "U-owner",
			email: "owner@example.com",
			role: "owner",
		});
		const env = emailEnv();

		await notifyApprovalEscalation(env, db, escalation());
		await notifyApprovalEscalation(env, db, escalation());

		expect(await auditRows(db)).toHaveLength(1);
	});
});
