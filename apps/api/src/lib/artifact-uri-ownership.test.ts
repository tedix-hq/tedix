import { describe, expect, it } from "vite-plus/test";
import { inspectArtifactUriOwnership } from "./artifact-uri-ownership";

const OWNER = {
	organizationId: "org-1",
	tediId: "11111111-1111-4111-8111-111111111111",
};
const PEER = "22222222-2222-4222-8222-222222222222";

const inspect = (uri: string | null | undefined) =>
	inspectArtifactUriOwnership({ ...OWNER, uri });

describe("inspectArtifactUriOwnership", () => {
	it("accepts direct artifacts and exact-row legacy workstation keys", () => {
		for (const uri of [
			`r2://tedix-tedi-production/${OWNER.tediId}/artifacts/deliverable/report.md`,
			`r2://tedix-tedi-production/${OWNER.tediId}/artifacts/deliverable/bundle/a/`,
			`r2://tedix-tedi-production/tedis/${OWNER.tediId}/workstations/coding/processes/p/terminal/stdout.log`,
			`r2://tedi-storage/tedis/${OWNER.tediId}/workstations/coding/processes/p/terminal/stdout.log`,
		]) {
			expect(inspect(uri)).toMatchObject({ kind: "owned-r2" });
		}
	});

	it("accepts valid UUID peer workstation evidence in the same organization", () => {
		expect(
			inspect(
				`r2://tedix-tedi-production/orgs/${OWNER.organizationId}/tedis/${PEER}/workstations/coding/processes/p/terminal/evidence.json`,
			),
		).toMatchObject({ kind: "owned-r2" });
	});

	it("denies cross-org, malformed peer, other-bucket, and foreign direct keys", () => {
		for (const uri of [
			`r2://tedix-tedi-production/orgs/org-2/tedis/${PEER}/workstations/coding/processes/p/terminal/evidence.json`,
			`r2://tedix-tedi-production/orgs/${OWNER.organizationId}/tedis/not-a-uuid/workstations/coding/processes/p/terminal/evidence.json`,
			`r2://skill-artifacts-production/${OWNER.tediId}/artifacts/report.md`,
			`r2://tedix-tedi-production/${PEER}/artifacts/report.md`,
		]) {
			expect(inspect(uri)).toEqual({ kind: "invalid-r2" });
		}
	});

	it("denies ambiguous and malformed R2 keys", () => {
		for (const suffix of [
			"../secret",
			"%2e%2e/secret",
			"safe/%2Fsecret",
			"safe\\secret",
			"safe\0secret",
			"safe?version=1",
			"safe#fragment",
		]) {
			expect(
				inspect(
					`r2://tedix-tedi-production/${OWNER.tediId}/artifacts/${suffix}`,
				),
			).toEqual({ kind: "invalid-r2" });
		}
		expect(inspect("R2://tedix-tedi-production/key")).toEqual({
			kind: "invalid-r2",
		});
	});

	it("keeps non-R2 references registry-only", () => {
		expect(inspect("https://example.com/report.pdf")).toEqual({
			kind: "non-r2",
		});
		expect(inspect(null)).toEqual({ kind: "non-r2" });
	});
});
