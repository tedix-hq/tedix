import { describe, expect, it } from "vite-plus/test";
import {
	parseDocsFileObservationReceipt,
	parseOwnedReadObservations,
} from "./read-observation-receipt";

const receipt = {
	version: 1,
	kind: "docs_file_observation",
	receiptId: "00000000-0000-4000-8000-000000000001",
	provider: { appSlug: "docs", toolName: "get_docs_file" },
	resource: {
		organizationSlug: "acme",
		siteId: "00000000-0000-4000-8000-000000000002",
		path: "index.md",
	},
	evidence: {
		contentSha256: "a".repeat(64),
		byteLength: 4,
		observedGitRevision: "b".repeat(40),
	},
	observedAt: "2026-09-22T12:00:00.000Z",
} as const;

describe("Docs file observation receipt", () => {
	it("accepts the exact server receipt and rejects identity drift", () => {
		expect(parseDocsFileObservationReceipt(receipt)).toEqual(receipt);
		expect(
			parseDocsFileObservationReceipt({
				...receipt,
				attackerGrant: "admin",
				resource: { ...receipt.resource, attackerGrant: true },
			}),
		).toEqual(receipt);
		expect(
			parseDocsFileObservationReceipt({
				...receipt,
				provider: { ...receipt.provider, toolName: "other" },
			}),
		).toBeNull();
		expect(
			parseDocsFileObservationReceipt({
				...receipt,
				evidence: { ...receipt.evidence, contentSha256: "no" },
			}),
		).toBeNull();
	});

	it("fails the whole sideband closed on a malformed member", () => {
		expect(
			parseOwnedReadObservations([{ innerCallId: "exec:0", receipt }]),
		).toHaveLength(1);
		expect(
			parseOwnedReadObservations([
				{ innerCallId: "exec:0", receipt },
				{ innerCallId: "exec:1", receipt: {} },
			]),
		).toEqual([]);
	});
});
