import { expect, test } from "bun:test";
import { specOutcome } from "../../apps/os/browser-tests/spec-outcome";

test("a successful spec with a running fixture passes", () => {
	expect(specOutcome(0, null)).toBe("PASS");
});

test("a spec failure with a running fixture keeps its exit code", () => {
	expect(specOutcome(1, null)).toBe("FAIL (exit 1)");
	expect(specOutcome(2, null)).toBe("FAIL (exit 2)");
});

test("a fixture exit is retained even when the spec also fails", () => {
	expect(specOutcome(1, 137)).toBe(
		"FAIL (fixture server exited 137; spec exit 1)",
	);
});

test("a clean fixture exit still invalidates a failed or successful spec", () => {
	expect(specOutcome(1, 0)).toBe("FAIL (fixture server exited 0; spec exit 1)");
	expect(specOutcome(0, 0)).toBe("FAIL (fixture server exited 0; spec exit 0)");
});

test("specs not started after a fixture exit keep its exit code", () => {
	expect(specOutcome(null, 137)).toBe("NOT RUN (fixture server exited 137)");
	expect(specOutcome(null, 0)).toBe("NOT RUN (fixture server exited 0)");
});

test("signal termination is distinguishable from an ordinary spec exit", () => {
	expect(specOutcome(143, null, "SIGTERM")).toBe(
		"FAIL (signal SIGTERM; exit 143)",
	);
	expect(specOutcome(143, null, 15)).toBe("FAIL (signal 15; exit 143)");
	expect(specOutcome(143, 137, "SIGTERM")).toBe(
		"FAIL (fixture server exited 137; spec signal SIGTERM; exit 143)",
	);
});
