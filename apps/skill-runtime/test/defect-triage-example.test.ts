import { describe, expect, it } from "bun:test";
import defectTriage from "../examples/defect-triage/scripts/workflow";

function harness(
	verdict: string,
	commands: Array<{
		terminal: boolean;
		exitCode?: number;
		executionId?: string;
		running?: boolean;
	}>,
) {
	const steps: string[] = [];
	const executed: string[] = [];
	const reasonKeys: string[] = [];
	let reads = 0;
	const env = {
		MCP: {
			tedi: {
				open_computer: async () => ({ ready: true }),
				exec: async ({ command }: { command: string }) => {
					executed.push(command);
					return commands.shift();
				},
				read_execution: async () => {
					reads++;
					return commands.shift();
				},
				cancel_execution: async () => ({ terminal: true, canceled: true }),
			},
		},
		REASON: {
			ask: async ({ key }: { key: string }) => {
				reasonKeys.push(key);
				return {
					text:
						key === "verify"
							? `${verdict}\nBecause the observed behavior differs.`
							: "A bounded assessment.",
				};
			},
		},
	};
	const step = {
		do: async (
			name: string,
			_config: unknown,
			action: () => Promise<unknown>,
		) => {
			steps.push(name);
			return action();
		},
		sleep: async (name: string) => {
			steps.push(name);
		},
	};
	const payload = {
		target: "scratch fixture",
		entityKey: "fixture-1",
		revision: "r1",
		expectedBehavior: "the check passes",
		reproduceCommand: "check",
		fixCommand: "fix",
	};
	return {
		env,
		step,
		payload,
		steps,
		executed,
		reasonKeys,
		get reads() {
			return reads;
		},
	};
}

describe("defect-triage example", () => {
	for (const label of ["intended_behavior", "unclear", "unexpected label"]) {
		it(`stops before Fix when Verify says ${label}`, async () => {
			const h = harness(label, [{ terminal: true, exitCode: 1 }]);
			const result = await defectTriage.run(
				{ payload: h.payload },
				h.step,
				h.env,
			);
			expect(result.verdict).toBe(
				label === "intended_behavior" ? label : "unclear",
			);
			expect(result.stopReason).toBe("verification_early_exit");
			expect(h.executed).toEqual(["check"]);
			expect(h.reasonKeys).toEqual(["diagnose", "verify"]);
			expect(h.steps.some((name) => name.startsWith("fix"))).toBe(false);
		});
	}

	it("runs Fix only for a bug and requires a passing recheck", async () => {
		const h = harness("bug", [
			{ terminal: true, exitCode: 1 },
			{ terminal: true, exitCode: 0 },
			{ terminal: true, exitCode: 0 },
		]);
		const result = await defectTriage.run(
			{ payload: h.payload },
			h.step,
			h.env,
		);
		expect(result.verdict).toBe("bug");
		expect(result.stopReason).toBe("fixed");
		expect(h.executed).toEqual(["check", "fix", "check"]);
		expect(h.reasonKeys).toEqual(["diagnose", "verify", "fix-plan"]);
	});

	it("observes the same detached execution instead of replaying it", async () => {
		const h = harness("unclear", [
			{ terminal: false, running: true, executionId: "job-1" },
			{ terminal: true, executionId: "job-1", exitCode: 1 },
		]);
		const result = await defectTriage.run(
			{ payload: h.payload },
			h.step,
			h.env,
		);
		expect(result.verdict).toBe("unclear");
		expect(h.executed).toEqual(["check"]);
		expect(h.reads).toBe(1);
		expect(h.steps).toContain("reproduce-read-0");
	});

	it("stops before reasoning or Fix when Computer has no known exit code", async () => {
		const h = harness("bug", [{ terminal: true }]);
		const result = await defectTriage.run({ payload: h.payload }, h.step, {
			...h.env,
			__RUN_CONTEXT__: { runId: "run-1" },
		});
		expect(result.runId).toBe("run-1");
		expect(result.verdict).toBe("unclear");
		expect(result.stopReason).toBe("reproduction_timeout");
		expect(h.executed).toEqual(["check"]);
		expect(h.reasonKeys).toEqual([]);
	});
});
