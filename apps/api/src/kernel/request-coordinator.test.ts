import { describe, expect, it } from "vite-plus/test";
import type { KernelAcceptanceCheck } from "@tedix/api-contract/schemas/kernel-request";
import {
	advanceKernelRequest,
	receivedKernelRequest,
	runKernelAcceptanceChecks,
	type KernelAcceptanceReader,
} from "./request-coordinator";
const now = () => "2026-10-17T10:00:00.000Z";
const check: KernelAcceptanceCheck = {
	kind: "os_output_revision",
	outputId: "output-one",
	revisionId: "revision-one",
};
const reader: KernelAcceptanceReader = {
	readOutputRevision: async () => ({
		revisionId: "revision-one",
		evidenceRef: "os:output-one:revision-one",
	}),
	readRepositoryDelivery: async () => {
		throw new Error("unavailable");
	},
};
function running() {
	let s = receivedKernelRequest();
	s = advanceKernelRequest("request-one", s, {
		kind: "file",
		workItemId: "work-one",
	});
	s = advanceKernelRequest("request-one", s, {
		kind: "brief",
		revision: 1,
		checks: [check],
	});
	return advanceKernelRequest("request-one", s, {
		kind: "start",
		attemptId: "attempt-one",
	});
}
function terminal() {
	return advanceKernelRequest("request-one", running(), {
		kind: "terminal",
		attemptId: "attempt-one",
		outcome: "succeeded",
	});
}

describe("kernel request coordinator", () => {
	it("requires trusted target checks and acknowledged delivery before reported and no-new-lesson closure", async () => {
		let s = terminal();
		expect(s.state).toBe("verifying");
		expect(s.outcome).toBe("unknown");
		expect(
			advanceKernelRequest("request-one", s, {
				kind: "delivery_intent",
				intentId: "report-one",
			}),
		).toBe(s);
		s = advanceKernelRequest("request-one", s, {
			kind: "checked",
			acceptanceKey: s.acceptanceKey!,
			observations: await runKernelAcceptanceChecks(s.checks, reader, now),
		});
		expect(s.outcome).toBe("verified");
		s = advanceKernelRequest("request-one", s, {
			kind: "delivery_intent",
			intentId: "report-one",
		});
		expect(s.state).toBe("verifying");
		s = advanceKernelRequest("request-one", s, {
			kind: "delivered",
			intentId: "report-one",
			status: "acknowledged",
			receiptRef: "home:message-one",
		});
		expect(s.state).toBe("reported");
		s = advanceKernelRequest("request-one", s, {
			kind: "learn",
			disposition: "no_new_lesson",
		});
		expect(s.state).toBe("learned");
		expect(s.learning).toBe("no_new_lesson");
	});
	it("deduplicates terminal events and fences old acceptance, cancellation and delivery after a successor", () => {
		const old = terminal();
		expect(
			advanceKernelRequest("request-one", old, {
				kind: "terminal",
				attemptId: "attempt-one",
				outcome: "succeeded",
			}),
		).toBe(old);
		let successor = advanceKernelRequest("request-one", old, {
			kind: "brief",
			revision: 2,
			checks: [check],
		});
		successor = advanceKernelRequest("request-one", successor, {
			kind: "start",
			attemptId: "attempt-two",
		});
		for (const event of [
			{
				kind: "terminal" as const,
				attemptId: "attempt-one",
				outcome: "succeeded" as const,
			},
			{ kind: "cancel" as const, attemptId: "attempt-one" },
			{
				kind: "checked" as const,
				acceptanceKey: old.acceptanceKey!,
				observations: [],
			},
			{
				kind: "delivered" as const,
				intentId: "old",
				status: "acknowledged" as const,
				receiptRef: "old",
			},
		])
			expect(advanceKernelRequest("request-one", successor, event)).toBe(
				successor,
			);
	});
	it("does not accept missing, duplicate or unavailable probes", async () => {
		const s = terminal();
		const observations = await runKernelAcceptanceChecks(s.checks, reader, now);
		for (const probes of [
			[],
			[observations[0]!, observations[0]!],
			[{ ...observations[0]!, status: "unknown" as const }],
		])
			expect(
				advanceKernelRequest("request-one", s, {
					kind: "checked",
					acceptanceKey: s.acceptanceKey!,
					observations: probes,
				}).outcome,
			).toBe("unknown");
	});
	it("reads exact OS revision and rejects wrong revisions", async () => {
		const observations = await runKernelAcceptanceChecks(
			[check],
			{
				...reader,
				readOutputRevision: async () => ({
					revisionId: "revision-other",
					evidenceRef: "os:output-one:revision-other",
				}),
			},
			now,
		);
		expect(observations[0]?.status).toBe("fail");
	});
	it("requires the exact SHA on main, successful Ship and named live surface", async () => {
		const sha = "a".repeat(40);
		const repo: KernelAcceptanceCheck = {
			kind: "repository_delivery",
			targetId: "repo-example",
			commitSha: sha,
			surface: "app",
		};
		const observation = {
			mainSha: sha,
			shipSha: sha,
			shipStatus: "success",
			liveSha: sha,
			surface: "app",
			evidenceRefs: ["ship:one", "live:one"],
		};
		for (const patch of [
			{},
			{ mainSha: "b".repeat(40) },
			{ shipSha: "b".repeat(40) },
			{ shipStatus: "failed" },
			{ liveSha: "b".repeat(40) },
			{ surface: "other" },
		]) {
			const result = await runKernelAcceptanceChecks(
				[repo],
				{
					...reader,
					readRepositoryDelivery: async () => ({ ...observation, ...patch }),
				},
				now,
			);
			expect(result[0]?.status).toBe(
				Object.keys(patch).length ? "fail" : "pass",
			);
		}
		expect(
			(await runKernelAcceptanceChecks([repo], reader, now))[0]?.status,
		).toBe("unknown");
	});
	it("does not upgrade failed execution to verified even if targets pass", async () => {
		const s = advanceKernelRequest("request-one", running(), {
			kind: "terminal",
			attemptId: "attempt-one",
			outcome: "failed",
		});
		expect(
			advanceKernelRequest("request-one", s, {
				kind: "checked",
				acceptanceKey: s.acceptanceKey!,
				observations: await runKernelAcceptanceChecks(s.checks, reader, now),
			}).outcome,
		).toBe("failed");
	});
});
