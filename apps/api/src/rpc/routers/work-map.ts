import { implement } from "@orpc/server";
import { workMapContract } from "@tedix/api-contract/contracts/work-map";
import { readWorkMapSnapshot } from "@tedix/db/queries/work-items/map";
import { buildWorkMap } from "../../services/work-map";
import { requireOrgId } from "../org-scope";
import { type BaseContext, withAuth, withAuthorization } from "../orpc";

const os = implement(workMapContract).$context<BaseContext>().use(withAuth);

const readProcedure = os.read
	.use(withAuthorization("tedis:read", "work:read"))
	.handler(async ({ input, context }) => {
		const organizationId = requireOrgId(context);
		const now = Date.now();
		const snapshot = await readWorkMapSnapshot(context.db, {
			orgId: organizationId,
			now: new Date(now).toISOString(),
		});
		return buildWorkMap(snapshot, {
			organizationId,
			now,
			stalledAfterHours: input.stalledAfterHours,
		});
	});

export const workMapContractRouter = os.router({ read: readProcedure });
