import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const identity = z.string().min(1).max(500);
export const ProviderCostPricingBasisSchema = z.enum([
	"reported_estimate",
	"rate_estimated",
]);
export const ProviderCostEvidenceProjectionSchema = z.strictObject({
	versionId: z.uuid(),
	pricingBasis: ProviderCostPricingBasisSchema,
	providerEstimatedCostMicros: integer,
	basisFactsDigest: digest,
	sourceSnapshotDigest: digest,
	effectiveCostBasis: z.literal("reviewed_provider_estimate"),
	originalCostBasis: z.enum([
		"gateway_reported",
		"governed_estimate",
		"legacy_estimate",
		"unknown",
	]),
	originalCostReason: z.string().nullable(),
	originalDataQuality: z.enum([
		"ok",
		"quarantined_no_pricing",
		"quarantined_failed",
	]),
	originalEstimatedCostUsd: z.number().nullable(),
});
export type ProviderCostEvidenceProjection = z.infer<
	typeof ProviderCostEvidenceProjectionSchema
>;

export const RecordProviderCostEvidenceInputSchema = z
	.strictObject({
		mode: z.enum(["validate_only", "append"]),
		financialWorkItemId: z.uuid(),
		approvalProposalId: z.uuid(),
		approvalDecisionId: z.uuid(),
		attemptId: z.uuid().nullable(),
		records: z
			.array(
				z.strictObject({
					sourceCallId: identity,
					expectedSourceDigest: digest,
					expectedParentEvidenceVersionId: z.uuid().nullable(),
					idempotencyDigest: digest,
				}),
			)
			.min(1)
			.max(20),
	})
	.superRefine((value, ctx) => {
		if (value.mode === "append" && value.attemptId === null)
			ctx.addIssue({
				code: "custom",
				message: "Append requires an admitted Attempt",
				path: ["attemptId"],
			});
		if (
			new Set(value.records.map((r) => r.sourceCallId)).size !==
			value.records.length
		)
			ctx.addIssue({
				code: "custom",
				message: "Duplicate source identity",
				path: ["records"],
			});
		if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 32_768)
			ctx.addIssue({ code: "custom", message: "Request exceeds 32 KiB" });
	});
export type RecordProviderCostEvidenceInput = z.infer<
	typeof RecordProviderCostEvidenceInputSchema
>;
/** Exact decimal arithmetic; Gateway estimates are never provider invoices. */
export const ReportedCostDecimalSchema = z
	.string()
	.max(36)
	.regex(/^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/);
export function reportedCostDecimalToMicros(decimal: string): number {
	const parsed = ReportedCostDecimalSchema.parse(decimal);
	const [whole, fraction = ""] = parsed.split(".");
	const denominator = 10n ** BigInt(fraction.length);
	const numerator = BigInt(whole + fraction) * 1_000_000n;
	const micros = (numerator + denominator - 1n) / denominator;
	if (micros > BigInt(Number.MAX_SAFE_INTEGER))
		throw new Error("Provider estimate exceeds safe micros");
	return Number(micros);
}

export const ProviderNativeUsageSchema = z
	.strictObject({
		inputTokens: integer,
		outputTokens: integer,
		cacheReadTokens: integer,
		cacheWriteTokens: integer,
		known: z.literal(true),
	})
	.refine(
		(u) => u.cacheReadTokens <= u.inputTokens - u.cacheWriteTokens,
		"Cache usage exceeds inclusive input",
	);
const commonFacts = {
	provider: identity,
	nativeModel: identity,
	originalOrgId: z.uuid(),
	nativeOrgId: z.uuid(),
	sourceGatewayId: identity,
	gatewayLogId: identity,
	sourceCallId: identity,
	occurredAt: z.iso.datetime(),
	sourceSnapshotDigest: digest,
	detailReceiptDigest: digest,
	listReceiptDigest: digest,
	usage: ProviderNativeUsageSchema,
	currency: z.literal("USD"),
	originalSourceSnapshot: z.record(z.string(), z.json()),
	nativeSourceFingerprint: digest,
};
export const ProviderCostBasisFactsSchema = z.discriminatedUnion(
	"pricingBasis",
	[
		z.strictObject({
			...commonFacts,
			pricingBasis: z.literal("reported_estimate"),
			reporter: z.literal("cloudflare_ai_gateway"),
			reportedCostDecimal: ReportedCostDecimalSchema,
			customCost: z.literal(false),
			wholesale: z.literal(false),
			costMeaning: z.literal("provider_estimate"),
			complete: z.literal(true),
		}),
		z
			.strictObject({
				...commonFacts,
				pricingBasis: z.literal("rate_estimated"),
				rateCertificateDigest: digest,
				effectiveFrom: z.iso.datetime(),
				effectiveTo: z.iso.datetime(),
				contextTier: identity,
				resource: identity,
				region: identity,
				sku: identity,
				cacheMeter: identity,
				unit: z.literal("USD_per_million_tokens"),
				inputPriceMicrosPerMillion: integer,
				outputPriceMicrosPerMillion: integer,
				cacheReadPriceMicrosPerMillion: integer,
				cacheWritePriceMicrosPerMillion: integer,
			})
			.refine(
				(f) => f.effectiveFrom <= f.occurredAt && f.occurredAt < f.effectiveTo,
				"Rate does not cover event time",
			),
	],
);
export type ProviderCostBasisFacts = z.infer<
	typeof ProviderCostBasisFactsSchema
