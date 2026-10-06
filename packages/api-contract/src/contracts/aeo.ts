import "@orpc/openapi/extensions/route";
/**
 * AEO (Answer Engine Optimization) Contract for oRPC
 *
 * Two evidence surfaces: deterministic hostname Agent Readiness diagnostics,
 * plus a LIVE brand-mention probe that sends realistic category queries
 * to a real LLM and grades the raw response text for an exact-text mention of
 * a target brand (and, optionally, named competitors). Mirrors the mechanism
 * Cloudflare described in "Introducing AEO measurement" (blog.cloudflare.com/
 * aeo/): probe a real model with realistic category queries and
 * grade the actual response text, not model self-report.
 *
 * v1 scope (deliberately small — see `apps/api/src/rpc/routers/aeo.ts` for the
 * full rationale):
 * - No persistence. Request/response research only, same shape as `seo.ts`'s
 *   research procedures before their receipts are read back.
 * - No credit metering. This calls the plain Workers AI binding directly
 *   (the same non-kernel pattern `catalog-enrichment-workflow.ts` uses), not
 *   `seo.ts`'s DataForSEO credit-reservation pipeline.
 *
 * Auth: same org-scoped `apps:read` guard as `seo.ts`'s research procedures —
 * this is read-only research, no app/tenant resource is mutated.
 */

import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";

// =============================================================================
// SHARED SCHEMAS
// =============================================================================

const BrandMentionSchema = z.object({
	name: z.string(),
	mentioned: z.boolean(),
	/** Character offset of the first exact-text mention in the response, or null when not mentioned. */
	position: z.number().int().nonnegative().nullable(),
	/**
	 * 0..1, where 1 means the mention occurred at the very start of the
	 * response and 0 means it occurred at the very end. Null when not
	 * mentioned.
	 */
	prominence: z.number().min(0).max(1).nullable(),
});

const AeoQueryResultSchema = z.object({
	query: z.string(),
	/** Full raw text returned by the model for this query. */
	responseText: z.string(),
	mentioned: z.boolean(),
	position: z.number().int().nonnegative().nullable(),
	prominence: z.number().min(0).max(1).nullable(),
	competitorMentions: z.array(BrandMentionSchema),
});

const AeoSummarySchema = z.object({
	totalQueries: z.number().int().nonnegative(),
	/** Fraction of queries whose response exact-text-mentioned the target brand. */
	citationRate: z.number().min(0).max(1),
	/** Mean prominence across queries where the target brand was mentioned; null when never mentioned. */
	averageProminence: z.number().min(0).max(1).nullable(),
	/**
	 * Mean, across queries with at least one brand mention (target or
	 * competitor), of target mentions / (target + competitor mentions).
	 * Null when no query had any mention.
	 */
	shareOfVoice: z.number().min(0).max(1).nullable(),
});

const ReadinessEvidenceSchema = z.object({
	request: z.object({
		method: z.string(),
		url: z.string().url(),
		headers: z.record(z.string(), z.string()),
	}),
	response: z.object({
		url: z.string().url(),
		status: z.number().int(),
		headers: z.record(z.string(), z.string()),
		bodySnippet: z.string(),
	}),
});

const ReadinessCheckSchema = z.object({
	key: z.string(),
	category: z.enum([
		"discoverability",
		"content",
		"bot_access",
		"capabilities",
	]),
	status: z.enum(["pass", "fail", "neutral"]),
	detail: z.string(),
	evidence: ReadinessEvidenceSchema,
});

// =============================================================================
// CONTRACT
// =============================================================================

export const aeoContract = oc
	.route({ tags: ["aeo"], prefix: "/aeo" })
	.errors(baseErrors)
	.router({
		scanHostname: oc
			.route({
				method: "POST",
				path: "/scan-hostname",
				summary: "Scan hostname agent readiness",
				description:
					"Fetch a public HTTPS hostname as an agent would and return pass, fail, or neutral checks with bounded request and response evidence. Redirect targets are revalidated before every request.",
			})
			.input(
				z.object({
					url: z.string().url().max(2048),
					profile: z.enum(["all", "content"]).default("all"),
				}),
			)
			.output(
				z.object({
					hostname: z.string(),
					url: z.string().url(),
					profile: z.enum(["all", "content"]),
					level: z.number().int().min(0).max(5),
					summary: z.object({
						pass: z.number().int().nonnegative(),
						fail: z.number().int().nonnegative(),
						neutral: z.number().int().nonnegative(),
					}),
					checks: z.array(ReadinessCheckSchema),
					scannedAt: z.string().datetime(),
				}),
			),
		/**
		 * Probe a real LLM with category queries and grade the response text
		 * for an exact-text mention of the target brand (and, optionally,
		 * named competitors).
		 * POST /aeo/measure-citation-rate
		 */
		measureCitationRate: oc
			.route({
				method: "POST",
				path: "/measure-citation-rate",
				summary: "Measure AEO citation rate",
				description:
					"Send realistic category queries to a live LLM and grade the actual response text for an exact-text mention of the target brand and any named competitors. This is brand-mention evidence, not cited-domain evidence. No persistence; use the hostname report or a connected citation analytics provider for durable cited-domain trends.",
			})
			.input(
				z.object({
					targetBrand: z.string().trim().min(1).max(100).default("Tedix"),
					/** Category queries to probe. Defaults to a small fixed Tedix-category set when omitted. */
					queries: z
						.array(z.string().trim().min(1).max(500))
						.min(1)
						.max(10)
						.optional(),
					/** Competitor brand names to also check for in the same response. */
					competitors: z
						.array(z.string().trim().min(1).max(100))
						.max(10)
						.optional(),
					/** Workers AI model id override. Defaults to a capable instruct model. */
					modelId: z.string().trim().min(1).optional(),
				}),
			)
			.output(
				z.object({
					measurementKind: z.literal("brand_mention"),
					targetBrand: z.string(),
					model: z.string(),
					results: z.array(AeoQueryResultSchema),
					summary: AeoSummarySchema,
				}),
			),
	});

export type AeoContract = typeof aeoContract;
