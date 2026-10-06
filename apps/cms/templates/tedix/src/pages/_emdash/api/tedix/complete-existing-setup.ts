import type { APIRoute } from "astro";
import { hasPermission } from "@emdash-cms/auth";
import { ContentRepository, SchemaRegistry } from "emdash";
import {
	apiError,
	apiSuccess,
	finalizeSetup,
	handleError,
	OptionsRepository,
} from "emdash/api/route-utils";

export const prerender = false;

/** Complete native onboarding for externally populated sites without applying a seed. */
export const POST: APIRoute = async ({ locals }) => {
	const { user, emdash } = locals;
	if (!user) return apiError("UNAUTHORIZED", "Authentication required", 401);
	if (!hasPermission(user, "settings:manage")) {
		return apiError("FORBIDDEN", "Site administrator required", 403);
	}
	if (!emdash?.db)
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 503);

	try {
		const options = new OptionsRepository(emdash.db);
		// finalizeSetup copies title/tagline from setup_state. Existing sites must
		// never inherit settings from an unfinished starter wizard.
		if ((await options.get("emdash:setup_state")) != null) {
			return apiError(
				"SETUP_STATE_EXISTS",
				"An unfinished setup wizard must be resolved first",
				409,
			);
		}
		const completed = await options.get("emdash:setup_complete");
		if (completed === true || completed === "true") {
			return apiSuccess({ setupComplete: true, alreadyComplete: true });
		}
		const collections = await new SchemaRegistry(emdash.db).listCollections();
		const content = new ContentRepository(emdash.db);
		let populated = false;
		for (const collection of collections) {
			if ((await content.count(collection.slug)) > 0) {
				populated = true;
				break;
			}
		}
		if (!populated) {
			return apiError(
				"SITE_NOT_POPULATED",
				"Complete fresh-site onboarding through the native setup wizard",
				409,
			);
		}
		await finalizeSetup(emdash.db);
		return apiSuccess({ setupComplete: true, alreadyComplete: false });
	} catch (error) {
		return handleError(
			error,
			"Failed to complete existing-site onboarding",
			"SETUP_COMPLETION_ERROR",
		);
	}
};
