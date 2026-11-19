#!/usr/bin/env bun
/**
 * Build `billing.publishProviderModelRate` payloads for Workers AI from the
 * reviewed Neuron evidence next to this file. It prints payloads only; it
 * never publishes. Account and rate-version IDs are live identifiers, so they
 * are arguments, not checked-in data:
 *
 *   bun run scripts/billing/workers-ai-neuron-rates.ts \
 *     --account-id <cloudflare account id> \
 *     --effective-from 2026-11-20T00:00:00.000Z \
 *     --supersede '@cf/moonshotai/kimi-k2.7-code=<rate version uuid>@<its effective_from>'
 *
 * `--effective-from` applies to initial publications and must be later than
 * the publish time. A correction keeps the superseded row's start.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type * as z from "zod";
import { PublishProviderModelRateInputSchema } from "@tedix/api-contract/schemas/provider-model-pricing";
import { workersAiTokenRatesFromNeurons } from "@tedix/db/utils/workers-ai-neuron-pricing";

export const EVIDENCE_PATH = new URL(
	"./workers-ai-neuron-rates.evidence.json",
	import.meta.url,
);

interface EvidenceModel {
	modelId: string;
	pricingRow: string;
	inputNeuronsPerMillion: number;
	cachedInputNeuronsPerMillion: number | null;
	outputNeuronsPerMillion: number;
	publish: "initial" | "correction" | "none";
	note: string;
}

interface Evidence {
	source: { url: string; retrievedAt: string; usdPerThousandNeurons: number };
	models: EvidenceModel[];
}

export interface BuildOptions {
	accountId: string;
	effectiveFrom: string;
	supersedes: Record<string, { id: string; effectiveFrom: string }>;
}

export type WorkersAiRatePublication = z.input<
	typeof PublishProviderModelRateInputSchema
>;

export function buildWorkersAiNeuronRatePublications(
	evidenceBytes: Uint8Array,
	options: BuildOptions,
): WorkersAiRatePublication[] {
	const evidence = JSON.parse(
		new TextDecoder().decode(evidenceBytes),
	) as Evidence;
	if (evidence.source.usdPerThousandNeurons !== 0.011)
		throw new Error("Evidence Neuron price changed; update the derivation");
	const evidenceDigest = createHash("sha256")
		.update(evidenceBytes)
		.digest("hex");
	const deploymentScope = JSON.stringify(["workers-ai", options.accountId]);
	const verifiedAt = new Date(evidence.source.retrievedAt).toISOString();
	return evidence.models
		.filter((model) => model.publish !== "none")
		.map((model) => {
			const prior = options.supersedes[model.modelId];
			if (model.publish === "correction" && !prior)
				throw new Error(`${model.modelId} needs --supersede`);
			if (model.publish === "initial" && prior)
				throw new Error(`${model.modelId} is an initial publication`);
			const rates = workersAiTokenRatesFromNeurons(model);
			const neurons = `${model.inputNeuronsPerMillion} input / ${model.cachedInputNeuronsPerMillion ?? model.inputNeuronsPerMillion} cached input / ${model.outputNeuronsPerMillion} output Neurons per million tokens`;
			return PublishProviderModelRateInputSchema.parse({
				provider: "workers-ai",
				modelId: model.modelId,
				deploymentScope,
				inputTokenMin: 0,
				inputTokenMax: null,
				effectiveFrom: prior
					? new Date(prior.effectiveFrom).toISOString()
					: new Date(options.effectiveFrom).toISOString(),
				...rates,
				currency: "USD",
				evidenceUri: evidence.source.url,
				evidenceDigest,
				verifiedAt,
				changeReason:
					`Work 90547053: price Workers AI from what Cloudflare bills. Cloudflare pricing row ${model.pricingRow}: ${neurons} at $0.011 per 1,000 Neurons (11 USD micros per Neuron). ${model.note}`.slice(
						0,
						2000,
					),
				supersedesRateVersionId: prior?.id ?? null,
			});
		});
}

function parseSupersedes(values: string[]) {
	const supersedes: BuildOptions["supersedes"] = {};
	for (const value of values) {
		const match = /^(.+)=([0-9a-f-]{36})@(.+)$/.exec(value);
		if (!match) throw new Error(`Bad --supersede ${value}`);
		supersedes[match[1]!] = { id: match[2]!, effectiveFrom: match[3]! };
	}
	return supersedes;
}

if (import.meta.main) {
	const { values } = parseArgs({
		options: {
			"account-id": { type: "string" },
			"effective-from": { type: "string" },
			supersede: { type: "string", multiple: true, default: [] },
		},
	});
	if (!values["account-id"] || !values["effective-from"])
		throw new Error("--account-id and --effective-from are required");
	const publications = buildWorkersAiNeuronRatePublications(
		readFileSync(EVIDENCE_PATH),
		{
			accountId: values["account-id"],
			effectiveFrom: values["effective-from"],
			supersedes: parseSupersedes(values.supersede),
		},
	);
	console.log(JSON.stringify(publications, null, "\t"));
}
