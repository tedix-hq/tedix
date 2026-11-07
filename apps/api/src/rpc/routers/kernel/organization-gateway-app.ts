import type { DbClient } from "@tedix/db/client";
import { getAppBySlugForOrg } from "@tedix/db/queries/apps";
import { getOrganizationById } from "@tedix/db/queries/organizations";
import { organizationGatewaySlug } from "../../../lib/organization-mcp-gateway";

/** The organization's Code Mode gateway, which carries the Workspace tools. */
export async function organizationGatewayApp(
	db: DbClient,
	organizationId: string,
): Promise<string | null> {
	const organization = await getOrganizationById(db, organizationId);
	if (!organization?.slug) return null;
	const slug = organizationGatewaySlug(
		organization.slug,
		organizationId,
	).toLowerCase();
	const app = await getAppBySlugForOrg(db, slug, organizationId);
	return app?.slug ?? null;
}
