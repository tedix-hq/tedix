import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workflow = readFileSync(
	new URL("../../.github/workflows/shard-rerun.yml", import.meta.url),
	"utf8",
);
const command = workflow
	.split("      - name: Run the shard\n")[1]!
	.split("        run: |\n")[1]!
	.split("      - name:")[0]!
	.replace(/^          /gm, "");

for (const status of [0, 17]) {
	test(`diagnostic shard runs once and preserves exit ${status}`, () => {
		const root = mkdtempSync(join(tmpdir(), "shard-state-"));
		try {
			const run = spawnSync(
				"bash",
				[
					"-e",
					"-c",
					`
    bun() {
      printf '%s\\n' "$*" >> "$BROWSER_DIAGNOSTICS_DIR/invocations"
      printf '%s\\n' "$DEBUG" "$TEDIX_BROWSER_EVIDENCE_DIR"
      return ${status}
    }
    node() { echo "Unexpected retry" >&2; return 99; }
    ${command}
   `,
				],
				{
					env: {
						...process.env,
						CAPTURE_BROWSER_STATE: "true",
						BROWSER_DIAGNOSTICS_DIR: root,
						WORKSPACE: "apps/os",
						TEST_SCRIPT: "test:browser:dialogs",
						TEST_SHARD: "1/3",
						BROWSERS: "webkit",
					},
					encoding: "utf8",
				},
			);
			expect(run.status, run.stderr).toBe(status);
			expect(readFileSync(join(root, "invocations"), "utf8")).toBe(
				"run --cwd apps/os test:browser:dialogs --shard 1/3\n",
			);
			expect(readFileSync(join(root, "protocol.log"), "utf8")).toBe(
				`pw:protocol,pw:browser\n${root}/traces\n`,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}
