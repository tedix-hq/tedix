/**
 * Every admission-plane rejection is a typed client error.
 *
 * The admission queries throw `WorkControlError` / `WorkAdmissionError`; the
 * attempt ledger throws `WorkFactoryError`. `startAttempt` and
 * `replaceAdmissionSpecification` used to map only the ledger's errors, so a
 * "Resource <key> lacks capacity" verdict or a specification naming a pool
 * that does not exist surfaced as HTTP 500 instead of a rejection the caller
 * can act on.
 */

import { ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
	WorkAdmissionError,
	WorkAdmissionSpecificationError,
} from "@tedix/db/queries/work-items/admissions";
import type { BaseContext } from "../../orpc";

/** Neither error leaf is an exported subpath; both mappers key on name + code. */
function namedError(name: string, code: string, message: string) {
	return Object.assign(new Error(`${code}: ${message}`), { name, code });
}
const workControlError = (code: string, message: string) =>
	namedError("WorkControlError", code, message);

const mocks = vi.hoisted(() => ({
	access: vi.fn(),
	ownerAdmin: vi.fn(),
	external: vi.fn(),
	tediAccess: vi.fn(),
	start: vi.fn(),
	admit: vi.fn(),
	replace: vi.fn(),
	readiness: vi.fn(),
	preview: vi.fn(),
	grant: vi.fn(),
}));

vi.mock("./policy-helpers", async (importOriginal) => ({
	...(await importOriginal<typeof import("./policy-helpers")>()),
	assertWorkItemAccess: mocks.access,
	requireOwnerAdminWorkItemAuthor: mocks.ownerAdmin,
}));
vi.mock("../work-items-principal", async (importOriginal) => ({
	...(await importOriginal<typeof import("../work-items-principal")>()),
	verifiedExternalAgent: mocks.external,
	assertTediAccess: mocks.tediAccess,
}));
vi.mock("@tedix/db/queries/work-items/attempts", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/work-items/attempts")
	>()),
	startWorkItemAttempt: mocks.start,
}));
vi.mock("@tedix/db/queries/work-items/admissions", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/work-items/admissions")
	>()),
	replaceWorkAdmissionSpecification: mocks.replace,
}));
vi.mock("@tedix/db/queries/work-items/lane-attempt-grants", () => ({
	grantLaneAttempt: mocks.grant,
}));
vi.mock("@tedix/db/queries/work-items/readiness", () => ({
	deriveWorkItemReadiness: mocks.readiness,
}));
vi.mock("./attempt-admission", () => ({
	admitWorkAttempt: mocks.admit,
	previewWorkAttempt: mocks.preview,
}));

import {
	grantLaneAttemptProcedure,
	replaceAdmissionSpecificationProcedure,
	startAttemptProcedure,
	getReadinessProcedure,
} from "./factory-lifecycle";

const workItem = {
	id: "11111111-1111-4111-8111-111111111111",
	orgId: "org-1",
	version: 3,
	admissionSpecRevision: "rev-3",
	accountableOwnerType: null,
	accountableOwnerId: null,
};

function start() {
	return startAttemptProcedure["~orpc"].handler!({
		input: { id: workItem.id },
		context: { db: {}, tediId: "tedi-1" } as BaseContext,
		path: ["workItems", "startAttempt"],
		procedure: startAttemptProcedure,
		signal: undefined,
		lastEventId: undefined,
	});
}

function replace() {
	return replaceAdmissionSpecificationProcedure["~orpc"].handler!({
		input: {
			id: workItem.id,
			expectedWorkItemVersion: 3,
			expectedAdmissionSpecRevision: "rev-3",
			specification: {
				resources: [{ resourceKey: "file:repo:missing.ts", quantity: 1 }],
				budget: null,
			},
		},
		context: { db: {}, userId: "user-1" } as BaseContext,
		path: ["workItems", "replaceAdmissionSpecification"],
		procedure: replaceAdmissionSpecificationProcedure,
		signal: undefined,
		lastEventId: undefined,
	});
}

