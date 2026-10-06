/**
 * Tedis Router — OAuth Connection Initiation
 */

import { getAppBySlug } from "@tedix/db/queries/apps";
import { getOrganizationById } from "@tedix/db/queries/organizations";
import { getTediById } from "@tedix/db/queries/tedis";
import { getToolsByAppId } from "@tedix/db/queries/tools";
import {
	buildSurfaceUrl,
	platformDomainForEnvironment,
} from "@tedix/tenant-directory";
import { createError, ErrorCodes, tedisOs, withServiceAuth } from "./helpers";

// =============================================================================
// INITIATE APP CONNECTION
// =============================================================================

export const initiateAppConnectionProcedure = tedisOs.initiateAppConnection
	.use(withServiceAuth)
	.handler(async ({ input, context }) => {
		const { tediId, appSlug } = input;

		// 1. Look up the tedi to get the org ID
		const tedi = await getTediById(context.db, tediId);
		if (!tedi) {
			throw createError(ErrorCodes.NOT_FOUND, "Tedi not found");
		}

		// 2. Look up the org to get the slug and descopeTenantId
		const org = await getOrganizationById(context.db, tedi.organizationId);
		if (!org) {
			throw createError(ErrorCodes.NOT_FOUND, "Organization not found");
		}

		// 3. Look up the app by slug
		const app = await getAppBySlug(context.db, appSlug);

		if (!app) {
			throw createError(
				ErrorCodes.NOT_FOUND,
				`App not found with slug: ${appSlug}`,
			);
		}

		// 4. Find the app's tools and extract connectionId
		const tools = await getToolsByAppId(context.db, app.id);

		let connectionId: string | undefined;
		for (const tool of tools) {
			const config = tool.config as Record<string, unknown> | null;
			if (!config) continue;

			const auth = config.auth as
				| { type?: string; connectionId?: string }
				| undefined;
			if (auth?.type === "connection" && auth.connectionId) {
				connectionId = auth.connectionId;
				break;
			}
		}

		if (!connectionId) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`No OAuth connection configured for app "${appSlug}". The app's tools do not have a connection auth config.`,
			);
		}

		// 5. Build the Tedix OS URL. Connections live at OS /admin/connections;
		// OS tenancy is hostname-based, so the org slug rides the
		// host ({slug}.os.tedix.dev) rather than a path segment. An
		// unauthenticated visit routes through the session broker and returns to
		// this URL, where ?connect= auto-starts the provider flow.
		const osOrigin = buildSurfaceUrl("os", org.slug, {
			platformDomain: platformDomainForEnvironment(
				context.env.ENVIRONMENT || "production",
			),
		});
		if (!osOrigin) {
			throw createError(
				ErrorCodes.NOT_FOUND,
				"Organization has no slug to build a Tedix OS connections URL",
			);
		}
		const connectTarget = new URL("/admin/connections", osOrigin);
		connectTarget.searchParams.set("connect", connectionId);
		const connectUrl = connectTarget.toString();

		// 6. Return the connection URL
		return {
			connectUrl,
			providerName: app.name,
			message: `Open this URL in your browser to connect ${app.name}: ${connectUrl}`,
		};
	});
