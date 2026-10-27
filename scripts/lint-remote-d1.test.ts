import { describe, expect, test } from "bun:test";
import { findRemoteD1Findings } from "./lint-remote-d1.ts";

describe("findRemoteD1Findings", () => {
	test("flags a wrangler d1 execute --remote argv literal", () => {
		const findings = findRemoteD1Findings(
			"scripts/example.ts",
			`const child = spawnSync("bunx", [
	"wrangler",
	"d1",
	"execute",
	databaseName,
	"--remote",
	"--json",
	"--command",
	sql,
]);`,
		);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.kind).toBe("remote-d1 argv");
	});

	test("flags variable subcommands and --remote=true", () => {
		const findings = findRemoteD1Findings(
			"scripts/example.ts",
			`const argv = ["d1", subcommand, databaseName, "--remote=true"];`,
		);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.kind).toBe("remote-d1 argv");
	});

	test("flags a cf d1 query argv literal", () => {
		const findings = findRemoteD1Findings(
			"scripts/example.ts",
			`return [
	resolve("node_modules/.bin/cf"),
	"d1",
	"query",
	databaseId,
	"--sql",
];`,
		);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.kind).toBe("cf-d1-query argv");
	});

	test("flags a direct REST d1 query endpoint", () => {
		const findings = findRemoteD1Findings(
			"packages/x/src/a.ts",
			`await api.post(\`/d1/database/\${encodeURIComponent(id)}/query\`, { sql });`,
		);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.kind).toBe("rest-d1-query endpoint");
	});

	test("flags a split REST d1 query endpoint", () => {
		const findings = findRemoteD1Findings(
			"packages/x/src/a.ts",
			`await fetch("/d1/database/" + id + "/" + "query", { method: "POST" });`,
		);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.kind).toBe("rest-d1-query endpoint");
	});

	test("flags a wrangler d1 execute --remote command string", () => {
		const findings = findRemoteD1Findings(
			"tools/run.ts",
			`execSync("wrangler d1 execute DB --remote --command 'UPDATE t SET x = 1'");`,
		);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.kind).toBe("wrangler-d1-execute-remote command string");
	});

	test("ignores local d1 execute and non-query endpoints", () => {
		expect(
			findRemoteD1Findings(
				"scripts/example.ts",
				`spawn("wrangler", ["d1", "execute", "DB", "--local", "--command", sql]);
fetch("/d1/database/" + id + "/export");`,
			),
		).toHaveLength(0);
	});

	test("the audited helper file is exempt", () => {
		expect(
			findRemoteD1Findings(
				"scripts/lib/remote-d1.ts",
				`const argv = ["d1", "execute", db, "--remote", "--json", "--command", sql];`,
			),
		).toHaveLength(0);
	});

	test("an audited import does not exempt raw calls elsewhere in the file", () => {
		expect(
			findRemoteD1Findings(
				"packages/db/scripts/check.ts",
				`import { runWrangler } from "./wrangler-command";
const out = runWrangler(["d1", "execute", "DB", "--remote", "--command", sql, "--json"]);`,
			),
		).toHaveLength(1);
		expect(
			findRemoteD1Findings(
				"scripts/seed.ts",
				`import { remoteD1ExecuteArgv } from "./lib/remote-d1.ts";
const argv = ["d1", "execute", "DB", "--remote"];`,
			),
		).toHaveLength(1);
	});

	test("a remote-d1 annotation suppresses the finding with its reason", () => {
		expect(
			findRemoteD1Findings(
				"packages/db/scripts/drift.ts",
				`// remote-d1: reproduction hint text for operators, not an invocation
				\`command: wrangler d1 execute \${DB} --remote --config wrangler.jsonc\``,
			),
		).toHaveLength(0);
	});

	test("comments do not flag", () => {
		expect(
			findRemoteD1Findings(
				"scripts/x.ts",
				`// Reads run over wrangler d1 execute DB --remote
/* ["d1", "execute", "DB", "--remote"] */`,
			),
		).toHaveLength(0);
	});
});
