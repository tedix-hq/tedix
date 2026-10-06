/**
 * Widget Test Runs oRPC Router
 *
 * List and retrieve persisted widget test runs (static + interactive).
 * Read-only — creation happens inside widget-test.ts handlers.
 */

import { implement } from "@orpc/server";
import { widgetTestRunsContract } from "@tedix/api-contract/contracts/widget-test-runs";
import {
	getWidgetTestRunById,
	listWidgetTestRunsByApp,
	listWidgetTestRunsByOrg,
} from "@tedix/db/queries/widget-test-runs";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
	withFleetAuthority,
} from "../orpc";

const widgetTestRunsOs = implement(
	widgetTestRunsContract,
).$context<BaseContext>();
const authed = widgetTestRunsOs.use(withAuth).use(withFleetAuthority);

const listWidgetTestRunsProcedure = authed.list
	.use(AUTHZ.appsRead)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const organizationId = context.organizationId;
		if (!organizationId) {
			throw createError(ErrorCodes.UNAUTHORIZED, "Organization required");
		}

		const runs = input.appSlug
			? await listWidgetTestRunsByApp(
					db,
					input.appSlug,
					organizationId,
					input.limit,
				)
			: await listWidgetTestRunsByOrg(db, organizationId, input.limit);

		return { runs };
	});

const getWidgetTestRunProcedure = authed.get
	.use(AUTHZ.appsRead)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const organizationId = context.organizationId;
		if (!organizationId) {
			throw createError(ErrorCodes.UNAUTHORIZED, "Organization required");
		}

		const run = await getWidgetTestRunById(db, input.id, organizationId);
		if (!run) {
			throw createError(
				ErrorCodes.NOT_FOUND,
				`Widget test run not found: ${input.id}`,
			);
		}

		return run;
	});

export const widgetTestRunsContractRouter = widgetTestRunsOs.router({
	list: listWidgetTestRunsProcedure,
	get: getWidgetTestRunProcedure,
});
