import { describe, expect, it } from "vite-plus/test";
import {
	deriveToolWriteCapability,
	operatorKindToAnnotations,
	resolveToolAnnotations,
	writeCapabilityToAnnotations,
	ToolMetaSchema,
	withDerivedToolOperationalRiskPolicy,
} from "./tools";

/**
 * The declarative write-capability vocabulary. The whole point of the column is
 * that ABSENT is a third state, so these tests exist mostly to pin the places
 * where a `??` or a truthiness check would quietly collapse it into "read".
 */
describe("deriveToolWriteCapability", () => {
	it("keeps ABSENT distinct from FALSE", () => {
		// Absent: nobody said. Stays unclassified so the gates fail closed.
		expect(deriveToolWriteCapability(undefined)).toBeNull();
		expect(deriveToolWriteCapability(null)).toBeNull();
		expect(deriveToolWriteCapability({})).toBeNull();
		// Present-and-false: a POSITIVE statement that the tool mutates.
		expect(deriveToolWriteCapability({ readOnlyHint: false })).toBe("write");
		expect(deriveToolWriteCapability({ destructiveHint: false })).toBe("write");
		// Present-and-true.
		expect(deriveToolWriteCapability({ readOnlyHint: true })).toBe("read");
		expect(deriveToolWriteCapability({ destructiveHint: true })).toBe(
			"destructive",
		);
	});

	it("stays unclassified when annotations classify nothing", () => {
		// idempotent/openWorld say nothing about mutation. Treating a non-empty
		// annotation object as "annotated, therefore fine" is the failure mode.
		expect(
			deriveToolWriteCapability({ idempotentHint: true, openWorldHint: false }),
		).toBeNull();
		expect(deriveToolWriteCapability({ title: "Thing" })).toBeNull();
	});

	it("fails closed on contradictory hints", () => {
		expect(
			deriveToolWriteCapability({ readOnlyHint: true, destructiveHint: true }),
		).toBe("destructive");
	});

	it("agrees with the operator `kind` vocabulary it shares", () => {
		for (const kind of ["read", "write", "destructive"] as const) {
			expect(deriveToolWriteCapability(operatorKindToAnnotations(kind))).toBe(
				kind,
			);
		}
	});
});

describe("operational tool risk policy", () => {
	it("projects high-impact D1 policy into the destructive approval gate", () => {
		expect(
			resolveToolAnnotations({
				annotations: { destructiveHint: false },
				writeCapability: "write",
				meta: {
					"com.tedix/policy": {
						riskTier: "high_impact_write",
						blastRadius: "tenant",
					},
				},
			}),
		).toMatchObject({ readOnlyHint: false, destructiveHint: true });
	});

	it("rejects contradictory risk-tier and blast-radius declarations", () => {
		const parsed = ToolMetaSchema.safeParse({
			"com.tedix/policy": {
				riskTier: "external_side_effect",
				blastRadius: "tenant",
			},
		});
		expect(parsed.success).toBe(false);
	});

	it("persists a strict baseline and elevates third-party writes", () => {
		expect(
			withDerivedToolOperationalRiskPolicy({
				writeCapability: "write",
				config: { transport: "external" },
			}),
		).toMatchObject({
			"com.tedix/policy": {
				riskTier: "external_side_effect",
				blastRadius: "external_system",
			},
		});
	});
});

describe("resolveToolAnnotations", () => {
	it("leaves an undeclared, unannotated tool with NO annotations", () => {
		// This is what keeps UNDECLARED distinguishable on the wire: it must not
		// synthesize `{readOnlyHint:false}` and thereby declare something.
		expect(
			resolveToolAnnotations({ annotations: null, writeCapability: null }),
		).toBeUndefined();
	});

	it("projects the declaration onto the wire when hints are absent", () => {
		expect(
			resolveToolAnnotations({
				annotations: null,
				writeCapability: "destructive",
			}),
		).toEqual({ readOnlyHint: false, destructiveHint: true });
		expect(
			resolveToolAnnotations({ annotations: null, writeCapability: "read" }),
		).toEqual({ readOnlyHint: true, destructiveHint: false });
	});

	it("lets the provider's own hints win and only fills the gaps", () => {
		expect(
			resolveToolAnnotations({
				annotations: { readOnlyHint: true, title: "Get thing" },
				writeCapability: "write",
			}),
		).toEqual({
			title: "Get thing",
			readOnlyHint: true,
			destructiveHint: false,
		});
	});

	it("round-trips through writeCapabilityToAnnotations", () => {
		for (const capability of ["read", "write", "destructive"] as const) {
			expect(
				deriveToolWriteCapability(writeCapabilityToAnnotations(capability)),
			).toBe(capability);
		}
	});
});
