import { describe, expect, it } from "vite-plus/test";
import {
	classifyDelegatedStop,
	declaredDelegationOutcome,
	delegatedStopFromSummary,
	delegationVerifyCommand,
	hasDelegatedOutput,
	hasVerificationOutput,
	parseEarlyStopMarker,
	stripSyntheticMarkers,
	VERIFICATION_OUTPUT_HEADING,
	verificationRequirementLines,
} from "./delegated-stop";

// A real stopped-turn shape: 17 steps, zero assistant text, and only
// the runtime's early-stop notice as the "final message".
const INCIDENT_MARKER =
	"[Turn stopped early: per-turn cumulative input-token ceiling reached (750642/750000 input tokens over 17 steps). Partial results above; remaining work was not attempted.]";
const STEP_MARKER =
	"[Turn stopped early: per-turn provider-call ceiling reached (10/10 steps). Partial results above; remaining work was not attempted.]";
const BUDGET_MARKER =
	"[Turn stopped early: daily inference token budget exhausted mid-turn (503077/500000 tokens for 2026-07-26, operator class). Partial results above; remaining work was not attempted.]";

describe("parseEarlyStopMarker", () => {
	it("parses the reason, the step count and the reason id from the runtime notice", () => {
		expect(parseEarlyStopMarker(INCIDENT_MARKER)).toEqual({
			stopReason: "context_ceiling",
			reason: "per-turn cumulative input-token ceiling reached",
			steps: 17,
		});
		expect(parseEarlyStopMarker(STEP_MARKER)).toEqual({
			stopReason: "step_ceiling",
			reason: "per-turn provider-call ceiling reached",
			steps: 10,
		});
		expect(parseEarlyStopMarker(BUDGET_MARKER)).toEqual({
			stopReason: "budget_exhausted",
			reason: "daily inference token budget exhausted mid-turn",
			steps: null,
		});
	});

	it("returns null for prose that merely mentions a limit", () => {
		expect(
			parseEarlyStopMarker("The provider limit is documented; work is done."),
		).toBeNull();
		expect(parseEarlyStopMarker(null)).toBeNull();
	});
});

describe("stripSyntheticMarkers / hasDelegatedOutput", () => {
	it("strips every runtime and kernel marker and keeps what the tedi wrote", () => {
		expect(
			stripSyntheticMarkers(
				`[partial-result]\nstopReason=context_ceiling; continuation and fresh verification are required.\n\nFound 3 failing tests.\n[assistant result truncated]\n${INCIDENT_MARKER}`,
			),
		).toBe("Found 3 failing tests.");
		expect(hasDelegatedOutput(INCIDENT_MARKER)).toBe(false);
		expect(hasDelegatedOutput("   ")).toBe(false);
		expect(hasDelegatedOutput("empty_assistant_message")).toBe(false);
		expect(hasDelegatedOutput(`Done.\n${STEP_MARKER}`)).toBe(true);
	});
});

