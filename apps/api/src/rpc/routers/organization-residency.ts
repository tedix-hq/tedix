import { implement, ORPCError } from "@orpc/server";
import { organizationsContract } from "@tedix/api-contract/contracts/organizations";
import {
	getOrganizationResidencyPolicy,
	setOrganizationResidencyPolicy,
	listResidencyProviders,
	publishResidencyProvider,
} from "@tedix/db/queries/data-residency";
import { getMemberByUserId } from "@tedix/db/queries/organization-members";
import { AUTHZ, withAuth, type BaseContext } from "../orpc";
import { requireOrgId } from "../org-scope";

const os = implement(organizationsContract).$context<BaseContext>();
export const getDataResidency = os.getDataResidency
	.use(withAuth)
	.use(AUTHZ.settingsRead)
	.handler(async ({ context }) => {
		const row = await getOrganizationResidencyPolicy(
			context.db,
			requireOrgId(context),
		);
		return (
			row ?? {
				mode: "unrestricted" as const,
				revision: 0,
				updatedAt: null,
				updatedBy: null,
			}
		);
	});
export const setDataResidency = os.setDataResidency
	.use(withAuth)
	.use(AUTHZ.settingsWrite)
	.handler(async ({ input, context }) => {
		const organizationId = requireOrgId(context);
		if (context.authType !== "user" || !context.user?.sub)
			throw new ORPCError("FORBIDDEN", {
				message:
					"An organization owner or administrator must change data residency",
			});
		const member = await getMemberByUserId(
			context.db,
			organizationId,
			context.user.sub,
		);
		if (
			member?.status !== "active" ||
			!["owner", "admin"].includes(member.role)
		)
			throw new ORPCError("FORBIDDEN", {
				message:
					"An active organization owner or administrator must change data residency",
			});
		try {
			return await setOrganizationResidencyPolicy(context.db, {
				...input,
				organizationId,
				actorId: context.user.sub,
				now: new Date().toISOString(),
			});
		} catch (error) {
			if (
				error instanceof Error &&
				error.message === "Residency policy revision conflict"
			)
				throw new ORPCError("CONFLICT", {
					message: "Data residency changed. Reload the setting and retry.",
				});
			throw error;
		}
	});
export const listResidencyProviderCatalog = os.listResidencyProviderCatalog
	.use(withAuth)
	.use(AUTHZ.platformAdmin)
	.handler(({ context }) => listResidencyProviders(context.db));
export const publishResidencyProviderVersion =
	os.publishResidencyProviderVersion
		.use(withAuth)
		.use(AUTHZ.platformAdmin)
		.handler(({ context, input }) =>
			publishResidencyProvider(
				context.db,
				input,
				context.user?.sub ?? context.authType ?? "platform",
				new Date().toISOString(),
			),
		);
