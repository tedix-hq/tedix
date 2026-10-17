import { describe, expect, it, vi } from "vite-plus/test";
import type { LedgerCheck } from "./agent-session-request-ledger";
import type { DistillEnv } from "./lesson-distiller";
import { verifyLedgerEvidence } from "./request-ledger-verifier";

const check = (ref: string): LedgerCheck => ({
	ref,
	request: "Deploy the login fix",
	status: "done",
	evidence: "Deployed login fix as 4f2a9c1e",
});
const env = (run: ReturnType<typeof vi.fn>) =>
	({ AI: { run } }) as unknown as DistillEnv;

describe("ledger evidence verifier", () => {
	it("accepts supported yes/no scores and rejects unrelated, malformed and missing answers", async () => {
		const run = vi.fn(async () => ({
			answers: {
				r1: { type: "noul", noul: 0.99 },
				r2: { type: "noul", noul: 0.1 },
				r3: { type: "noul", noul: 2 },
				r4: { type: "choice", noul: 0.99 },
			},
		}));
		expect([
			...(await verifyLedgerEvidence(
				env(run),
				[1, 2, 3, 4, 5].map((n) => check(`r${n}`)),
				"The documentation is updated.",
			)),
		]).toEqual(["r1"]);
		expect(run.mock.calls[0]?.[0]).toBe("@cf/cloudflare/clef-flash");
	});
	it("leaves rows unchanged on a provider failure", async () => {
		expect([
			...(await verifyLedgerEvidence(
				env(
					vi.fn(async () => {
						throw Error("unavailable");
					}),
				),
				[check("r1")],
				"source",
			)),
		]).toEqual([]);
	});
	it("splits large question batches without truncating source evidence", async () => {
		const run = vi.fn(
			async (
				_model: string,
				body: {
					state: { evidence: string };
					questions: Record<string, unknown>;
				},
			) => {
				expect(body.state.evidence).toBe("source ".repeat(2000));
				expect(
					new TextEncoder().encode(JSON.stringify(body)).byteLength,
				).toBeLessThanOrEqual(30000);
				return {
					answers: Object.fromEntries(
						Object.keys(body.questions).map((ref) => [
							ref,
							{ type: "noul", noul: 0.9 },
						]),
					),
				};
			},
		);
		const checks = Array.from({ length: 65 }, (_, n) => check(`r${n}`));
		expect(
			(await verifyLedgerEvidence(env(run), checks, "source ".repeat(2000)))
				.size,
		).toBe(65);
		expect(run.mock.calls.length).toBeGreaterThan(1);
	});
});

describe("finding supported completions", () => {
	it("recovers an answered question with an exact source citation and leaves asks alone", async () => {
		const { findLedgerCompletions } = await import("./request-ledger-verifier");
		const quote =
			"The factory reads feedback and proposes rules; only the owner accepts them.";
		const run = vi
			.fn()
			.mockResolvedValueOnce({
				answers: {
					r1: { type: "noul", noul: 0.95 },
					r2: { type: "noul", noul: 0.03 },
				},
			})
			.mockResolvedValueOnce({
				answers: { r1: { type: "choice", choice: "e0" } },
			});
		const result = await findLedgerCompletions(
			env(run),
			[
				{
					ref: "r1",
					kind: "question",
					status: "open",
					text: "What happens to factory feedback?",
				},
				{
					ref: "r2",
					kind: "request",
					status: "open",
					text: "Deploy the payroll workflow",
				},
				{
					ref: "r3",
					kind: "ask",
					status: "waiting_on_user",
					text: "Approve publishing the legal page",
				},
			],
			quote,
		);
		expect(result).toEqual([{ ref: "r1", evidence: quote }]);
		expect(
			Object.keys(
				(run.mock.calls[0]?.[1] as { questions: Record<string, unknown> })
					.questions,
			),
		).toEqual(["r1", "r2"]);
	});
	it("does not accept an invented citation or an unavailable support result", async () => {
		const { findLedgerCompletions } = await import("./request-ledger-verifier");
		const rows = [
			{
				ref: "r1",
				kind: "question" as const,
				status: "open" as const,
				text: "Why did upload fail?",
			},
		];
		const run = vi
			.fn()
			.mockResolvedValueOnce({ answers: { r1: { type: "noul", noul: 0.9 } } })
			.mockResolvedValueOnce({
				answers: { r1: { type: "choice", choice: "invented" } },
			});
		expect(
			await findLedgerCompletions(
				env(run),
				rows,
				"The upload failed because its file exceeded the limit.",
			),
		).toEqual([]);
		expect(
			await findLedgerCompletions(
				env(
					vi.fn(async () => {
						throw Error("timeout");
					}),
				),
				rows,
				"The upload failed because its file exceeded the limit.",
			),
		).toEqual([]);
	});
});
