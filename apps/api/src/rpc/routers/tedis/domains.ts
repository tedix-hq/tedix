/**
 * Tedis Router — Custom domains
 */

import {
	addCustomDomain,
	getCustomDomainById,
	getCustomDomainsByTedi,
	removeCustomDomain,
} from "@tedix/db/queries/tedis";
import { normalizeSurfaceHostname } from "@tedix/tenant-directory";
import {
	AUTHZ,
	withAuthorization,
	authedTedisOs,
	createError,
	ErrorCodes,
	requireTediAccess,
} from "./helpers";

// =============================================================================
// CUSTOM DOMAINS
// =============================================================================

export const listCustomDomains = authedTedisOs.listCustomDomains
	.use(AUTHZ.tedisAppsRead)
	.handler(async ({ input, context }) => {
		await requireTediAccess(context, input.tediId);
		const domains = await getCustomDomainsByTedi(context.db, input.tediId);
		return {
			data: domains.map((d) => ({
				...d,
				status: d.status as "pending" | "active" | "error" | null,
				sslStatus: d.sslStatus as "pending" | "active" | "error" | null,
			})),
		};
	});

export const addCustomDomainProcedure = authedTedisOs.addCustomDomain
	.use(AUTHZ.tedisAppsWrite)
	.handler(async ({ input, context }) => {
		await requireTediAccess(context, input.tediId);

		const domain = await addCustomDomain(context.db, {
			id: crypto.randomUUID(),
			tediId: input.tediId,
			hostname: normalizeSurfaceHostname(input.hostname),
			status: "pending",
			sslStatus: "pending",
		});

		console.log(
			`[Tedis] Added custom domain: ${domain.hostname} for tedi ${input.tediId}`,
		);

		return {
			...domain,
			status: domain.status as "pending" | "active" | "error" | null,
			sslStatus: domain.sslStatus as "pending" | "active" | "error" | null,
		};
	});

export const removeCustomDomainProcedure = authedTedisOs.removeCustomDomain
	.use(withAuthorization("tedis:delete", "apps:write"))
	.handler(async ({ input, context }) => {
		await requireTediAccess(context, input.tediId);

		const domain = await getCustomDomainById(context.db, input.domainId);
		if (!domain || domain.tediId !== input.tediId) {
			throw createError(ErrorCodes.NOT_FOUND, "Domain not found");
		}

		await removeCustomDomain(context.db, input.domainId);
		console.log(`[Tedis] Removed custom domain: ${domain.hostname}`);

		return {
			success: true as const,
			message: `Domain "${domain.hostname}" removed`,
		};
	});
