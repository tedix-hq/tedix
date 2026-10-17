import { expect, it } from "vite-plus/test";
import {
	OsGadgetManifestSchema,
	OsGadgetManifestWriteSchema,
} from "./os-workspaces";

it("validates session app configuration on writes while preserving old reads", () => {
	for (const entry of ["tedix:app/office", "tedix:app/agents"]) {
		expect(
			OsGadgetManifestWriteSchema.safeParse({
				entry,
				config: { version: 1 },
				navigation: { board: true },
			}).success,
		).toBe(true);
		for (const config of [
			undefined,
			{ version: 2 },
			{ version: 1, organizationId: "org-fictional" },
		]) {
			expect(
				OsGadgetManifestWriteSchema.safeParse({ entry, config }).success,
			).toBe(false);
			expect(OsGadgetManifestSchema.safeParse({ entry, config }).success).toBe(
				true,
			);
		}
	}
	const entry = "tedix:app/agents";
	expect(
		OsGadgetManifestWriteSchema.safeParse({
			entry,
			config: {
				version: 1,
				projectId: "11111111-1111-4111-8111-111111111111",
				states: ["working", "ended"],
				harnesses: ["tedi"],
			},
		}).success,
	).toBe(true);
	for (const scope of [
		{ projectId: "not-a-project" },
		{ states: [] },
		{ states: ["invented"] },
		{ harnesses: ["invented"] },
	])
		expect(
			OsGadgetManifestWriteSchema.safeParse({
				entry,
				config: { version: 1, ...scope },
			}).success,
		).toBe(false);
});

it("requires a project-scoped Work app configuration while keeping legacy reads lenient", () => {
	const entry = "tedix:app/work";
	expect(
		OsGadgetManifestWriteSchema.safeParse({
			entry,
			config: { version: 1, projectId: "11111111-1111-4111-8111-111111111111" },
		}).success,
	).toBe(true);
	for (const config of [
		{ version: 1 },
		{ version: 1, projectId: "wrong-project" },
		{
			version: 1,
			projectId: "11111111-1111-4111-8111-111111111111",
			organizationId: "other",
		},
	]) {
		expect(
			OsGadgetManifestWriteSchema.safeParse({ entry, config }).success,
		).toBe(false);
		expect(OsGadgetManifestSchema.safeParse({ entry, config }).success).toBe(
			true,
		);
	}
});
