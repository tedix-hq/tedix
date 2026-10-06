import { describe, expect, it } from "vite-plus/test";
import { computeManagedAssignmentsForTedi } from "./app-assignment-policy";

describe("computeManagedAssignmentsForTedi", () => {
	const app = {
		id: "app_1",
		name: "Tedix Unified",
		slug: "tedix-unified",
		metadata: {
			mcpConfig: {
				assignmentConfig: {
					mode: "profile-default",
					rules: [
						{
							role: "operator",
							capabilityProfiles: ["platform_admin"],
						},
						{
							role: "operator",
							capabilityProfiles: ["standard"],
							requiredTediTags: ["gateway:operator"],
						},
						{
							role: "observer",
							capabilityProfiles: ["standard"],
						},
					],
				},
			},
		},
	};

	it("uses the first matching assignment rule for platform admins", () => {
		const assignments = computeManagedAssignmentsForTedi([app], {
			id: "tedi_cto",
			mcpCapabilityProfile: "platform_admin",
		});

		expect(assignments).toHaveLength(1);
		expect(assignments[0]).toMatchObject({
			appId: "app_1",
			appSlug: "tedix-unified",
			role: "operator",
		});
	});

	it("uses a lower-privilege assignment rule for standard tedis", () => {
		const assignments = computeManagedAssignmentsForTedi([app], {
			id: "tedi_cmo",
			mcpCapabilityProfile: "standard",
		});

		expect(assignments).toHaveLength(1);
		expect(assignments[0]).toMatchObject({
			appId: "app_1",
			appSlug: "tedix-unified",
			role: "observer",
		});
	});

	it("can promote a tagged standard tedi without granting platform admin", () => {
		const assignments = computeManagedAssignmentsForTedi([app], {
			id: "tedi_ceo",
			mcpCapabilityProfile: "standard",
			tags: ["gateway:operator"],
		});

		expect(assignments).toHaveLength(1);
		expect(assignments[0]).toMatchObject({
			appId: "app_1",
			appSlug: "tedix-unified",
			role: "operator",
		});
	});
});