describe("classifyDelegatedStop", () => {
	it("marker-only (older runtime): failed, with the stop reason and step count", () => {
		expect(
			classifyDelegatedStop({
				assistantText: INCIDENT_MARKER,
				structuredStopReason: "context_ceiling",
			}),
		).toEqual({
			outcome: "failed",
			stopReason: "context_ceiling",
			detail:
				"Stopped after 17 steps: per-turn cumulative input-token ceiling reached",
			steps: 17,
			output: "",
		});
	});

	it("marker-only without a structured reason still infers the reason from the marker", () => {
		expect(
			classifyDelegatedStop({
				assistantText: STEP_MARKER,
				structuredStopReason: null,
			}),
		).toMatchObject({
			outcome: "failed",
			stopReason: "step_ceiling",
			detail: "Stopped after 10 steps: per-turn provider-call ceiling reached",
		});
	});

	it("text + marker (newer runtime forced report): partial, with the text as output", () => {
		expect(
			classifyDelegatedStop({
				assistantText: `Inspected the failing build; the root cause is a missing migration.\n\n${INCIDENT_MARKER}`,
				structuredStopReason: "context_ceiling",
			}),
		).toEqual({
			outcome: "partial",
			stopReason: "context_ceiling",
			detail:
				"Stopped after 17 steps: per-turn cumulative input-token ceiling reached",
			steps: 17,
			output:
				"Inspected the failing build; the root cause is a missing migration.",
		});
	});

	it("a structured stop with a text report and no marker is partial", () => {
		expect(
			classifyDelegatedStop({
				assistantText: "Partial findings: two of five checks passed.",
				structuredStopReason: "step_ceiling",
			}),
		).toMatchObject({
			outcome: "partial",
			stopReason: "step_ceiling",
			detail: "Stopped early: per-turn provider-call ceiling reached",
		});
	});

	it("'Partial result:' prefixed text is a reported partial", () => {
		expect(
			classifyDelegatedStop({
				assistantText: "Partial result: live verification timed out.",
				structuredStopReason: null,
			}),
		).toMatchObject({
			outcome: "partial",
			stopReason: "reported_partial",
			output: "Partial result: live verification timed out.",
		});
	});

	it("a structured stop with nothing written at all is failed", () => {
		expect(
			classifyDelegatedStop({
				assistantText: null,
				structuredStopReason: "budget_exhausted",
			}),
		).toMatchObject({
			outcome: "failed",
			stopReason: "budget_exhausted",
			detail: "Stopped early: inference token budget exhausted mid-turn",
		});
	});

	it("returns null when nothing indicates a stop or a partial", () => {
		expect(
			classifyDelegatedStop({
				assistantText:
					"The provider limit is documented; the work is complete.",
				structuredStopReason: null,
			}),
		).toBeNull();
		expect(
			classifyDelegatedStop({
				assistantText: "Done.",
				structuredStopReason: "stop",
			}),
		).toBeNull();
	});
});

describe("delegatedStopFromSummary", () => {
	it("downgrades a persisted marker-only partial to failed on read", () => {
		expect(
			delegatedStopFromSummary({
				childRunStatus: "partial",
				childRunStopReason: "step_ceiling",
				childRunPreview: STEP_MARKER,
			}),
		).toMatchObject({
			outcome: "failed",
			stopReason: "step_ceiling",
			detail: "Stopped after 10 steps: per-turn provider-call ceiling reached",
		});
	});

	it("keeps a persisted partial whose preview carries real output", () => {
		expect(
			delegatedStopFromSummary({
				childRunStatus: "partial",
				childRunStopReason: "step_ceiling",
				childRunStopDetail: "Stopped after 10 steps: provider-call ceiling",
				childRunPreview: "Two of five checks passed.",
			}),
		).toMatchObject({
			outcome: "partial",
			detail: "Stopped after 10 steps: provider-call ceiling",
		});
	});

	it("is null for an ordinary completion", () => {
		expect(
			delegatedStopFromSummary({
				childRunStatus: "completed",
				childRunPreview: "Done.",
			}),
		).toBeNull();
	});
});

describe("classifyDelegatedStop — verify command", () => {
	const VERIFY = `tedix -w tedix work approval-list --input '{"limit":5}'`;

	it("downgrades a success report with no Verification output section to partial", () => {
		expect(
			classifyDelegatedStop({
				assistantText:
					"Outcome: succeeded\nFixed the approval inbox join; repo_commit 0123456789abcdef0123456789abcdef01234567.",
				structuredStopReason: null,
				verifyCommand: VERIFY,
			}),
		).toMatchObject({
			outcome: "partial",
			stopReason: "verification_missing",
			detail: `verification output missing (required: ${VERIFY})`,
		});
	});

	it("lets a success report stand when it quotes the verification output", () => {
		expect(
			classifyDelegatedStop({
				assistantText: `Outcome: succeeded\nRe-ran the reproduction.\n\n**Verification output:**\n\`\`\`\n{ "items": [ 5 rows ] }\n\`\`\``,
				structuredStopReason: null,
				verifyCommand: VERIFY,
			}),
		).toBeNull();
	});

	it("is inert without a verify command", () => {
		expect(
			classifyDelegatedStop({
				assistantText: "Outcome: succeeded",
				structuredStopReason: null,
				verifyCommand: null,
			}),
		).toBeNull();
	});

	it("keeps a runtime stop's own classification ahead of the verification rule", () => {
		expect(
			classifyDelegatedStop({
				assistantText: `Two of five checks passed.\n${STEP_MARKER}`,
				structuredStopReason: "step_ceiling",
				verifyCommand: VERIFY,
			}),
		).toMatchObject({ outcome: "partial", stopReason: "step_ceiling" });
	});

	it("a success report with nothing written at all is failed, not partial", () => {
		expect(
			classifyDelegatedStop({
				assistantText: "",
				structuredStopReason: null,
				verifyCommand: VERIFY,
			}),
		).toMatchObject({ outcome: "failed", stopReason: "verification_missing" });
	});

	it("survives a persisted summary round trip", () => {
		expect(
			delegatedStopFromSummary({
				childRunStatus: "partial",
				childRunStopReason: "verification_missing",
				childRunStopDetail: `verification output missing (required: ${VERIFY})`,
				childRunPreview: "Outcome: succeeded — fixed it.",
			}),
		).toMatchObject({
			outcome: "partial",
			stopReason: "verification_missing",
			detail: `verification output missing (required: ${VERIFY})`,
		});
	});
});