>;
export const RecordProviderCostEvidenceResponseSchema = z.strictObject({
	mode: z.enum(["validate_only", "append"]),
	writes: integer,
	records: z
		.array(
			z.strictObject({
				sourceCallId: identity,
				status: z.enum(["validated", "appended", "existing", "refused"]),
				versionId: z.uuid().nullable(),
				reason: z.string().max(500).nullable(),
				basisFacts: ProviderCostBasisFactsSchema.nullable(),
				basisFactsDigest: digest.nullable(),
				calculatedMicros: integer.nullable(),
				persistedMicros: integer.nullable(),
				sourceRetired: z.boolean(),
			}),
		)
		.max(20),
});

export const ProviderCostFinancialManifestSchema = z
	.strictObject({
		version: z.literal(2),
		kind: z.literal("provider_estimate_correction"),
		action: z.literal("billing.recordProviderCostEvidence"),
		organizationId: z.uuid(),
		financialWorkItemId: z.uuid(),
		workVersion: integer.positive(),
		specRevision: digest.or(z.string().regex(/^[a-f0-9]{32}$/)),
		designatedApproverId: z.uuid(),
		deliveredSourceSha: z.string().regex(/^[a-f0-9]{40}$/),
		expiresAt: z.iso.datetime(),
		currency: z.literal("USD"),
		manifestMaxMicros: integer,
		records: z
			.array(
				z.strictObject({
					facts: ProviderCostBasisFactsSchema,
					basisFactsDigest: digest,
					expectedParentEvidenceVersionId: z.uuid().nullable(),
					expectedCostMicros: integer,
					maxCostMicros: integer,
				}),
			)
			.min(1)
			.max(20),
	})
	.superRefine((m, ctx) => {
		let sum = 0n;
		const identities = new Set<string>();
		for (const record of m.records) {
			const key = JSON.stringify([
				record.facts.originalOrgId,
				record.facts.sourceGatewayId,
				record.facts.gatewayLogId,
				record.facts.sourceCallId,
			]);
			if (
				identities.has(key) ||
				record.facts.originalOrgId !== m.organizationId ||
				record.facts.nativeOrgId !== m.organizationId ||
				record.expectedCostMicros > record.maxCostMicros
			)
				ctx.addIssue({
					code: "custom",
					message: "Manifest identity or record cap mismatch",
				});
			identities.add(key);
			sum += BigInt(record.expectedCostMicros);
		}
		if (
			sum > BigInt(m.manifestMaxMicros) ||
			sum > BigInt(Number.MAX_SAFE_INTEGER)
		)
			ctx.addIssue({
				code: "custom",
				message: "Manifest total exceeds approved cap",
			});
	});
export type ProviderCostFinancialManifest = z.infer<
	typeof ProviderCostFinancialManifestSchema
>;

export async function providerCostEvidenceDigest(
	domain: "source" | "basis" | "manifest" | "payload",
	value: unknown,
): Promise<string> {
	const canonical = (v: unknown): unknown => {
		if (v === null || typeof v === "string" || typeof v === "boolean") return v;
		if (typeof v === "number" && Number.isFinite(v)) return v;
		if (Array.isArray(v)) return v.map(canonical);
		if (typeof v === "object" && v !== null)
			return Object.fromEntries(
				Object.entries(v)
					.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
					.map(([key, entry]) => [key, canonical(entry)]),
			);
		throw new Error("Non-JSON evidence facts");
	};
	const raw = JSON.stringify([
		`tedix.billing.provider-cost-evidence.${domain}.v1`,
		canonical(value),
	]);
	const bytes = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(raw),
	);
	return Array.from(new Uint8Array(bytes), (v) =>
		v.toString(16).padStart(2, "0"),
	).join("");
}