async function caught(run: () => Promise<unknown>) {
	try {
		await run();
	} catch (error) {
		return error;
	}
	throw new Error("expected the handler to reject");
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.access.mockResolvedValue(workItem);
	mocks.ownerAdmin.mockResolvedValue("user-1");
	mocks.external.mockResolvedValue(null);
	mocks.tediAccess.mockResolvedValue(undefined);
	mocks.readiness.mockResolvedValue({
		workItemId: workItem.id,
		state: "evaluation_required",
		ready: false,
		derivedAt: "2026-11-08T00:00:00.000Z",
		reasons: [
			{
				code: "evaluation_required",
				detail: "Applicable budget envelope was not evaluated",
			},
		],
		gates: [
			"disposition",
			"purpose",
			"dependencies",
			"capabilities",
			"approvals",
			"risk",
			"budget",
			"resources",
			"attempt",
		].map((gate) => ({
			gate,
			evaluation: ["budget", "resources"].includes(gate) ? "unknown" : "passed",
			detail: "Context-free readiness",
		})),
	});
});

function readiness(context: Partial<BaseContext> = {}) {
	return getReadinessProcedure["~orpc"].handler!({
		input: { id: workItem.id },
		context: { db: {}, ...context } as BaseContext,
		path: ["workItems", "getReadiness"],
		procedure: getReadinessProcedure,
		signal: undefined,
		lastEventId: undefined,
	});
}

describe("verified executor readiness", () => {
	it("keeps generic owner readiness unevaluated", async () => {
		expect(await readiness()).toMatchObject({
			ready: false,
			state: "evaluation_required",
		});
		expect(mocks.preview).not.toHaveBeenCalled();
	});
	it("previews the credential-derived external session without accepting caller facts", async () => {
		mocks.external.mockResolvedValue({
			executor: { type: "external_agent", id: "agent", sessionId: "session" },
			externalSessionKey: "codex:session",
		});
		mocks.preview.mockResolvedValue({});
		const result = await readiness();
		expect(mocks.preview).toHaveBeenCalledWith(
			{},
			expect.objectContaining({
				executor: { type: "external_agent", id: "agent", sessionId: "session" },
				externalSessionKey: "codex:session",
				workItem: expect.objectContaining({ version: 3 }),
			}),
		);
		expect(result).toMatchObject({ ready: true, state: "ready", reasons: [] });
		expect(result.gates.every((gate) => gate.evaluation === "passed")).toBe(
			true,
		);
	});
	it("checks access before previewing an authenticated tedi", async () => {
		mocks.preview.mockResolvedValue({});
		await readiness({ tediId: "tedi-1" });
		expect(mocks.tediAccess).toHaveBeenCalledWith(
			expect.anything(),
			"tedi-1",
			workItem.orgId,
		);
		expect(mocks.preview).toHaveBeenCalledWith(
			{},
			expect.objectContaining({ executor: { type: "tedi", id: "tedi-1" } }),
		);
	});
	it("does not fall back when the supplied external session fails verification", async () => {
		mocks.external.mockRejectedValue(
			new ORPCError("UNAUTHORIZED", { message: "Inactive session" }),
		);
		await expect(readiness()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.preview).not.toHaveBeenCalled();
	});
	it.each(["budget_blocked", "resource_blocked", "evaluation_required"])(
		"retains %s and represents unevaluated actor gates honestly",
		async (code) => {
			mocks.preview.mockResolvedValue({
				rejection: { code, reason: "Canonical evaluator withheld execution" },
			});
			const result = await readiness({ tediId: "tedi-1" });
			expect(result).toMatchObject({ ready: false, state: code });
			const gate = code === "budget_blocked" ? "budget" : "resources";
			expect(result.gates.find((g) => g.gate === gate)).toMatchObject({
				evaluation: code === "evaluation_required" ? "unknown" : "failed",
				detail: "Canonical evaluator withheld execution",
			});
		},
	);
});

