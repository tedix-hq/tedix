import { call, os } from "@orpc/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { type BaseContext, withAuth, createScopeMiddleware } from "../../orpc";
import { internalDelegationContext } from "../kernel-runtime/delegation-context";
import {
	TEDI_ACCESS_CASES,
	TEDI_ACCESS_TARGET,
	type TediAccessCaseName,
	type TediAccessOutcome,
	lookupTediAccessTarget,
	tediAccessContext,
} from "../../tedi-access-test-cases";
import { requireTediAccess } from "./events-policy";

vi.mock("@tedix/db/queries/tedis", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/db/queries/tedis")>()),
	getTediById: lookupTediAccessTarget,
	getTediByIdForOrganization: async (db: unknown, id: string, org: string) =>
		org === TEDI_ACCESS_TARGET.organizationId
			? lookupTediAccessTarget(db, id)
			: null,
}));

/** Caller scope precedes lookup; inaccessible and absent tenant rows are FORBIDDEN. */
const EXPECTED: Record<TediAccessCaseName, TediAccessOutcome> = {
	"same-org user": "allow",
	"cross-org user": "FORBIDDEN",
	"cross-org user with platform-admin role": "allow",
	"cross-org user with platform:admin scope": "allow",
	"cross-org api key with platform:admin": "allow",
	"cross-org api key with wildcard scope": "allow",
	"cross-org api key with tenant scopes": "FORBIDDEN",
	"cross-org m2m with platform:admin": "allow",
	"system service binding": "FORBIDDEN",
	"verified MCP edge identity lookup": "FORBIDDEN",
	"missing sibling tedi": "FORBIDDEN",
	"system organization on a user call": "FORBIDDEN",
	"cross-org service binding": "FORBIDDEN",
	"tenant tedi forwarded by verified MCP binding": "FORBIDDEN",
	"untrusted binding forwarding platform headers": "FORBIDDEN",
	"untrusted binding forwarding operator app headers": "FORBIDDEN",
	"cross-org service binding forwarding a platform tedi": "allow",
	"cross-org service binding from the operator MCP app": "allow",
	"operator MCP app slug on a user call": "FORBIDDEN",
	"self tedi": "allow",
	"self tedi without organization": "allow",
	"self tedi with a cross-org context": "FORBIDDEN",
	"sibling tedi in the same org": "FORBIDDEN",
	"sibling platform tedi in the same org": "allow",
	"cross-org tedi": "FORBIDDEN",
	"user without organization": "FORBIDDEN",
	"platform-admin user without organization": "allow",
	"platform api key without organization": "allow",
	"missing tedi for a same-org user": "FORBIDDEN",
	"missing tedi for a cross-org user": "FORBIDDEN",
	"missing tedi for a user without organization": "FORBIDDEN",
	"missing tedi for a platform api key without organization": "NOT_FOUND",
};

describe("cognitive-runtime requireTediAccess matrix", () => {
	it.each(TEDI_ACCESS_CASES)("$name", async (row) => {
		const call = requireTediAccess(
			tediAccessContext(row.context),
			"tediId" in row ? row.tediId : TEDI_ACCESS_TARGET.id,
		);
		const outcome = EXPECTED[row.name];
		if (outcome === "allow") {
			await expect(call).resolves.toMatchObject({ id: TEDI_ACCESS_TARGET.id });
		} else {
			await expect(call).rejects.toMatchObject({ code: outcome });
		}
	});
});

describe("Home dispatch after a tedi approval", () => {
	it.each([
		{ organizationId: "org-target", tediId: "tedi-target", allowed: true },
		{ organizationId: "org-other", tediId: "tedi-target", allowed: false },
		{ organizationId: "org-target", tediId: "tedi-missing", allowed: false },
	])("authorizes $tediId in $organizationId", async (row) => {
		const approver = tediAccessContext({
			env: { ENVIRONMENT: "production" } as CloudflareEnv,
			authType: "service-binding",
			serviceBindingPrincipal: "mcp-edge",
			organizationId: row.organizationId,
			tediId: "tedi-approver",
			tediScopes: ["platform:admin"],
			headers: new Headers({ "X-Tedix-Tedi-Id": "tedi-approver" }),
		});
		const guarded = os
			.$context<BaseContext>()
			.use(withAuth)
			.use(createScopeMiddleware("tedis:write"))
			.handler(({ context }) => requireTediAccess(context, row.tediId));
		const context = internalDelegationContext(approver, row.organizationId);
		const result = call(guarded, undefined, { context });
		if (row.allowed) {
			await expect(result).resolves.toMatchObject({ id: row.tediId });
		} else {
			await expect(result).rejects.toMatchObject({ code: "FORBIDDEN" });
		}
		expect(context.tediId).toBeUndefined();
		expect(context.tediScopes).toEqual(["tedis:write"]);
	});
});
