import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { apps } from "../schema/apps";
import { appCatalog } from "../schema/catalog";
import { organizationMembers } from "../schema/organization-members";
import { organizations } from "../schema/organizations";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	getOrganizationAggregatorGateways,
	getUserOsMemberships,
} from "./organization-members";

const NOW = "2026-08-16T00:00:00.000Z";

function setup() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(schemaDdl(organizations, organizationMembers, appCatalog, apps));
	return createDbClient(createD1Facade(sqlite));
}

async function seed(
	db: ReturnType<typeof setup>,
	input: {
		id: string;
		slug: string;
		os?: boolean;
		status?: "active" | "invited" | "deactivated";
		lastActiveAt?: string;
		retiredAt?: string;
	},
) {
	await db.insert(organizations).values({
		id: input.id,
		name: `Organization ${input.slug}`,
		slug: input.slug,
		features: input.os === undefined ? undefined : { os: input.os },
		createdAt: NOW,
		updatedAt: NOW,
		metadata: input.retiredAt ? { retiredAt: input.retiredAt } : undefined,
	});
	await db.insert(organizationMembers).values({
		id: `member-${input.id}`,
		organizationId: input.id,
		descopeUserId: "U-launcher",
		email: "member@example.com",
		role: "member",
		status: input.status ?? "active",
		lastActiveAt: input.lastActiveAt ?? NOW,
		createdAt: NOW,
		updatedAt: NOW,
	});
}

describe("getUserOsMemberships", () => {
	it("returns zero organizations for a user without memberships", async () => {
		expect(await getUserOsMemberships(setup(), "U-none")).toEqual([]);
	});

	it("returns only active, explicitly provisioned organizations", async () => {
		const db = setup();
		await seed(db, {
			id: "org-live",
			slug: "live",
			os: true,
			lastActiveAt: "2026-08-16T03:00:00.000Z",
		});
		await seed(db, { id: "org-unprovisioned", slug: "unprovisioned" });
		await seed(db, { id: "org-off", slug: "off", os: false });
		await seed(db, {
			id: "org-inactive",
			slug: "inactive",
			os: true,
			status: "deactivated",
		});
		await seed(db, {
			id: "org-retired",
			slug: "retired",
			os: true,
			retiredAt: NOW,
		});

		await expect(getUserOsMemberships(db, "U-launcher")).resolves.toEqual([
			{
				organizationId: "org-live",
				organizationName: "Organization live",
				organizationSlug: "live",
				organizationLogoUrl: null,
			},
		]);
	});

	it("orders multiple launchable memberships by recent activity", async () => {
		const db = setup();
		await seed(db, {
			id: "org-old",
			slug: "old",
			os: true,
			lastActiveAt: "2026-08-15T00:00:00.000Z",
		});
		await seed(db, {
			id: "org-new",
			slug: "new",
			os: true,
			lastActiveAt: "2026-08-16T00:00:00.000Z",
		});
		const result = await getUserOsMemberships(db, "U-launcher");
		expect(result.map((organization) => organization.organizationSlug)).toEqual(
			["new", "old"],
		);
	});
});

describe("getOrganizationAggregatorGateways", () => {
	it("recognizes a fresh unified gateway that initially aggregates only its tedi", async () => {
		const db = setup();
		await db.insert(organizations).values({
			id: "org-gateway",
			name: "Gateway Organization",
			slug: "gateway",
			createdAt: NOW,
			updatedAt: NOW,
		});
		await db.insert(apps).values({
			id: "app-gateway",
			organizationId: "org-gateway",
			name: "Gateway Unified MCP",
			slug: "gateway-unified",
			visibility: "private",
			discoveryStatus: "pending",
			metadata: {
				mcpConfig: {
					authMode: "authenticated",
					codeMode: true,
					descopeResourceId: "MS-gateway",
					aggregateTedis: [{ slug: "tedi-first", surface: "full" }],
				},
			},
			createdAt: NOW,
			updatedAt: NOW,
		});

		await expect(
			getOrganizationAggregatorGateways(db, ["org-gateway"]),
		).resolves.toEqual(
			new Map([
				["org-gateway", { slug: "gateway-unified", customMcpDomain: null }],
			]),
		);
	});
});
