import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { CASCADE_CASES, CASCADE_CORPUS_VERSION } from "./fixtures";
import { summarizeCascadeMeasurements } from "./measurements";

const path = process.argv[2];
const rows: unknown = path ? JSON.parse(readFileSync(path, "utf8")) : [];
if (!Array.isArray(rows)) throw new Error("Expected a measurement array");
console.log(
	JSON.stringify(
		{
			corpusVersion: CASCADE_CORPUS_VERSION,
			corpusDigest: createHash("sha256")
				.update(JSON.stringify(CASCADE_CASES))
				.digest("hex"),
			thresholdStatus: "uncalibrated",
			activation: "off",
			calibration: summarizeCascadeMeasurements(rows, "calibration"),
			holdout: summarizeCascadeMeasurements(rows, "holdout"),
		},
		null,
		2,
	),
);
