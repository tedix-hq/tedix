import { describe, expect, it } from "vite-plus/test";

import {
	assessClaimVsEvidence,
	detectSideEffectClaim,
	isPotentiallyMutatingCall,
} from "./claim-vs-evidence";

// A real overclaim shape: one discovery-only Code Mode call, then a claim of
// imminent setup and a completed run. The promised cron never existed.
const LIVE_OVERCLAIM_MESSAGE =
	"Confirmed. I have access to globex_tedix.get_invoices and cron scheduling. " +
	"I'll create a weekly Monday cron job that fetches invoices from the past 7 days " +
	"and delivers a formatted summary to your chat. Setting it up now.";

const LIVE_DISCOVERY_CALL = {
	name: "tedix_mcp_code",
	codeArgument:
		'async () => {\n  const results = await discover.search("globex");\n  return results;\n}',
};

describe("detectSideEffectClaim", () => {
	it("flags the live overclaim ('Setting it up now')", () => {
		const excerpt = detectSideEffectClaim(LIVE_OVERCLAIM_MESSAGE);
		expect(excerpt).toContain("Setting it up now");
	});

	it("flags first-person perfect claims", () => {
		expect(
			detectSideEffectClaim("I have created the weekly report cron."),
		).toContain("created");
		expect(
			detectSideEffectClaim("I sent the summary to your inbox."),
		).toContain("sent");
		expect(
			detectSideEffectClaim("Done — I've scheduled it for every Monday."),
		).toContain("scheduled");
	});

	it("flags stative and passive result claims", () => {
		expect(
			detectSideEffectClaim("The weekly summary is now set up."),
		).toContain("now set up");
		expect(
			detectSideEffectClaim(
				"The cron job has been created and will run Monday.",
			),
		).toContain("has been created");
	});

	it("does NOT flag plans, questions, or approval requests", () => {
		expect(
			detectSideEffectClaim(
				"I will create a weekly Monday cron job — confirm and I'll proceed.",
			),
		).toBeNull();
		expect(
			detectSideEffectClaim("Want me to set up the weekly summary for you?"),
		).toBeNull();
		expect(
			detectSideEffectClaim(
				"I'm planning to schedule it once you approve the draft.",
			),
		).toBeNull();
	});

	it("does NOT flag honest failure reports (negation guard)", () => {
		expect(
			detectSideEffectClaim(
				"I could not create the cron job — the scheduling tool returned an error.",
			),
		).toBeNull();
		expect(
			detectSideEffectClaim("I haven't scheduled anything yet."),
		).toBeNull();
		expect(
			detectSideEffectClaim(
				"The job failed to deploy because the workstation was cold.",
			),
		).toBeNull();
	});

	it("does NOT flag claim-free read results", () => {
		expect(
			detectSideEffectClaim(
				"I found 24 globex-related tools. The three most relevant are listed below.",
			),
		).toBeNull();
	});

	it("negation in a PRIOR sentence does not suppress a genuine claim", () => {
		expect(
			detectSideEffectClaim(
				"The first attempt did not work. I have created the cron job on retry.",
			),
		).toContain("created");
	});
});

describe("isPotentiallyMutatingCall", () => {
	it("classifies read-prefixed tools as non-mutating", () => {
		for (const name of [
			"list_skills",
			"get_invoices",
			"search_threads",
			"globex_tedix__get_invoices",
			"read_home_run",
			"discover_tools",
		]) {
			expect(isPotentiallyMutatingCall({ name })).toBe(false);
		}
	});

	it("classifies write-shaped and unknown tools as mutating", () => {
		for (const name of [
			"create_invoice",
			"cron",
			"send_email",
			"exec",
			"register_muscle_memory",
			"mystery_tool",
		]) {
			expect(isPotentiallyMutatingCall({ name })).toBe(true);
		}
	});

	it("classifies discovery-only Code Mode snippets as non-mutating", () => {
		expect(isPotentiallyMutatingCall(LIVE_DISCOVERY_CALL)).toBe(false);
	});

	it("classifies mutating Code Mode snippets as mutating", () => {
		expect(
			isPotentiallyMutatingCall({
				name: "tedix_mcp_code",
				codeArgument:
					'async () => await cto.cron({ action: "create", expr: "0 9 * * 1" })',
			}),
		).toBe(true);
	});

	it("classifies opaque/absent Code Mode snippets as mutating (conservative)", () => {
		expect(isPotentiallyMutatingCall({ name: "tedix_mcp_code" })).toBe(true);
		expect(
			isPotentiallyMutatingCall({ name: "tedix_mcp_code", codeArgument: "" }),
		).toBe(true);
	});
});

describe("assessClaimVsEvidence", () => {
	it("flags the live case: claim + discovery-only call → overclaim", () => {
		const verdict = assessClaimVsEvidence({
			finalAssistantMessage: LIVE_OVERCLAIM_MESSAGE,
			toolCalls: [LIVE_DISCOVERY_CALL],
		});
		expect(verdict.overclaim).toBe(true);
		expect(verdict.claimed).toBe(true);
		expect(verdict.mutatingEvidence).toBe(false);
		expect(verdict.claimExcerpt).toContain("Setting it up now");
		expect(verdict.toolNames).toEqual(["tedix_mcp_code"]);
	});

	it("does not flag a claim backed by a mutating call", () => {
		const verdict = assessClaimVsEvidence({
			finalAssistantMessage:
				"I have created the weekly cron job — it runs Mondays at 09:00.",
			toolCalls: [{ name: "cron" }],
		});
		expect(verdict.overclaim).toBe(false);
		expect(verdict.mutatingEvidence).toBe(true);
	});

	it("does not flag claim-free turns regardless of evidence", () => {
		const verdict = assessClaimVsEvidence({
			finalAssistantMessage:
				"I found 24 globex tools; here are the three most relevant.",
			toolCalls: [LIVE_DISCOVERY_CALL],
		});
		expect(verdict.overclaim).toBe(false);
		expect(verdict.claimed).toBe(false);
	});

	it("does not flag honest failure reports with zero calls", () => {
		const verdict = assessClaimVsEvidence({
			finalAssistantMessage:
				"I was unable to create the cron job: the scheduler tool is not available to me.",
			toolCalls: [],
		});
		expect(verdict.overclaim).toBe(false);
	});

	it("zero tool calls + a hard claim → overclaim", () => {
		const verdict = assessClaimVsEvidence({
			finalAssistantMessage: "All done — the report has been sent to the team.",
			toolCalls: [],
		});
		expect(verdict.overclaim).toBe(true);
	});
});
