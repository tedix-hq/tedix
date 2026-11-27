import {
	cmsQueryDb,
	type CmsDatabase,
} from "@tedix/db/queries/cms-control-plane";
import { getOrganizationResidencyPolicy } from "@tedix/db/queries/data-residency";
import { getCmsTemplateSelection } from "./storage";

export async function requireUnrestrictedCmsModels(
	binding: CmsDatabase,
	slug: string,
): Promise<void> {
	const site = await getCmsTemplateSelection(binding, slug);
	if (!site)
		throw new Error(
			"Data residency requires a verified site owner before model processing",
		);
	const policy = await getOrganizationResidencyPolicy(
		cmsQueryDb(binding),
		site.organizationId,
	);
	if (policy && policy.mode !== "unrestricted")
		throw new Error(
			"EU_PROVIDER_ROUTE_REQUIRED: This site requires EU model processing. CMS generation has no verified regional adapter yet and is blocked. An administrator must configure a supported EU provider route before using this feature.",
		);
}
