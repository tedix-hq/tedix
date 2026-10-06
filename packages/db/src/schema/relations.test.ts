/**
 * The base relation config is derived from the complete schema manifest, so a
 * new table gets a `db.query` surface automatically. Domain relation parts then
 * override only the table configurations they own.
 */

import { is, Table } from "drizzle-orm";
import { expect, it } from "vite-plus/test";
import * as schema from "./index";
import { relations } from "./relations";
import { appRelations } from "./relations/apps";
import { billingRelations } from "./relations/billing";
import { catalogRelations } from "./relations/catalog";
import { cognitionRelations } from "./relations/cognition";
import { coordinationRelations } from "./relations/coordination";
import { earnedDelegationRelations } from "./relations/earned-delegation";
import { kernelRelations } from "./relations/kernel";
import { mcpRelations } from "./relations/mcp";
import { miscRelations } from "./relations/misc";
import { platformRelations } from "./relations/platform";
import { tediRuntimeRelations } from "./relations/tedi-runtime";
import { tediRelations } from "./relations/tedis";
import { tenancyRelations } from "./relations/tenancy";
import { workItemRelations } from "./relations/work-items";

const relationParts = [
	tenancyRelations,
	appRelations,
	catalogRelations,
	tediRelations,
	tediRuntimeRelations,
	workItemRelations,
	coordinationRelations,
	platformRelations,
	cognitionRelations,
	earnedDelegationRelations,
	billingRelations,
	kernelRelations,
	mcpRelations,
	miscRelations,
];

it("gives every schema table a relational query surface", () => {
	const tables = Object.entries(schema)
		.filter(([, value]) => is(value, Table))
		.map(([name]) => name)
		.sort();
	const covered = Object.keys(relations).sort();

	expect(tables.length).toBeGreaterThan(150);
	expect(covered).toEqual(tables);
});

it("keeps relation table ownership disjoint across domain parts", () => {
	const owners = new Map<string, number>();

	for (const part of relationParts) {
		for (const [tableName, config] of Object.entries(part)) {
			owners.set(tableName, (owners.get(tableName) ?? 0) + 1);
			expect(relations[tableName as keyof typeof relations]).toBe(config);
		}
	}

	expect([...owners].filter(([, ownerCount]) => ownerCount !== 1)).toEqual([]);
});
