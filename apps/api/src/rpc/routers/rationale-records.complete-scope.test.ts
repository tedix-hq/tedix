import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";

/**
 * Adversarial-review regression suite: complete_rationale had no
 * cross-tenant guard — any org-scoped caller could complete (and via the
 * idempotency path, read) ANY org's rationale records by id. The handler now
 * carries the same `existing.orgId !== orgId → FORBIDDEN` check as
 * delete/getById, placed BEFORE the idempotency short-circuit; platform
 * principals (no org context) remain exempt.
 */

const mocks = vi.hoisted(() => ({
	getRationaleRecordById: vi.fn(),
	completeRationaleRecord: vi.fn(),
}));

vi.mock("@tedix/db/queries/rationale-records", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/rationale-records")
	>()),
	getRationaleRecordById: mocks.getRationaleRecordById,
	completeRationaleRecord: mocks.completeRationaleRecord,
}));

import { rationaleRecordsContractRouter } from "./rationale-records";

const RECORD_ID = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

function recordFixture(overrides: Record<string, unknown> = {}) {
	return {
		id: RECORD_ID,
		tediId: "tedi-1",
		orgId: "org-2",
		action: "deploy",
		rationale: "because the canary was green",
		category: "operations",
		confidence: 0.9,
		evidence: {},
		outcome: "deployed",
		outcomeStatus: "success",
		approvalRequestId: null,
		objectiveId: null,
		runId: "run-1",
		workItemId: null,
		toolCallRefs: null,
		proofRef: null,
		createdAt: "2026-07-15T00:00:00.000Z",
		completedAt: "2026-07-15T01:00:00.000Z",
		blameChain: null,
		...overrides,
	};
}

function createContext(organizationId: string | undefined): BaseContext {
	return {
		authType: "apikey",
		apiKey: {
			id: "api-key-1",
			name: "test",
			organizationId,
			scopes: ["*"],
		},
		db: {} as BaseContext["db"],
		env: { ENVIRONMENT: "test" } as CloudflareEnv,
		headers: new Headers(),
		...(organizationId ? { organizationId } : {}),
		rateLimiter: {
			limit: vi.fn(async () => ({ success: true })),
		} as unknown as RateLimit,
		url: new URL("https://api.tedix.test/rpc/rationale-records"),
		user: undefined,
	} as BaseContext;
}

function createClient(context: BaseContext) {
	return createRouterClient(rationaleRecordsContractRouter, { context });
}

describe("rationaleRecords.complete cross-tenant guard (A2)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("rejects an org-1 caller completing an org-2 pending record", async () => {
		mocks.getRationaleRecordById.mockResolvedValue(
			recordFixture({
				outcomeStatus: "pending",
				outcome: null,
				completedAt: null,
			}),
		);
		const client = createClient(createContext("org-1"));
		await expect(
			client.complete({
				id: RECORD_ID,
				outcome: "done",
				outcomeStatus: "success",
			}),
		).rejects.toThrow(/Access denied/);
		expect(mocks.completeRationaleRecord).not.toHaveBeenCalled();
	});

	it("rejects a cross-org IDEMPOTENT replay too — the gate sits before the short-circuit", async () => {
		// Completed record: the idempotency path would RETURN the record
		// (a read) if the org gate came after it.
		mocks.getRationaleRecordById.mockResolvedValue(recordFixture());
		const client = createClient(createContext("org-1"));
		await expect(
			client.complete({
				id: RECORD_ID,
				outcome: "deployed",
				outcomeStatus: "success",
			}),
		).rejects.toThrow(/Access denied/);
		expect(mocks.completeRationaleRecord).not.toHaveBeenCalled();
	});

	it("same-org idempotent replay still works", async () => {
		mocks.getRationaleRecordById.mockResolvedValue(
			recordFixture({
				orgId: "org-1",
				proofRef: { kind: "run", ref: "run-1" },
			}),
		);
		const client = createClient(createContext("org-1"));
		await expect(
			client.complete({
				id: RECORD_ID,
				outcome: "deployed",
				outcomeStatus: "success",
			}),
		).resolves.toMatchObject({ id: RECORD_ID, orgId: "org-1" });
		expect(mocks.completeRationaleRecord).not.toHaveBeenCalled();
	});

	it("platform principals without org context remain exempt (delete-parity)", async () => {
		// No organizationId in context — getOrganizationId() returns null and
		// the guard does not arm, matching deleteProcedure's semantics.
		mocks.getRationaleRecordById.mockResolvedValue(recordFixture());
		const client = createClient(createContext(undefined));
		await expect(
			client.complete({
				id: RECORD_ID,
				outcome: "deployed",
				outcomeStatus: "success",
			}),
		).resolves.toMatchObject({ id: RECORD_ID, orgId: "org-2" });
	});
});
