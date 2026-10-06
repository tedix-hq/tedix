import { implement } from "@orpc/server";
import { modelCatalogContract } from "@tedix/api-contract/contracts/model-catalog";
import { getTediById } from "@tedix/db/queries/tedis";
import { isPlatformAdmin } from "@tedix/auth/types";
import { buildModelCatalogProjection } from "../../services/model-catalog-projection";
import { requireOrgId } from "../org-scope";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
} from "../orpc";

const os = implement(modelCatalogContract).$context<BaseContext>();

/**
 * The one contract-backed model catalog. Like `runtimeEntitlements.get`, this
 * handler deliberately reuses the helpers the ENFORCING path reads — so what an
 * operator sees is what admission enforces, never a parallel read with its own
 * semantics.
 *
 * Guarded on the same two planes as the rest of the tenant OS read surface:
 * Descope `os:read` (or `settings:manage`) for humans plus the `apps:read`
 * machine scope. The per-tedi scope adds a second, independent binding — the
 * tedi must resolve inside the caller's organization (or the caller must be a
 * platform admin), and the projection is then scoped to the TEDI's organization
 * so a cross-org platform-admin read never mixes the caller's entitlement with
 * another tenant's tedi.
 */
const list = os.list
	.use(withAuth)
	.use(AUTHZ.osRead)
	.handler(async ({ input, context }) => {
		const callerOrgId = requireOrgId(context);
		let tedi = null;
		let organizationId = callerOrgId;
		if (input.tediId) {
			tedi = await getTediById(context.db, input.tediId);
			if (!tedi) {
				throw createError(ErrorCodes.NOT_FOUND, "Tedi not found");
			}
			if (
				tedi.organizationId !== callerOrgId &&
				!isPlatformAdmin(context.user)
			) {
				throw createError(ErrorCodes.FORBIDDEN, "Access denied to this tedi");
			}
			// Scope every canonical read to the tedi's OWN organization: its
			// entitlement and org-scope tier ceiling are what gate its inference.
			organizationId = tedi.organizationId;
		}
		return buildModelCatalogProjection({
			db: context.db,
			env: context.env,
			organizationId,
			tedi,
			includeDenied: input.includeDenied,
		});
	});

export const modelCatalogContractRouter = os.router({ list });
