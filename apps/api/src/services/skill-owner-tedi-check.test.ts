import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const queries = vi.hoisted(() => ({
	getTediByIdForOrganization: vi.fn(),
	getAppsByOrganization: vi.fn(),
}));
vi.mock("@tedix/db/queries/tedis", () => ({
	getTediByIdForOrganization: queries.getTediByIdForOrganization,
}));
vi.mock("@tedix/db/queries/apps", () => ({
	getAppsByOrganization: queries.getAppsByOrganization,
}));

import type { DbClient } from "@tedix/db/client";
import { ownerTediNamespaceIssues } from "./skill-owner-tedi-check";

const db = {} as DbClient;
const ORG = "org-northwind";
const OWNER = "tedi-northwind-ops";
const content = `---\nname: northwind-daily\ncapabilities:\n  mcp:\n    tedi: [run_tedi_turn]\n---\nBody`;

function gateway(aggregateTedis: unknown[]) {
	return {
		id: "app-gateway",
		slug: "northwind-unified",
		metadata: {
			mcpConfig: {
				aggregateApps: [{ slug: "northwind-crm" }],
				authMode: "authenticated",
				codeMode: true,
				aggregateTedis,
			},
		},
	};
}

describe("ownerTediNamespaceIssues", () => {
	beforeEach(() => {
		queries.getTediByIdForOrganization.mockResolvedValue({
			id: OWNER,
			slug: "ops",
		});
	});

	it("passes when the gateway has a full aggregateTedis entry for the owner", async () => {
		queries.getAppsByOrganization.mockResolvedValue([
			gateway([{ slug: "ops", surface: "full" }]),
		]);
		await expect(
			ownerTediNamespaceIssues(db, {
				organizationId: ORG,
				content,
				ownerTediId: OWNER,
			}),
		).resolves.toEqual([]);
	});

	it("fails with a fix hint when the owner has no aggregateTedis entry", async () => {
		queries.getAppsByOrganization.mockResolvedValue([gateway([])]);
		const issues = await ownerTediNamespaceIssues(db, {
			organizationId: ORG,
			content,
			ownerTediId: OWNER,
		});
		expect(issues.map((issue) => issue.code)).toEqual([
			"SKILL_OWNER_TEDI_UNRESOLVED",
		]);
		expect(issues[0]?.message).toContain('Add {slug: "ops", surface: "full"}');
	});

	it("fails when the owner tedi is not in the organization", async () => {
		queries.getTediByIdForOrganization.mockResolvedValue(null);
		queries.getAppsByOrganization.mockResolvedValue([gateway([])]);
		const issues = await ownerTediNamespaceIssues(db, {
			organizationId: ORG,
			content,
			ownerTediId: OWNER,
		});
		expect(issues[0]?.code).toBe("SKILL_OWNER_TEDI_UNRESOLVED");
		expect(issues[0]?.message).toContain("Fix:");
	});

	it("skips skills that do not call the tedi namespace", async () => {
		queries.getAppsByOrganization.mockClear();
		await expect(
			ownerTediNamespaceIssues(db, {
				organizationId: ORG,
				content: "---\nname: northwind-daily\n---\nBody",
				ownerTediId: OWNER,
			}),
		).resolves.toEqual([]);
		expect(queries.getAppsByOrganization).not.toHaveBeenCalled();
	});
});
