/**
 * Auto-approval rules router: tenant binding, rule lifecycle, and the apply
 * sweep — proven against a real D1 facade, with the sweep resolving pending
 * approvals through the REAL `tediApprovals.resolve` procedure (only its
 * Home-settlement hook, audit writer, and learning recorder are stubbed).
 */

import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { createApprovalRequest } from "@tedix/db/queries/approvals";
import { tediApprovalRequests } from "@tedix/db/schema/approvals";
import {
	tediApprovalDependencyEvents,
	tediApprovalSimulations,
} from "@tedix/db/schema/approval-simulations";
import { osApprovalRules } from "@tedix/db/schema/os-approval-rules";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";

const mocks = vi.hoisted(() => ({
	settleHomeToolWriteApproval: vi.fn(async () => {}),
	insertAuditEvent: vi.fn(async () => ({}) as never),
	recordObservedLearningInteraction: vi.fn(async () => true),
}));

// The sweep must run the canonical resolve procedure end to end; only its
// side-effect hooks are stubbed, never the pending→resolved write itself.
vi.mock("./kernel/write-approval-settlement", () => ({
	settleHomeToolWriteApproval: mocks.settleHomeToolWriteApproval,
}));
vi.mock("@tedix/db/queries/audit", () => ({
	insertAuditEvent: mocks.insertAuditEvent,
}));
vi.mock("../../services/learning-interaction-recorder", () => ({
	recordObservedLearningInteraction: mocks.recordObservedLearningInteraction,
}));

import { osApprovalRulesContractRouter } from "./os-approval-rules";

const FUTURE = "2030-01-01T00:00:00.000Z";

function createFixture() {
	const sqlite = new DatabaseSync(":memory:");
	// The router binds the caller's organization into every predicate; parent
	// tables (organizations, tedis) are not needed. FKs stay off.
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(
		schemaDdl(
			tediApprovalRequests,
			tediApprovalSimulations,
			tediApprovalDependencyEvents,
			osApprovalRules,
		),
	);
	const facade = createD1Facade(sqlite);
	const env = { ENVIRONMENT: "test", DB: facade } as CloudflareEnv;
	const db = createDbClient(facade);
	return { env, db };
}

type Fixture = ReturnType<typeof createFixture>;

function userContext(
	fixture: Fixture,
	organizationId: string,
	permissions: string[] = ["settings:manage", "tedis:read"],
): BaseContext {
	return {
		authType: "user",
		db: fixture.db as BaseContext["db"],
		env: fixture.env,
		headers: new Headers(),
		organizationId,
		url: new URL("https://api.tedix.test/rpc/approvalRules"),
		user: {
			aud: "test",
			dct: "tenant-1",
			exp: 2,
			iat: 1,
			iss: "https://auth.tedix.test",
			permissions,
			roles: [],
			sub: "user-1",
		},
	} as BaseContext;
}

function apiKeyContext(
	fixture: Fixture,
	organizationId: string,
	scopes: string[],
): BaseContext {
	return {
		apiKey: { id: "key-1", name: "test", organizationId, scopes },
		authType: "apikey",
		db: fixture.db as BaseContext["db"],
		env: fixture.env,
		headers: new Headers(),
		organizationId,
		url: new URL("https://api.tedix.test/rpc/approvalRules"),
	} as BaseContext;
}

async function seedApproval(
	fixture: Fixture,
	overrides: {
		id: string;
		orgId?: string;
		actionType?: string;
		expiresAt?: string;
	},
) {
	await createApprovalRequest(fixture.db, {
		id: overrides.id,
		tediId: "9a8b7c6d-5e4f-4a3b-9c8d-7e6f5a4b3c2d",
		orgId: overrides.orgId ?? "org-1",
		actionType: overrides.actionType ?? "deploy",
		description: "Approve the action",
		payload: { kind: "test" },
		createdAt: "2026-08-15T10:00:00.000Z",
		expiresAt: overrides.expiresAt ?? FUTURE,
	});
}

async function approvalRow(fixture: Fixture, id: string) {
	const [row] = await fixture.db
		.select()
		.from(tediApprovalRequests)
		.where(eq(tediApprovalRequests.id, id));
	return row;
}

function clients(fixture: Fixture) {
	return {
		org1: createRouterClient(osApprovalRulesContractRouter, {
			context: userContext(fixture, "org-1"),
		}),
		org2: createRouterClient(osApprovalRulesContractRouter, {
			context: userContext(fixture, "org-2"),
		}),
	};
}

beforeEach(() => {
	mocks.settleHomeToolWriteApproval.mockClear();
	mocks.insertAuditEvent.mockClear();
	mocks.recordObservedLearningInteraction.mockClear();
});

