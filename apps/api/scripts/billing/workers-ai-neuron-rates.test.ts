import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import {
	buildWorkersAiNeuronRatePublications,
	EVIDENCE_PATH,
} from "./workers-ai-neuron-rates";

// Fictional identifiers; live ones are passed on the command line.
const accountId = "0123456789abcdef0123456789abcdef";
const priorId = "00000000-0000-4000-8000-000000000001";
const evidence = readFileSync(EVIDENCE_PATH);
const build = () =>
	buildWorkersAiNeuronRatePublications(evidence, {
		accountId,
		effectiveFrom: "2026-11-20T00:00:00Z",
		supersedes: {
			"@cf/moonshotai/kimi-k2.7-code": {
				id: priorId,
				effectiveFrom: "2026-11-07T20:58:00.000Z",
			},
		},
	});

describe("Workers AI Neuron rate publications", () => {
	it("derives every published rate from the reviewed Neuron table", () => {
		const byModel = Object.fromEntries(
			build().map((row) => [row.modelId, row]),
		);
		expect(Object.keys(byModel).sort()).toEqual([
			"@cf/meta/llama-3.1-8b-instruct-fast",
			"@cf/meta/llama-3.3-70b-instruct-fp8-fast",
			"@cf/moonshotai/kimi-k2.7-code",
			"@cf/openai/gpt-oss-120b",
		]);
		expect(byModel["@cf/moonshotai/kimi-k2.7-code"]).toMatchObject({
			inputMicrousdPerMillion: 950004,
			cacheReadMicrousdPerMillion: 190003,
			cacheWriteMicrousdPerMillion: 950004,
			outputMicrousdPerMillion: 3999996,
			effectiveFrom: "2026-11-07T20:58:00.000Z",
			supersedesRateVersionId: priorId,
		});
		expect(byModel["@cf/meta/llama-3.1-8b-instruct-fast"]).toMatchObject({
			inputMicrousdPerMillion: 45309,
			cacheReadMicrousdPerMillion: 45309,
			outputMicrousdPerMillion: 383548,
			effectiveFrom: "2026-11-20T00:00:00.000Z",
			supersedesRateVersionId: null,
		});
	});

	it("binds every row to the evidence bytes and the account scope", () => {
		const digest = createHash("sha256").update(evidence).digest("hex");
		for (const row of build()) {
			expect(row.evidenceDigest).toBe(digest);
			expect(row.deploymentScope).toBe(`["workers-ai","${accountId}"]`);
			expect(row.changeReason).toContain("Neurons per million tokens");
		}
	});

	it("refuses a correction without the version it supersedes", () =>
		expect(() =>
			buildWorkersAiNeuronRatePublications(evidence, {
				accountId,
				effectiveFrom: "2026-11-20T00:00:00Z",
				supersedes: {},
			}),
		).toThrow(/needs --supersede/));
});
