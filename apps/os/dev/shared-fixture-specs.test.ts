// @vitest-environment node
import { describe, expect, it } from "vite-plus/test";
import { runSharedFixtureSpecs } from "../browser-tests/shared-fixture-specs";

function fixture() {
	const exit = Promise.withResolvers<number>();
	let code: number | null = null;
	return {
		server: { exited: exit.promise, exitCode: () => code },
		exit(value: number) {
			code = value;
			exit.resolve(value);
		},
	};
}

describe("shared browser fixture failures", () => {
	it("reports exit before the running spec finishes and names every unstarted spec", async () => {
		const { server, exit } = fixture();
		const child = Promise.withResolvers<number>();
		const launched: string[] = [];
		const errors: string[] = [];
		const running = runSharedFixtureSpecs(
			["first.ts", "second.ts", "third.ts"],
			server,
			(spec) => {
				launched.push(spec);
				return { exited: child.promise, signalCode: "SIGTERM" };
			},
			() => {},
			(message) => errors.push(message),
		);
		exit(7);
		await server.exited;
		expect(launched).toEqual(["first.ts"]);
		expect(errors).toEqual([
			"[run-specs] fixture server exited with code 7",
			"[run-specs] NOT RUN (fixture server exited 7)  second.ts",
			"[run-specs] NOT RUN (fixture server exited 7)  third.ts",
		]);
		child.resolve(143);
		const results = await running;
		expect(results[0]?.outcome).toMatch(
			/^FAIL \(fixture server exited 7; spec signal SIGTERM; exit 143\)/,
		);
		expect(results.slice(1).map(({ outcome }) => outcome)).toEqual([
			"NOT RUN (fixture server exited 7)",
			"NOT RUN (fixture server exited 7)",
		]);
	});

	it("does not start any specs when the fixture already exited, even with code zero", async () => {
		const { server, exit } = fixture();
		exit(0);
		const launched: string[] = [];
		const errors: string[] = [];
		const results = await runSharedFixtureSpecs(
			["first.ts"],
			server,
			(spec) => {
				launched.push(spec);
				return { exited: Promise.resolve(0) };
			},
			() => {},
			(message) => errors.push(message),
		);
		expect(launched).toEqual([]);
		expect(results).toEqual([
			{ spec: "first.ts", outcome: "NOT RUN (fixture server exited 0)" },
		]);
		expect(errors).toHaveLength(2);
	});

	it("runs remaining specs after an ordinary spec failure and ignores fixture shutdown afterwards", async () => {
		const { server, exit } = fixture();
		const launched: string[] = [];
		const errors: string[] = [];
		const results = await runSharedFixtureSpecs(
			["first.ts", "second.ts"],
			server,
			(spec) => {
				launched.push(spec);
				return { exited: Promise.resolve(spec === "first.ts" ? 1 : 0) };
			},
			() => {},
			(message) => errors.push(message),
		);
		expect(launched).toEqual(["first.ts", "second.ts"]);
		expect(results[0]?.outcome).toMatch(/^FAIL \(exit 1\)/);
		expect(results[1]?.outcome).toMatch(/^PASS /);
		exit(0);
		await server.exited;
		expect(errors).toEqual([]);
	});
});
