import {
	EvaluateLedgerModelInputSchema,
	type EvaluateLedgerModelInput,
	EvaluateLedgerModelResultSchema,
} from "@tedix/api-contract/schemas/ledger-model-evaluation";
import type { DbQueryClient } from "@tedix/db/query-client";
import { getModelCatalogConfig } from "@tedix/db/queries/model-catalog";
import { findCatalogEntry } from "@tedix/api-contract/schemas/model-catalog";
import {
	getLedgerEvaluationCase,
	hashLedgerEvaluationCase,
} from "@tedix/context-core/ledger-model-evaluation";
import { createError, ErrorCodes } from "../rpc/orpc";
import {
	organizationModelEnv,
	assertModelEgressAllowed,
} from "./unrouted-model-egress";
import { fetchLedgerGatewayCompletion } from "./ledger-gateway-completion";

export async function evaluateLedgerModel(
	env: CloudflareEnv,
	db: DbQueryClient,
	organizationId: string,
	raw: EvaluateLedgerModelInput,
) {
	const input = EvaluateLedgerModelInputSchema.parse(raw);
	const fixture = getLedgerEvaluationCase(
		input.surface,
		input.caseId,
		input.promptVariant,
	);
	if (!fixture)
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Unknown evaluation case or prompt variant",
		);
	const catalog = await getModelCatalogConfig(db);
	const model = findCatalogEntry(input.modelRef, catalog.entries);
	if (
		!model ||
		model.provider !== "azure-openai" ||
		model.lifecycle !== "active"
	)
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Evaluation model is not configured",
		);
	const scoped = organizationModelEnv(env, db, organizationId);
	await assertModelEgressAllowed(scoped);
	const hashes = await hashLedgerEvaluationCase(fixture);
	const startedAt = Date.now();
	const base = {
		...input,
		...hashes,
		output: null as string | null,
		error: null as string | null,
		providerRequestId: null as string | null,
		usage: {
			inputTokens: null as number | null,
			outputTokens: null as number | null,
			totalTokens: null as number | null,
			cachedInputTokens: null as number | null,
			reasoningTokens: null as number | null,
		},
	};
	const result = (
		status:
			| "completed"
			| "incomplete"
			| "http_error"
			| "transport_error"
			| "unavailable",
	) =>
		EvaluateLedgerModelResultSchema.parse({
			...base,
			status,
			latencyMs: Date.now() - startedAt,
		});
	try {
		const pending = fetchLedgerGatewayCompletion(scoped, {
			model: model.modelId,
			system: fixture.system,
			prompt: fixture.prompt,
			metadata: {
				surface: "ledger-qualification",
				orgId: organizationId,
				evaluationId: input.evaluationId,
				modelRef: input.modelRef,
				case: `${input.surface}:${input.caseId}:${input.promptVariant}`,
			},
		});
		if (!pending) {
			base.error = "Managed evaluation transport unavailable";
			return result("unavailable");
		}
		const response = await pending;
		base.providerRequestId =
			(
				response.headers.get("x-request-id") ??
				response.headers.get("apim-request-id") ??
				response.headers.get("cf-aig-event-id")
			)?.slice(0, 256) ?? null;
		if (!response.ok) {
			base.error = `Evaluation provider HTTP ${response.status}`;
			return result("http_error");
		}
		const body = (await response.json()) as {
			status?: string;
			output?: Array<{
				type?: string;
				content?: Array<{ type?: string; text?: string }>;
			}>;
			usage?: {
				input_tokens?: number;
				output_tokens?: number;
				total_tokens?: number;
				input_tokens_details?: { cached_tokens?: number };
				output_tokens_details?: { reasoning_tokens?: number };
			};
		};
		const count = (n: unknown) =>
			typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
		base.usage = {
			inputTokens: count(body.usage?.input_tokens),
			outputTokens: count(body.usage?.output_tokens),
			totalTokens: count(body.usage?.total_tokens),
			cachedInputTokens: count(body.usage?.input_tokens_details?.cached_tokens),
			reasoningTokens: count(
				body.usage?.output_tokens_details?.reasoning_tokens,
			),
		};
		base.output =
			body.output
				?.filter((part) => part.type === "message")
				.flatMap((part) => part.content ?? [])
				.filter((part) => part.type === "output_text")
				.map((part) => part.text ?? "")
				.join("\n") ?? null;
		if (body.status !== "completed") {
			base.error = "Evaluation provider did not complete";
			return result("incomplete");
		}
		return result("completed");
	} catch {
		base.error =
			"Evaluation model transport failed or exceeded its 24-second deadline";
		return result("transport_error");
	}
}
