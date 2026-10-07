import { OWNER_HOST_SESSION_HEADER } from "@tedix/api-contract/contracts/external-agent-identity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "./orpc";
import { bindForwardedOwnerHostSession } from "./orpc";

const resolveOwnerHostSession = vi.hoisted(() => vi.fn());

vi.mock(
	"@tedix/db/queries/external-agent-identity/owner-host-sessions",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("@tedix/db/queries/external-agent-identity/owner-host-sessions")
		>()),
		resolveOwnerHostSession,
	}),
);

const ORG = "00000000-0000-4000-8000-000000000001";
const SESSION = "00000000-0000-4000-8000-000000000020";
const ACTIVE = { status: "active", userId: "usr-owner-example" };

function context(header?: string): BaseContext {
	return {
		headers: new Headers(
			header === undefined ? {} : { [OWNER_HOST_SESSION_HEADER]: header },
		),
		db: {},
	} as unknown as BaseContext;
}

beforeEach(() => resolveOwnerHostSession.mockReset());

describe("forwarded owner-host session binding", () => {
	it("leaves the owner identity untouched without the header", async () => {
		const ctx = context();
		await bindForwardedOwnerHostSession(ctx, ORG, ACTIVE);
		expect(ctx.ownerHostSessionId).toBeUndefined();
		expect(resolveOwnerHostSession).not.toHaveBeenCalled();
	});

	it("binds the caller's own active owner-host session", async () => {
		resolveOwnerHostSession.mockResolvedValue({
			principal: { id: "principal" },
			session: { id: SESSION },
		});
		const ctx = context(SESSION);
		await bindForwardedOwnerHostSession(ctx, ORG, ACTIVE);
		expect(ctx.ownerHostSessionId).toBe(SESSION);
		expect(resolveOwnerHostSession).toHaveBeenCalledWith(ctx.db, {
			organizationId: ORG,
			userId: "usr-owner-example",
			sessionId: SESSION,
		});
	});

	it.each([
		["a malformed id", "not-a-uuid", ACTIVE, null],
		["an unresolved session", SESSION, ACTIVE, null],
		["an inactive member", SESSION, { ...ACTIVE, status: "suspended" }, {}],
		["a missing member", SESSION, undefined, {}],
	])("fails closed for %s", async (_label, header, member, resolved) => {
		resolveOwnerHostSession.mockResolvedValue(resolved);
		const ctx = context(header);
		await expect(
			bindForwardedOwnerHostSession(ctx, ORG, member),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(ctx.ownerHostSessionId).toBeUndefined();
	});
});
