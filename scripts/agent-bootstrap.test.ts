import { afterEach, expect, test } from "bun:test";
import {
	chmodSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0))
		rmSync(directory, { recursive: true });
});

function executable(path: string, contents: string) {
	writeFileSync(path, contents);
	chmodSync(path, 0o755);
}

test("bootstraps the released CLI and frozen repository dependencies", async () => {
	const directory = mkdtempSync(join(tmpdir(), "tedix-agent-bootstrap-"));
	temporaryDirectories.push(directory);
	const bin = join(directory, "bin");
	const home = join(directory, "home");
	const log = join(directory, "commands.log");
	mkdirSync(bin);
	mkdirSync(home);

	executable(
		join(bin, "curl"),
		`#!/bin/sh
cat <<'INSTALLER'
#!/bin/sh
mkdir -p "$TEDIX_INSTALL_DIR"
cat >"$TEDIX_INSTALL_DIR/tedix" <<'TEDIX'
#!/bin/sh
printf 'tedix:%s\\n' "$*" >>"$BOOTSTRAP_LOG"
case "$*" in
  "--version") echo "tedix 0.test" ;;
  *) echo "Tedix auth status fixture" ;;
esac
TEDIX
chmod +x "$TEDIX_INSTALL_DIR/tedix"
INSTALLER
`,
	);
	executable(
		join(bin, "bun"),
		`#!/bin/sh
printf 'bun:%s:%s\\n' "$PWD" "$*" >>"$BOOTSTRAP_LOG"
`,
	);

	const script = fileURLToPath(
		new URL("./agent-bootstrap.sh", import.meta.url),
	);
	const repositoryRoot = dirname(dirname(script));
	const process = Bun.spawn(["/bin/sh", script], {
		env: {
			HOME: home,
			PATH: `${bin}:/usr/bin:/bin`,
			BOOTSTRAP_LOG: log,
			TEDIX_WORKSPACE: "cloud-fixture",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		process.exited,
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
	]);

	expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
	expect(stdout).toContain("tedix 0.test");
	expect(stdout).toContain("Tedix auth status fixture");
	expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
		`bun:${repositoryRoot}:install --frozen-lockfile`,
		"tedix:--version",
		"tedix:-w cloud-fixture auth status",
	]);
});
