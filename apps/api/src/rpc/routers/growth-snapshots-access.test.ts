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
import { GROWTH_SNAPSHOTS_TEDI_ACCESS } from "./growth-snapshots";

vi.mock("@tedix/db/queries/tedis", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/db/queries/tedis")>()),
	getTediById: lookupTediAccessTarget,
}));

/**
 * Growth snapshots: strictly tenant-bound. The caller must carry an
 * organization (FORBIDDEN otherwise) and no authority crosses the boundary.
 */
const EXPECTED: Record<TediAccessCaseName, TediAccessOutcome> = {
	"same-org user": "allow",
	"cross-org user": "FORBIDDEN",
	"cross-org user with platform-admin role": "FORBIDDEN",
	"cross-org user with platform:admin scope": "FORBIDDEN",
	"cross-org api key with platform:admin": "FORBIDDEN",
	"cross-org api key with wildcard scope": "FORBIDDEN",
	"cross-org api key with tenant scopes": "FORBIDDEN",
	"cross-org m2m with platform:admin": "FORBIDDEN",
	"system service binding": "FORBIDDEN",
	"verified MCP edge identity lookup": "FORBIDDEN",
	"missing sibling tedi": "NOT_FOUND",
	"system organization on a user call": "FORBIDDEN",
	"cross-org service binding": "FORBIDDEN",
	"tenant tedi forwarded by verified MCP binding": "FORBIDDEN",
	"untrusted binding forwarding platform headers": "FORBIDDEN",
	"untrusted binding forwarding operator app headers": "FORBIDDEN",
	"cross-org service binding forwarding a platform tedi": "FORBIDDEN",
	"cross-org service binding from the operator MCP app": "FORBIDDEN",
	"operator MCP app slug on a user call": "FORBIDDEN",
	"self tedi": "allow",
	"self tedi without organization": "FORBIDDEN",
	"self tedi with a cross-org context": "FORBIDDEN",
	"sibling tedi in the same org": "allow",
	"sibling platform tedi in the same org": "allow",
	"cross-org tedi": "FORBIDDEN",
	"user without organization": "FORBIDDEN",
	"platform-admin user without organization": "FORBIDDEN",
	"platform api key without organization": "FORBIDDEN",
	"missing tedi for a same-org user": "NOT_FOUND",
	"missing tedi for a cross-org user": "NOT_FOUND",
	"missing tedi for a user without organization": "FORBIDDEN",
	"missing tedi for a platform api key without organization": "FORBIDDEN",
};

describe("growth-snapshots requireTediAccess matrix", () => {
	it.each(TEDI_ACCESS_CASES)("$name", async (row) => {
		const call = requireTediAccess(
			tediAccessContext(row.context),
			"tediId" in row ? row.tediId : TEDI_ACCESS_TARGET.id,
			GROWTH_SNAPSHOTS_TEDI_ACCESS,
		);
		const outcome = EXPECTED[row.name];
		if (outcome === "allow") {
			await expect(call).resolves.toMatchObject({
				id: TEDI_ACCESS_TARGET.id,
				organizationId: TEDI_ACCESS_TARGET.organizationId,
			});
		} else {
			await expect(call).rejects.toMatchObject({ code: outcome });
		}
	});
});
