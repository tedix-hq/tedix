import { describe, expect, it, vi } from "vite-plus/test";
import {
	TEDI_ACCESS_CASES,
	TEDI_ACCESS_TARGET,
	type TediAccessCaseName,
	type TediAccessOutcome,
	lookupTediAccessTarget,
	tediAccessContext,
} from "../tedi-access-test-cases";
import { requireTediAccess } from "../tedi-access";
import { HARNESS_TEDI_ACCESS } from "./harness";

vi.mock("@tedix/db/queries/tedis", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/db/queries/tedis")>()),
	getTediById: lookupTediAccessTarget,
}));

/**
 * Harness ledger: the tedi is read first (a missing tedi is NOT_FOUND even
 * without organization scope). A tedi principal reaches only its own ledger,
 * whatever else it carries; otherwise the caller's organization must own the
 * tedi or the caller must be a platform principal. A caller with no
 * organization, no tedi identity and no platform authority is UNAUTHORIZED.
 */
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
	"system organization on a user call": "FORBIDDEN",
	"cross-org service binding": "FORBIDDEN",
	"cross-org service binding forwarding a platform tedi": "FORBIDDEN",
	"cross-org service binding from the operator MCP app": "FORBIDDEN",
	"operator MCP app slug on a user call": "FORBIDDEN",
	"self tedi": "allow",
	"self tedi without organization": "allow",
	"self tedi with a cross-org context": "allow",
	"sibling tedi in the same org": "FORBIDDEN",
	"sibling platform tedi in the same org": "FORBIDDEN",
	"cross-org tedi": "FORBIDDEN",
	"user without organization": "UNAUTHORIZED",
	"platform-admin user without organization": "allow",
	"platform api key without organization": "allow",
	"missing tedi for a same-org user": "NOT_FOUND",
	"missing tedi for a cross-org user": "NOT_FOUND",
	"missing tedi for a user without organization": "NOT_FOUND",
	"missing tedi for a platform api key without organization": "NOT_FOUND",
};

describe("harness requireTediAccess matrix", () => {
	it.each(TEDI_ACCESS_CASES)("$name", async (row) => {
		const call = requireTediAccess(
			tediAccessContext(row.context),
			"tediId" in row ? row.tediId : TEDI_ACCESS_TARGET.id,
			HARNESS_TEDI_ACCESS,
		);
		const outcome = EXPECTED[row.name];
		if (outcome === "allow") {
			await expect(call).resolves.toMatchObject({ id: TEDI_ACCESS_TARGET.id });
		} else {
			await expect(call).rejects.toMatchObject({ code: outcome });
		}
	});
});
