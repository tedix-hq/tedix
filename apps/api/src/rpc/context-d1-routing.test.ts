import { describe, expect, it } from "vite-plus/test";
import { d1SessionConstraintFor } from "./context";

const at = (path: string) =>
	new Request(`https://api.internal${path}`, { method: "POST" });

describe("d1SessionConstraintFor", () => {
	it("lets the grant check and discovery reads start on a replica", () => {
		expect(
			d1SessionConstraintFor(at("/rpc/organizations/verifyMultiOrgMcpGrant")),
		).toBe("first-unconstrained");
		expect(d1SessionConstraintFor(at("/rpc/apps/getBySlugsWithTools"))).toBe(
			"first-unconstrained",
		);
		expect(d1SessionConstraintFor(at("/rpc/skills/listSummariesByApps"))).toBe(
			"first-unconstrained",
		);
	});

	it("keeps every other request on the primary", () => {
		expect(d1SessionConstraintFor(at("/rpc/workItems/claim"))).toBe(
			"first-primary",
		);
		expect(
			d1SessionConstraintFor(at("/rpc/organizations/verifyMultiOrgMcpGrant/x")),
		).toBe("first-primary");
		expect(d1SessionConstraintFor(at("/v1/apps"))).toBe("first-primary");
	});
});
