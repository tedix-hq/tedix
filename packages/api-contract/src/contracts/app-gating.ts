import "@orpc/openapi/extensions/route";
/**
 * App Gating Contract for oRPC
 * Eligibility checking endpoints for apps and tools.
 */

import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";
import {
	EligibilityBadgeSchema,
	EligibilityResultSchema,
	RuntimeToolInfoSchema,
} from "../schemas/app-gating";
import { AppIdParamSchema } from "../schemas/common";

export const appGatingContract = oc
	.route({ tags: ["app-gating"], prefix: "/app-gating" })
	.errors(baseErrors)
	.router({
		/**
		 * Check eligibility for a single app
		 * GET /app-gating/eligibility/{appId}
		 */
		eligibility: oc
			.route({
				method: "GET",
				path: "/eligibility/{appId}",
				summary: "Check app eligibility",
				description:
					"Check whether an app's requirements are met by the current org. Returns missing requirements with actionable resolution steps.",
			})
			.input(AppIdParamSchema)
			.output(
				EligibilityResultSchema.extend({
					badge: EligibilityBadgeSchema,
				}),
			),

		/**
		 * Batch check eligibility for all installed apps
		 * GET /app-gating/installed
		 */
		installedEligibility: oc
			.route({
				method: "GET",
				path: "/installed",
				summary: "Batch check installed apps eligibility",
				description:
					"Check eligibility for all apps installed by the current org. Used by tedi on session start.",
			})
			.output(
				z.array(
					z.object({
						appId: z.string(),
						appName: z.string(),
						result: EligibilityResultSchema,
						badge: EligibilityBadgeSchema,
					}),
				),
			),

		/**
		 * Get runtime tools for a tedi session
		 * GET /app-gating/runtime-tools/{tediId}
		 */
		runtimeTools: oc
			.route({
				method: "GET",
				path: "/runtime-tools/{tediId}",
				summary: "Get eligible runtime tools",
				description:
					"Returns flat list of tools available for a tedi session, with availability status and reasons for unavailable tools.",
			})
			.input(z.object({ tediId: z.string() }))
			.output(z.array(RuntimeToolInfoSchema)),

		/**
		 * Check install-time eligibility
		 * GET /app-gating/install-check/{appId}
		 */
		installCheck: oc
			.route({
				method: "GET",
				path: "/install-check/{appId}",
				summary: "Check install eligibility",
				description:
					"Install-time eligibility check with setup guidance. Returns whether the app can be installed and what steps are needed.",
			})
			.input(AppIdParamSchema)
			.output(
				EligibilityResultSchema.extend({
					installable: z.boolean(),
					badge: EligibilityBadgeSchema,
				}),
			),
	});

export type AppGatingContract = typeof appGatingContract;
