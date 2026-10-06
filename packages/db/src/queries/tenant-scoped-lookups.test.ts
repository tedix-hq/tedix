import { describe, expect, test, vi } from "vite-plus/test";
import type { DbClient } from "../client";
import { getAppByIdForOrganization } from "./app-records";
import { getTediByIdForOrganization } from "./tedis";

function relationDb(
	table: "apps" | "tedis",
	rows: Array<{ id: string; organizationId: string }>,
) {
	const findFirst = vi.fn(
		async ({ where }: { where: { id: string; organizationId: string } }) =>
			rows.find(
				(row) =>
					row.id === where.id && row.organizationId === where.organizationId,
			),
	);
	return {
		db: { query: { [table]: { findFirst } } } as unknown as DbClient,
		findFirst,
	};
}

describe("tenant-scoped record lookups", () => {
	test("an app id cannot resolve through another organization", async () => {
		const { db, findFirst } = relationDb("apps", [
			{ id: "app-a", organizationId: "org-a" },
		]);

		await expect(
			getAppByIdForOrganization(db, "app-a", "org-b"),
		).resolves.toBeUndefined();
		expect(findFirst).toHaveBeenCalledWith({
			where: { id: "app-a", organizationId: "org-b" },
		});
	});

	test("a tedi id cannot resolve through another organization", async () => {
		const { db, findFirst } = relationDb("tedis", [
			{ id: "tedi-a", organizationId: "org-a" },
		]);

		await expect(
			getTediByIdForOrganization(db, "tedi-a", "org-b"),
		).resolves.toBeUndefined();
		expect(findFirst).toHaveBeenCalledWith({
			where: { id: "tedi-a", organizationId: "org-b" },
		});
	});
});
