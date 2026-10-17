import { expect, it } from "vite-plus/test";
import { projectMetadataForUpdate } from "./project-metadata";
it("keeps ordinary project edits from bypassing observer configuration authority", () => {
	const config = { ownerTediId: "owner", repairs: [] };
	expect(() =>
		projectMetadataForUpdate(null, { repositoryObserver: config }),
	).toThrow("configure_repository_observer");
	expect(() =>
		projectMetadataForUpdate(
			{ repositoryObserver: config },
			{ repositoryObserver: { ownerTediId: "attacker" } },
		),
	).toThrow();
	expect(
		projectMetadataForUpdate({ repositoryObserver: config }, { label: "new" }),
	).toEqual({ repositoryObserver: config, label: "new" });
	expect(
		projectMetadataForUpdate(
			{ repositoryObserver: config },
			{ repositoryObserver: config, label: "new" },
		),
	).toEqual({ repositoryObserver: config, label: "new" });
	expect(
		projectMetadataForUpdate({ repositoryObserver: config }, undefined),
	).toBeUndefined();
});