describe("startAttempt admission rejections", () => {
	it("maps an evaluated admission rejection to CONFLICT with its rejection code", async () => {
		mocks.admit.mockRejectedValue(
			new WorkAdmissionError(
				"resource_blocked",
				"Resource file:repo:a.ts lacks capacity",
			),
		);
		const error = await caught(start);
		expect(error).toBeInstanceOf(ORPCError);
		expect(error).toMatchObject({
			code: "CONFLICT",
			data: {
				rejectionCode: "resource_blocked",
				reason: "Resource file:repo:a.ts lacks capacity",
			},
		});
	});

	it("maps a budget rejection the same way", async () => {
		mocks.admit.mockRejectedValue(
			new WorkAdmissionError("budget_blocked", "Budget env-1 lacks capacity"),
		);
		expect(await caught(start)).toMatchObject({
			code: "CONFLICT",
			data: { rejectionCode: "budget_blocked" },
		});
	});

	it("maps a control-plane conflict from the admission queries to CONFLICT, not 500", async () => {
		mocks.admit.mockRejectedValue(
			workControlError("CONFLICT", "Work Item specification changed"),
		);
		expect(await caught(start)).toMatchObject({ code: "CONFLICT" });
	});

	it("still maps ledger errors from the attempt write", async () => {
		mocks.admit.mockResolvedValue({
			id: "adm-1",
			expiresAt: "2026-09-29T12:05:00.000Z",
		});
		mocks.start.mockRejectedValue(
			namedError(
				"WorkFactoryError",
				"STALE_ATTEMPT",
				"Attempt lost the admission race",
			),
		);
		expect(await caught(start)).toMatchObject({ code: "CONFLICT" });
	});

	it("does not swallow unrelated failures", async () => {
		mocks.admit.mockRejectedValue(new TypeError("boom"));
		expect(await caught(start)).toBeInstanceOf(TypeError);
	});
});

describe("replaceAdmissionSpecification rejections", () => {
	it("returns UNPROCESSABLE_CONTENT naming the resource keys without a pool", async () => {
		mocks.replace.mockRejectedValue(
			new WorkAdmissionSpecificationError([
				"file:repo:missing.ts",
				"feature:repo:x",
			]),
		);
		const error = await caught(replace);
		expect(error).toBeInstanceOf(ORPCError);
		expect(error).toMatchObject({
			code: "UNPROCESSABLE_CONTENT",
			data: { missingResourceKeys: ["file:repo:missing.ts", "feature:repo:x"] },
		});
		expect((error as ORPCError<string, unknown>).message).toContain(
			"file:repo:missing.ts",
		);
	});

	it("maps the batch-level pool race to CONFLICT", async () => {
		mocks.replace.mockRejectedValue(
			workControlError(
				"CONFLICT",
				"Admission specification lost its update race or references an unavailable pool",
			),
		);
		expect(await caught(replace)).toMatchObject({ code: "CONFLICT" });
	});
});

describe("grantLaneAttempt", () => {
	const attemptId = "22222222-2222-4222-8222-222222222222";
	function grant(context: Partial<BaseContext>) {
		return grantLaneAttemptProcedure["~orpc"].handler!({
			input: { id: workItem.id, attemptId, reason: "Wasted rerun" },
			context: { db: {}, userId: "user-1", ...context } as BaseContext,
			path: ["workItems", "grantLaneAttempt"],
			procedure: grantLaneAttemptProcedure,
			signal: undefined,
			lastEventId: undefined,
		});
	}

	it.each([
		{ externalAgentSessionId: "agent-session" },
		{ ownerHostSessionId: "owner-host-session" },
	])(
		"refuses an agent session before recording anything (%o)",
		async (context) => {
			const error = await caught(() => grant(context));
			expect(error).toBeInstanceOf(ORPCError);
			expect((error as ORPCError<string, unknown>).code).toBe("FORBIDDEN");
			expect(mocks.grant).not.toHaveBeenCalled();
		},
	);

	it("records the owner as the grantor of the named Attempt", async () => {
		mocks.grant.mockResolvedValue({ id: "grant-1" });
		await grant({});
		expect(mocks.ownerAdmin).toHaveBeenCalledWith(
			expect.anything(),
			workItem.orgId,
			"Granting a lane Attempt",
		);
		expect(mocks.grant).toHaveBeenCalledWith(
			{},
			expect.objectContaining({
				orgId: workItem.orgId,
				workItemId: workItem.id,
				attemptId,
				userId: "user-1",
				reason: "Wasted rerun",
			}),
		);
	});
});
