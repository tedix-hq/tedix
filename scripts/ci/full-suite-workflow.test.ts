import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const workflow = readFileSync(
	new URL("../../.github/workflows/full-suite-hourly.yml", import.meta.url),
	"utf8",
);
const aggregate = workflow.split("\n  aggregate:\n")[1]!;
const command = aggregate.split("        run: |\n")[1]!;

test("every main push is certified and scheduled runs cannot supersede its lane", () => {
	const triggers = workflow.split("\npermissions:")[0]!;
	expect(triggers).toMatch(/push:\n\s+branches: \[main\]/);
	expect(triggers).not.toMatch(/paths(?:-ignore)?:/);
	expect(workflow).toContain(
		"group: main-certification-${{ github.event_name }}-${{ github.sha }}-${{ github.run_id }}",
	);
	expect(workflow).toContain("cancel-in-progress: false");
	expect(aggregate).toContain("if: ${{ always() }}");
});

test("aggregate accepts proven exact-SHA reuse but fails missing, cancelled, or failed shards", () => {
	const check = (overrides: Record<string, string>) =>
		spawnSync("bash", ["-e", "-c", command], {
			env: {
				...process.env,
				PLAN: "success",
				SKIP: "false",
				WORKSPACE: "success",
				REPOSITORY: "success",
				...overrides,
			},
		}).status;
	expect(check({})).toBe(0);
	expect(
		check({ SKIP: "true", WORKSPACE: "skipped", REPOSITORY: "skipped" }),
	).toBe(0);
	for (const status of ["failure", "cancelled", "skipped", ""]) {
		for (const job of ["PLAN", "WORKSPACE", "REPOSITORY"]) {
			expect(check({ [job]: status })).not.toBe(0);
		}
	}
	expect(check({ SKIP: "true", PLAN: "failure" })).not.toBe(0);
});
