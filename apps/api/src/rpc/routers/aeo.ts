/**
 * oRPC AEO (Answer Engine Optimization) Router
 *
 * Minimal, LIVE citation-rate measurement: sends realistic category queries
 * to a real LLM and grades the raw response text for an exact-text mention of
 * a target brand (and, optionally, named competitors). Mirrors the mechanism
 * Cloudflare described in "Introducing AEO measurement" (blog.cloudflare.com/
 * aeo/): probe a real model, grade the actual response text —
 * not model self-report.
 *
 * Sibling of `seo.ts`. Deliberate v1 scope cuts:
 *
 * - No persistence. This is a request/response research procedure, same
 *   shape as `seo.ts`'s `researchKeywords`/`getSerpResults` before their
 *   receipts are read back — a caller that wants a trend re-runs this and
 *   stores results itself. No new D1 table/migration for v1.
 * - No credit metering. `seo.ts`'s DataForSEO managed-credit pipeline
 *   (`runSeoResearch`: atomic reservation → provider call → settle/release)
 *   is deliberately NOT reused or copied here — wiring a new paid-inference
 *   product-metering surface is separate, riskier work than this task's
 *   scope. This procedure calls the plain Workers AI binding directly
 *   (`env.AI.run(...)`, no billing reservation) — already-provisioned
 *   Worker capacity, not a new spend surface.
 *
 * Auth model: org-scoped `apps:read` — same guard as `seo.ts`'s research
 * procedures. Read-only research; no app/tenant resource is mutated.
 */

import { implement } from "@orpc/server";
import { aeoContract } from "@tedix/api-contract/contracts/aeo";
import { scanAgentReadiness } from "../../services/aeo-agent-readiness";
import {
	DEFAULT_AEO_QUERIES,
	scoreAeoQuery,
	summarizeAeoResults,
} from "../../services/aeo-citation-scoring";
import { requireOrgId } from "../org-scope";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
} from "../orpc";

const aeoOs = implement(aeoContract).$context<BaseContext>();
const authedOs = aeoOs.use(withAuth);

// gpt-oss-120b: same agentic-bench-winning Workers AI default the kernel uses
// (see rpc/routers/kernel/llm.ts resolveKernelWorkersAiModel) — strict JSON,
// zero empty turns, cheap output. AEO probing needs plain prose, not JSON
// mode, but the same model is a reasonable, already-vetted default.
const DEFAULT_MODEL_ID = "@cf/openai/gpt-oss-120b";

export const scanHostname = authedOs.scanHostname
	.use(AUTHZ.appsRead)
	.handler(async ({ input, context }) => {
		requireOrgId(context);
		try {
			return await scanAgentReadiness(input.url, input.profile);
		} catch (error) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`Agent readiness scan failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	});

async function queryModel(
	env: CloudflareEnv,
	modelId: string,
	query: string,
): Promise<string> {
	const response = (await env.AI.run(
		modelId as keyof AiModels,
		{
			messages: [{ role: "user", content: query }],
			max_tokens: 512,
		},
		env.AI_GATEWAY_LLM_ID
			? {
					gateway: {
						id: env.AI_GATEWAY_LLM_ID,
						metadata: { surface: "aeo" },
					},
				}
			: undefined,
	)) as AiTextGenerationOutput;
	return typeof response?.response === "string" ? response.response : "";
}

export const measureCitationRate = authedOs.measureCitationRate
	.use(AUTHZ.appsRead)
	.handler(async ({ input, context }) => {
		// Org attribution only (no org-scoped resource is read/written) — this
		// still proves the caller is a real tenant, matching every other
		// research procedure in this app.
		requireOrgId(context);

		const queries =
			input.queries && input.queries.length > 0
				? input.queries
				: [...DEFAULT_AEO_QUERIES];
		const modelId = input.modelId?.trim() || DEFAULT_MODEL_ID;
		const competitors = input.competitors ?? [];

		const scores = [];
		for (const query of queries) {
			let responseText: string;
			try {
				responseText = await queryModel(context.env, modelId, query);
			} catch (error) {
				throw createError(
					ErrorCodes.INTERNAL_SERVER_ERROR,
					`AEO probe failed for query "${query}": ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
			scores.push(
				scoreAeoQuery(query, responseText, input.targetBrand, competitors),
			);
		}

		return {
			measurementKind: "brand_mention" as const,
			targetBrand: input.targetBrand,
			model: modelId,
			results: scores.map((score) => ({
				query: score.query,
				responseText: score.responseText,
				mentioned: score.target.mentioned,
				position: score.target.position,
				prominence: score.target.prominence,
				competitorMentions: score.competitors,
			})),
			summary: summarizeAeoResults(scores),
		};
	});

export const aeoContractRouter = aeoOs.router({
	scanHostname,
	measureCitationRate,
});