describe("rule lifecycle", () => {
	it("creates an enabled approve rule with creator accountability", async () => {
		const fixture = createFixture();
		const c = clients(fixture);

		const { rule } = await c.org1.create({ actionKind: "deploy" });
		expect(rule).toMatchObject({
			organizationId: "org-1",
			actionKind: "deploy",
			decision: "approve",
			enabled: true,
			createdByKind: "user",
			createdById: "user-1",
			disabledAt: null,
		});
	});

	it("is idempotent per kind: a second create returns the standing rule", async () => {
		const fixture = createFixture();
		const c = clients(fixture);

		const first = await c.org1.create({ actionKind: "deploy" });
		const second = await c.org1.create({ actionKind: "deploy" });
		expect(second.rule.id).toBe(first.rule.id);
		expect((await c.org1.list()).items).toHaveLength(1);

		// A disabled rule does not satisfy the idempotency check — re-clicking
		// "always approve" after a disable creates a fresh enabled rule.
		await c.org1.setEnabled({ ruleId: first.rule.id, enabled: false });
		const third = await c.org1.create({ actionKind: "deploy" });
		expect(third.rule.id).not.toBe(first.rule.id);
	});

	it("lists per organization and toggles enabled with disabledAt", async () => {
		const fixture = createFixture();
		const c = clients(fixture);

		const { rule } = await c.org1.create({ actionKind: "deploy" });
		expect((await c.org2.list()).items).toHaveLength(0);

		const disabled = await c.org1.setEnabled({
			ruleId: rule.id,
			enabled: false,
		});
		expect(disabled.rule.enabled).toBe(false);
		expect(disabled.rule.disabledAt).toEqual(expect.any(String));

		const enabled = await c.org1.setEnabled({ ruleId: rule.id, enabled: true });
		expect(enabled.rule.enabled).toBe(true);
		expect(enabled.rule.disabledAt).toBeNull();

		// Cross-tenant toggling never resolves the rule.
		await expect(
			c.org2.setEnabled({ ruleId: rule.id, enabled: false }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("requires disable before permanent deletion and remains tenant-bound", async () => {
		const fixture = createFixture();
		const c = clients(fixture);
		const { rule } = await c.org1.create({ actionKind: "deploy" });

		await expect(c.org1.delete({ ruleId: rule.id })).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		await c.org1.setEnabled({ ruleId: rule.id, enabled: false });
		await expect(c.org2.delete({ ruleId: rule.id })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		await expect(c.org1.delete({ ruleId: rule.id })).resolves.toEqual({
			deleted: true,
		});
		expect((await c.org1.list()).items).toHaveLength(0);
	});

	it("enforces the machine scope plane", async () => {
		const fixture = createFixture();
		const admin = createRouterClient(osApprovalRulesContractRouter, {
			context: apiKeyContext(fixture, "org-1", ["mcp:memory.admin"]),
		});
		const { rule } = await admin.create({ actionKind: "deploy" });
		expect(rule).toMatchObject({
			createdByKind: "service",
			createdById: "key-1",
		});
		await expect(admin.apply()).resolves.toMatchObject({ resolved: 0 });

		const underScoped = createRouterClient(osApprovalRulesContractRouter, {
			context: apiKeyContext(fixture, "org-1", ["apps:write"]),
		});
		await expect(
			underScoped.create({ actionKind: "deploy" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(underScoped.apply()).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
});

describe("verb matrix", () => {
	it("os:approve creates, toggles, and applies rules through the canonical resolve path", async () => {
		const fixture = createFixture();
		const approver = createRouterClient(osApprovalRulesContractRouter, {
			context: userContext(fixture, "org-1", ["os:approve"]),
		});
		await seedApproval(fixture, { id: "11111111-1111-4111-8111-111111111111" });

		const { rule } = await approver.create({ actionKind: "deploy" });
		await approver.setEnabled({ ruleId: rule.id, enabled: true });
		// The sweep runs the REAL tediApprovals.resolve per match, so this proves
		// resolve itself accepts os:approve (the shared AUTHZ.osApprove guard).
		await expect(approver.apply()).resolves.toMatchObject({ resolved: 1 });
		expect(
			(await approvalRow(fixture, "11111111-1111-4111-8111-111111111111"))
				?.status,
		).toBe("approved");

		// os:approve alone carries no read verb.
		await expect(approver.list()).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});

	it("os:read lists rules but cannot manage or sweep them", async () => {
		const fixture = createFixture();
		const reader = createRouterClient(osApprovalRulesContractRouter, {
			context: userContext(fixture, "org-1", ["os:read"]),
		});

		await expect(reader.list()).resolves.toEqual({ items: [] });
		await expect(reader.create({ actionKind: "deploy" })).rejects.toMatchObject(
			{ code: "FORBIDDEN" },
		);
		await expect(reader.apply()).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});

describe("apply sweep", () => {
	it("resolves matching pending approvals through the canonical path, org-scoped", async () => {
		const fixture = createFixture();
		const c = clients(fixture);
		await seedApproval(fixture, { id: "11111111-1111-4111-8111-111111111111" });
		await seedApproval(fixture, { id: "22222222-2222-4222-8222-222222222222" });
		await seedApproval(fixture, {
			id: "33333333-3333-4333-8333-333333333333",
			actionType: "cron_job", // no rule for this kind
		});
		await seedApproval(fixture, {
			id: "44444444-4444-4444-8444-444444444444",
			orgId: "org-2", // same kind, different tenant
		});

		const { rule } = await c.org1.create({ actionKind: "deploy" });
		const swept = await c.org1.apply();
		expect(swept.resolved).toBe(2);
		expect(swept.ruleMatches).toHaveLength(2);
		for (const match of swept.ruleMatches) {
			expect(match.ruleId).toBe(rule.id);
		}

		const resolved = await approvalRow(
			fixture,
			"11111111-1111-4111-8111-111111111111",
		);
		expect(resolved).toMatchObject({
			status: "approved",
			resolvedBy: "user-1",
			resolution: `auto-approved by rule ${rule.id}`,
		});
		expect(resolved?.resolvedAt).toEqual(expect.any(String));

		// The unmatched kind and the other tenant stayed pending.
		expect(
			(await approvalRow(fixture, "33333333-3333-4333-8333-333333333333"))
				?.status,
		).toBe("pending");
		expect(
			(await approvalRow(fixture, "44444444-4444-4444-8444-444444444444"))
				?.status,
		).toBe("pending");

		// Canonical-path side effects ran once per resolution.
		expect(mocks.settleHomeToolWriteApproval).toHaveBeenCalledTimes(2);
		expect(mocks.recordObservedLearningInteraction).toHaveBeenCalledTimes(2);
		const auditActions = mocks.insertAuditEvent.mock.calls.map(
			(call) => (call[1] as unknown as { action: string }).action,
		);
		expect(
			auditActions.filter((action) => action === "approval.approved"),
		).toHaveLength(2);
		// Plus the OS governance trail: creating the rule, and ONE sweep row for
		// the rule that fired (deduped per rule, not per resolved approval).
		expect(auditActions.filter((action) => action.startsWith("os."))).toEqual([
			"os.approval_rule.created",
			"os.approval_rule.applied",
		]);

		// Idempotent: a second sweep finds nothing left to resolve.
		await expect(c.org1.apply()).resolves.toEqual({
			resolved: 0,
			ruleMatches: [],
		});
	});

	it("ignores disabled rules and resumes when re-enabled", async () => {
		const fixture = createFixture();
		const c = clients(fixture);
		await seedApproval(fixture, { id: "11111111-1111-4111-8111-111111111111" });

		const { rule } = await c.org1.create({ actionKind: "deploy" });
		await c.org1.setEnabled({ ruleId: rule.id, enabled: false });
		await expect(c.org1.apply()).resolves.toMatchObject({ resolved: 0 });
		expect(
			(await approvalRow(fixture, "11111111-1111-4111-8111-111111111111"))
				?.status,
		).toBe("pending");

		await c.org1.setEnabled({ ruleId: rule.id, enabled: true });
		await expect(c.org1.apply()).resolves.toMatchObject({ resolved: 1 });
	});

	it("skips expired-but-still-pending approvals cleanly", async () => {
		const fixture = createFixture();
		const c = clients(fixture);
		await seedApproval(fixture, {
			id: "11111111-1111-4111-8111-111111111111",
			expiresAt: "2020-01-01T00:00:00.000Z", // TTL elapsed → deny-by-default
		});
		await seedApproval(fixture, { id: "22222222-2222-4222-8222-222222222222" });

		await c.org1.create({ actionKind: "deploy" });
		const swept = await c.org1.apply();
		// The live approval resolved; the expired one was skipped, not failed.
		expect(swept.resolved).toBe(1);
		expect(swept.ruleMatches).toEqual([
			{
				approvalId: "22222222-2222-4222-8222-222222222222",
				ruleId: expect.any(String),
			},
		]);
		expect(
			(await approvalRow(fixture, "11111111-1111-4111-8111-111111111111"))
				?.status,
		).toBe("pending");
	});
});
