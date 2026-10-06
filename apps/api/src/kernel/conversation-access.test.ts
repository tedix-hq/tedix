import type { DbClient } from "@tedix/db/client";
import type { KernelConversationGrant } from "@tedix/db/schema";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { resolveKernelConversationAccess } from "./conversation-access";

/**
 * Build a fake DbClient whose grant-listing query resolves to `rows`.
 * Mirrors the `db.select().from().where().limit()` chain awaited by
 * `listKernelConversationGrants`.
 */
function dbReturning(rows: KernelConversationGrant[]): DbClient {
	const limit = () => Promise.resolve(rows);
	const where = () => ({ limit });
	const from = () => ({ where });
	const select = () => ({ from });
	return { select } as unknown as DbClient;
}

/**
 * Build a fake DbClient whose query throws — simulating a DB-layer fault such
 * as a missing migration ("no such table") or a mispointed binding.
 */
function dbThrowing(error: unknown): DbClient {
	const select = () => {
		throw error;
	};
	return { select } as unknown as DbClient;
}

const baseInput = {
	conversationId: "conv-1",
	organizationId: "org-1",
	descopeUserId: "user-1",
	required: "read" as const,
};

describe("resolveKernelConversationAccess", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	// Regression: a DB error (including "no such table" from a missing migration
	// or mispointed D1 binding) must FAIL CLOSED — denying access, never
	// granting an org-wide allow-all. See security/kernel-conversation-failopen.
	it("DENIES access when the grants query hits a missing table", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const db = dbThrowing(
			new Error("D1_ERROR: no such table: kernel_conversation_grants"),
		);

		const decision = await resolveKernelConversationAccess(db, baseInput);

		expect(decision.allowed).toBe(false);
		expect(decision.access).toBeNull();
	});

	it("DENIES access on any other DB error", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const db = dbThrowing(new Error("D1_ERROR: something broke"));

		const decision = await resolveKernelConversationAccess(db, baseInput);

		expect(decision.allowed).toBe(false);
	});

	it("DENIES access when the thrown value is not an Error", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const db = dbThrowing("no such table: kernel_conversation_grants");

		const decision = await resolveKernelConversationAccess(db, baseInput);

		expect(decision.allowed).toBe(false);
	});

	it("logs only safe exception topology when denying on a DB error", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const db = dbThrowing(
			new Error("private SQL and parameter text", {
				cause: new TypeError("private provider token"),
			}),
		);

		const decision = await resolveKernelConversationAccess(db, baseInput);

		expect(decision).toEqual({ allowed: false, access: null, policy: "grant" });
		expect(errorSpy).toHaveBeenCalledOnce();
		expect(errorSpy).toHaveBeenCalledWith({
			component: "api.kernel.conversation-access",
			event: "conversation_access_lookup_failed",
			exception: { type: "Error", cause: { type: "TypeError" } },
		});
		const logged = JSON.stringify(errorSpy.mock.calls);
		for (const privateValue of [
			"private SQL and parameter text",
			"private provider token",
			baseInput.organizationId,
			baseInput.conversationId,
			baseInput.descopeUserId,
		])
			expect(logged).not.toContain(privateValue);
	});

	it("allows org-wide read when a conversation has no grant rows", async () => {
		const db = dbReturning([]);

		const decision = await resolveKernelConversationAccess(db, baseInput);

		expect(decision.allowed).toBe(true);
		expect(decision.policy).toBe("org-wide");
	});

	it("grants access to a matching grantee at sufficient rank", async () => {
		const db = dbReturning([
			{
				granteeDescopeUserId: "user-1",
				access: "edit",
			} as KernelConversationGrant,
		]);

		const decision = await resolveKernelConversationAccess(db, baseInput);

		expect(decision.allowed).toBe(true);
		expect(decision.access).toBe("edit");
		expect(decision.policy).toBe("grant");
	});

	it("denies a user who has no matching grant on a granted conversation", async () => {
		const db = dbReturning([
			{
				granteeDescopeUserId: "someone-else",
				access: "owner",
			} as KernelConversationGrant,
		]);

		const decision = await resolveKernelConversationAccess(db, baseInput);

		expect(decision.allowed).toBe(false);
		expect(decision.policy).toBe("grant");
	});

	it("denies when required rank exceeds the grantee's access", async () => {
		const db = dbReturning([
			{
				granteeDescopeUserId: "user-1",
				access: "read",
			} as KernelConversationGrant,
		]);

		const decision = await resolveKernelConversationAccess(db, {
			...baseInput,
			required: "owner",
		});

		expect(decision.allowed).toBe(false);
	});
});
