/** Human-owned Purpose Charter and compact owner-attention brief. */

import { implement } from "@orpc/server";
import { organizationPurposeContract } from "@tedix/api-contract/contracts/organization-purpose";
import {
	createPurposeCharterRevision,
	getActivePurposeCharter,
	getOrganizationOwnerBrief,
	listPurposeCharterRevisions,
} from "@tedix/db/queries/organization-purpose";
import { requireOrgId } from "../org-scope";
import { AUTHZ, withAuthorization, type BaseContext, withAuth } from "../orpc";

const purposeOs = implement(
	organizationPurposeContract,
).$context<BaseContext>();
const authOs = purposeOs.use(withAuth);

const getActive = authOs.getActive
	.use(AUTHZ.settingsRead)
	.handler(async ({ context }) => ({
		charter:
			(await getActivePurposeCharter(context.db, requireOrgId(context))) ??
			null,
	}));

const listRevisions = authOs.listRevisions
	.use(AUTHZ.settingsRead)
	.handler(async ({ input, context }) => ({
		data: await listPurposeCharterRevisions(
			context.db,
			requireOrgId(context),
			input.limit,
		),
	}));

const createRevision = authOs.createRevision
	.use(AUTHZ.settingsWrite)
	.handler(async ({ input, context }) =>
		createPurposeCharterRevision(context.db, {
			id: crypto.randomUUID(),
			orgId: requireOrgId(context),
			...input,
			createdByUserId: context.user?.sub ?? null,
			createdAt: new Date().toISOString(),
		}),
	);

const getOwnerBrief = authOs.getOwnerBrief
	.use(AUTHZ.settingsRead)
	.handler(async ({ input, context }) => {
		const brief = await getOrganizationOwnerBrief(context.db, {
			orgId: requireOrgId(context),
			now: new Date().toISOString(),
			outcomeWindowDays: input.outcomeWindowDays,
		});
		return brief;
	});

export const organizationPurposeContractRouter = purposeOs.router({
	getActive,
	listRevisions,
	createRevision,
	getOwnerBrief,
});
