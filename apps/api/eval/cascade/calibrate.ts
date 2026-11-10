import { readFileSync } from "node:fs";
import candidate from "@tedix/api-contract/assets/decision-cascade.v1.json";
import { DecisionCascadePolicySchema } from "@tedix/api-contract/schemas/decision-cascade";
import { calibrateCascadeThreshold, cascadeCorpusDigest } from "./calibration";

const path = process.argv[2];
const observations: unknown = path
	? JSON.parse(readFileSync(path, "utf8"))
	: {
			corpusDigest: cascadeCorpusDigest,
			policyRevision: candidate.revision,
			judgmentModel: candidate.judgmentModel,
			observations: [],
		};
console.log(
	JSON.stringify(
		calibrateCascadeThreshold(
			observations,
			DecisionCascadePolicySchema.parse(candidate),
		),
		null,
		2,
	),
);
