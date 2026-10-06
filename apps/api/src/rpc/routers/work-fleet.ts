import { implement } from "@orpc/server";
import { workFleetContract } from "@tedix/api-contract/contracts/work-fleet";
import { getWorkFleetProjection } from "@tedix/db/queries/work-items/fleet";
import { requireOrgId } from "../org-scope";
import { AUTHZ, type BaseContext, withAuth } from "../orpc";

const workFleetOs = implement(workFleetContract).$context<BaseContext>();
const authOs = workFleetOs.use(withAuth).use(AUTHZ.messagingRead);

const getControlTowerProcedure = authOs.getControlTower.handler(
	async ({ context }) =>
		getWorkFleetProjection(context.db, {
			orgId: requireOrgId(context),
			now: new Date().toISOString(),
		}),
);

export const workFleetContractRouter = workFleetOs.router({
	getControlTower: getControlTowerProcedure,
});