describe("verification helpers", () => {
	it("detects the heading at a line start through markdown emphasis only", () => {
		expect(hasVerificationOutput("**Verification output:**\nok")).toBe(true);
		expect(hasVerificationOutput("## Verification output:\nok")).toBe(true);
		// A child asked to report in numbered steps writes an ordered-list
		// heading; delegated run 32a80751 was misread as unverified for it.
		expect(hasVerificationOutput("4. Verification output:\nok")).toBe(true);
		expect(hasVerificationOutput("1) **Verification output:**\nok")).toBe(true);
		expect(
			hasVerificationOutput("I skipped the verification output: none."),
		).toBe(false);
		expect(hasVerificationOutput(null)).toBe(false);
	});

	it("reads the verify command off a run's delegationWorkOrder metadata only", () => {
		expect(
			delegationVerifyCommand({
				delegationWorkOrder: { verifyCommand: "  bun run test:run  " },
			}),
		).toBe("bun run test:run");
		expect(delegationVerifyCommand({ verifyCommand: "bun run test:run" })).toBe(
			null,
		);
		expect(delegationVerifyCommand(null)).toBe(null);
		expect(
			delegationVerifyCommand({ delegationWorkOrder: { verifyCommand: 42 } }),
		).toBe(null);
	});

	it("renders the same requirement the classifier expects", () => {
		const lines = verificationRequirementLines("bun run test:run");
		expect(lines[0]).toBe("Verification:");
		expect(lines.join("\n")).toContain("bun run test:run");
		expect(lines.join("\n")).toContain(VERIFICATION_OUTPUT_HEADING);
		expect(lines.join("\n")).toContain("Partial result:");
	});
});

describe("declaredDelegationOutcome", () => {
	it.each(["succeeded", "failed", "needs_follow_up"] as const)(
		"decodes the exact leading %s declaration",
		(outcome) => {
			expect(declaredDelegationOutcome(`Outcome: ${outcome}\n\nDetails.`)).toBe(
				outcome,
			);
		},
	);
	it.each([
		null,
		"",
		"Done.",
		"Outcome: unknown",
		"Outcome: succeeded with caveats",
		"The log says Outcome: failed",
		"```\nOutcome: succeeded\n```",
		"Report\nOutcome: failed",
	])("does not infer an outcome from %s", (text) => {
		expect(declaredDelegationOutcome(text)).toBeNull();
	});
});

describe("existing explicit refusal classification", () => {
	it.each([
		"Outcome: blocked",
		"🔴 Blocked fail-closed: admission was refused.",
		"403 FORBIDDEN: execution denied.",
	])("preserves %s as a task failure with its output", (text) => {
		expect(
			classifyDelegatedStop({
				assistantText: text,
				structuredStopReason: null,
			}),
		).toMatchObject({
			outcome: "failed",
			stopReason: "reported_refusal",
			output: text,
		});
	});
	it("does not classify a refusal quoted later in an ordinary answer", () => {
		expect(
			classifyDelegatedStop({
				assistantText:
					"The request is complete.\nBlocked requests require authorization.",
				structuredStopReason: null,
			}),
		).toBeNull();
	});
});

it.each([
	"403 Forbidden means the authenticated caller lacks permission. Request the correct role.",
	"Blocked tasks remain visible on the work board until their dependency is resolved.",
])(
	"keeps ordinary answer-only explanations out of refusal classification: %s",
	(text) => {
		expect(
			classifyDelegatedStop({
				assistantText: text,
				structuredStopReason: null,
			}),
		).toBeNull();
	},
);
