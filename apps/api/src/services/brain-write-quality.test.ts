import { describe, expect, test } from "vite-plus/test";
import {
	buildBrainWriteQualityEnvelope,
	isAgentAuthenticatedBrainWrite,
	mergeBrainWriteMetadata,
	shouldEnforceFactAdmission,
} from "./brain-write-quality";

describe("brain write quality envelope", () => {
	test("caps weak automated writes and records gate failures", () => {
		const envelope = buildBrainWriteQualityEnvelope(
			{
				content: "tiny",
				domain: "ops",
				confidence: 0.95,
				priority: "core",
				source: "heartbeat",
				sourceHash: "abc123abc123abc123abc123abc12312",
				metadata: { producer: "heartbeat" },
			},
			"2026-05-23T10:00:00.000Z",
		);

		expect(envelope.sourceKind).toBe("heartbeat");
		expect(envelope.status).toBe("weak");
		expect(envelope.confidenceApplied).toBeLessThanOrEqual(0.55);
		expect(envelope.priorityApplied).toBe("background");
		expect(envelope.gates.hasSpecificContent).toBe(false);
	});

	test("keeps high-quality source-backed writes traceable", () => {
		const envelope = buildBrainWriteQualityEnvelope(
			{
				content:
					"Neo4j context graphs are read-optimized projections for traversal and explanation paths.",
				domain: "brain",
				confidence: 0.9,
				priority: "active",
				source: "doc://docs/cognition/brain.md",
				sourceUrl: "https://neo4j.com/docs/",
				sourceHash: "abc123abc123abc123abc123abc12312",
				metadata: {
					expectedUse: "Ground future brain architecture decisions",
					confidenceReason: "Documented and source-backed",
				},
			},
			"2026-05-23T10:00:00.000Z",
		);

		const metadata = mergeBrainWriteMetadata({}, envelope);
		expect(envelope.status).toBe("accepted");
		expect(envelope.confidenceApplied).toBe(0.9);
		expect(metadata.brainWrite).toMatchObject({
			sourceKind: "source-backed",
			qualityScore: 1,
		});
	});
});

describe("admission enforcement keying (caller class, not payload labels)", () => {
	test("an agent relabelling its write as doc:// is STILL enforced", () => {
		// sourceKind is derived from caller-controlled strings — a tedi that
		// labels an observation `doc://…` classifies as source-backed, which
		// pre-fix skipped the graph-linkage gate entirely.
		const envelope = buildBrainWriteQualityEnvelope({
			content: "A relabelled afterTurn observation dressed up as a doc.",
			domain: "ops",
			source: "doc://docs/anything.md",
			sourceHash: "abc123abc123abc123abc123abc12312",
		});
		expect(envelope.sourceKind).toBe("source-backed");
		expect(
			shouldEnforceFactAdmission(
				{ authType: "tedi", contextTediId: "tedi-1" },
				envelope.sourceKind,
			),
		).toBe(true);
	});

	test("agent-authenticated caller classes are enforced regardless of labels", () => {
		expect(isAgentAuthenticatedBrainWrite({ authType: "tedi" })).toBe(true);
		expect(isAgentAuthenticatedBrainWrite({ authType: "m2m" })).toBe(true);
		// Middleware-resolved tedi id counts even without an explicit authType.
		expect(isAgentAuthenticatedBrainWrite({ contextTediId: "tedi-1" })).toBe(
			true,
		);
		// Service binding is only agent-class when it forwards a tedi identity.
		expect(
			isAgentAuthenticatedBrainWrite({
				authType: "service-binding",
				forwardedTediId: "tedi-1",
			}),
		).toBe(true);
		expect(
			isAgentAuthenticatedBrainWrite({ authType: "service-binding" }),
		).toBe(false);
		for (const sourceKind of ["manual", "source-backed", "cron"] as const) {
			expect(shouldEnforceFactAdmission({ authType: "m2m" }, sourceKind)).toBe(
				true,
			);
		}
	});

	test("operator manual write is NOT enforced (labeled-producer behavior)", () => {
		expect(shouldEnforceFactAdmission({ authType: "user" }, "manual")).toBe(
			false,
		);
		expect(
			shouldEnforceFactAdmission({ authType: "apikey" }, "source-backed"),
		).toBe(false);
		expect(shouldEnforceFactAdmission({ authType: "user" }, "unknown")).toBe(
			false,
		);
	});

	test("afterTurn stays enforced for EVERY caller class", () => {
		for (const authType of [
			"user",
			"apikey",
			"service",
			"service-binding",
		] as const) {
			expect(shouldEnforceFactAdmission({ authType }, "afterTurn")).toBe(true);
		}
		expect(shouldEnforceFactAdmission({}, "afterTurn")).toBe(true);
	});
});
