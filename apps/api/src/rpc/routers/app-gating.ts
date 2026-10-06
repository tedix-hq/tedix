/**
 * oRPC App Gating Router
 * Eligibility checking endpoints for apps and tools.
 *
 * REST Endpoints:
 * GET /app-gating/eligibility/{appId}       - Check single app eligibility
 * GET /app-gating/installed                  - Batch check all installed apps
 * GET /app-gating/runtime-tools/{tediId}     - Get eligible tools for tedi
 * GET /app-gating/install-check/{appId}      - Install-time eligibility check
 */

import { implement } from "@orpc/server";
import { appGatingContract } from "@tedix/api-contract/contracts/app-gating";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";
import {
	checkAppEligibilityById,
	checkInstallEligibility,
	checkInstalledAppsEligibility,
	getEligibilityBadge,
	getRuntimeTools,
} from "../../lib/app-gating";
import { requireOrgId } from "../org-scope";
import { AUTHZ, withAuthorization, type BaseContext, withAuth } from "../orpc";

const gatingOs = implement(appGatingContract).$context<BaseContext>();
const authedOs = gatingOs.use(withAuth);
const readOs = authedOs.use(AUTHZ.appsRead);

// =============================================================================
// HELPERS
// =============================================================================

function getDescopeGatingEnv(context: BaseContext) {
	return {
		DESCOPE_PROJECT_ID: context.env.DESCOPE_PROJECT_ID,
		DESCOPE_MANAGEMENT_KEY: context.env.DESCOPE_MANAGEMENT_KEY,
		DESCOPE_BASE_URL: context.env.DESCOPE_BASE_URL,
	};
}

// =============================================================================
// PROCEDURES
// =============================================================================

const eligibility = readOs.eligibility.handler(async ({ input, context }) => {
	const orgId = requireOrgId(context);
	const result = await checkAppEligibilityById(
		context.env.DB,
		input.appId,
		orgId,
		getDescopeGatingEnv(context),
		context.user?.sub,
	);
	return {
		...result,
		badge: getEligibilityBadge(result),
	};
});

const installedEligibility = readOs.installedEligibility.handler(
	async ({ context }) => {
		const orgId = requireOrgId(context);
		const results = await checkInstalledAppsEligibility(
			context.env.DB,
			orgId,
			getDescopeGatingEnv(context),
			context.user?.sub,
		);
		return results.map((r) => ({
			...r,
			badge: getEligibilityBadge(r.result),
		}));
	},
);

const runtimeToolsProc = readOs.runtimeTools.handler(
	async ({ input, context }) => {
		const orgId = requireOrgId(context);

		// Resolve identity only through the caller's organization boundary.
		const tedi = await getTediByIdForOrganization(
			context.db,
			input.tediId,
			orgId,
		);
		if (!tedi) return [];
		return getRuntimeTools(
			context.env.DB,
			input.tediId,
			orgId,
			{
				DESCOPE_PROJECT_ID: context.env.DESCOPE_PROJECT_ID,
				DESCOPE_MANAGEMENT_KEY: context.env.DESCOPE_MANAGEMENT_KEY,
				DESCOPE_BASE_URL: context.env.DESCOPE_BASE_URL,
			},
			tedi?.descopeUserId ?? undefined,
		);
	},
);

const installCheck = readOs.installCheck.handler(async ({ input, context }) => {
	const orgId = requireOrgId(context);
	const result = await checkInstallEligibility(
		context.env.DB,
		input.appId,
		orgId,
		getDescopeGatingEnv(context),
		context.user?.sub,
	);
	return {
		...result,
		badge: getEligibilityBadge(result),
	};
});

// =============================================================================
// ROUTER EXPORT
// =============================================================================

export const appGatingContractRouter = gatingOs.router({
	eligibility,
	installedEligibility,
	runtimeTools: runtimeToolsProc,
	installCheck,
});
