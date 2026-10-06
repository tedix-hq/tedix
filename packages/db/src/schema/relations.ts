/**
 * Drizzle Relations v2 composition root.
 *
 * The empty main relation set is load-bearing: defineRelations() includes every
 * table from the runtime schema so db.query remains complete. Domain parts then
 * override only the tables whose relationships they own. Drizzle requires the
 * main relations object to be spread first.
 *
 * @see https://orm.drizzle.team/docs/relations#relations-parts
 */

import { defineRelations } from "drizzle-orm";
import * as schema from "./index";
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

const baseRelations = defineRelations(schema);

export const relations = {
	...baseRelations,
	...tenancyRelations,
	...appRelations,
	...catalogRelations,
	...tediRelations,
	...tediRuntimeRelations,
	...workItemRelations,
	...coordinationRelations,
	...platformRelations,
	...cognitionRelations,
	...earnedDelegationRelations,
	...billingRelations,
	...kernelRelations,
	...mcpRelations,
	...miscRelations,
};
