import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	auditedRemoteD1ExecuteArgv,
	auditRemoteD1Argv,
	d1AuditLogPath,
	isRemoteD1Argv,
	recordRemoteD1Audit,
	remoteD1QueryRest,
	resolveD1Actor,
} from "./remote-d1.ts";

describe("resolveD1Actor", () => {
	test("prefers the explicit override", () => {
		expect(
			resolveD1Actor({
				TEDIX_D1_ACTOR: "operator",
				TEDIX_AGENT_SESSION: "devin:x",
			} as NodeJS.ProcessEnv),
		).toBe("operator");
	});

	test("names the Tedix agent session and its principal", () => {
		expect(
			resolveD1Actor({
				TEDIX_AGENT_SESSION: "devin:bitter-astronaut",
				TEDIX_EXTERNAL_AGENT: "devin-local-host",
			} as NodeJS.ProcessEnv),
		).toBe("devin:bitter-astronaut@devin-local-host");
	});

	test("falls through GitHub then local user, and never returns empty", () => {
		expect(
			resolveD1Actor({
				GITHUB_ACTOR: "ops-bot",
				GITHUB_RUN_ID: "42",
			} as NodeJS.ProcessEnv),
		).toBe("github:ops-bot#42");
		expect(resolveD1Actor({ USER: "aaron" } as NodeJS.ProcessEnv)).toBe(
			"aaron",
		);
		expect(resolveD1Actor({} as NodeJS.ProcessEnv)).toBe("unknown");
	});
});

describe("recordRemoteD1Audit", () => {
	test("appends one JSON line with the actor and a SQL fingerprint, never the SQL", () => {
		const dir = mkdtempSync(join(tmpdir(), "remote-d1-audit-"));
		const log = join(dir, "audit.jsonl");
		try {
			const env = {
				TEDIX_D1_AUDIT_LOG: log,
				TEDIX_AGENT_SESSION: "devin:bitter-astronaut",
			} as NodeJS.ProcessEnv;
			const sql = "UPDATE app_tools SET input_schema='{}' WHERE id='abc'";
			const record = recordRemoteD1Audit(
				{
					transport: "wrangler-d1-execute",
					database: "DB",
					sql,
					caller: "scripts/test.ts",
				},
				env,
			);
			expect(record.actor).toBe("devin:bitter-astronaut");
			expect(record.sqlSha256).toBe(
				createHash("sha256").update(sql, "utf8").digest("hex"),
			);
			const written = readFileSync(log, "utf8");
			expect(written).not.toContain("input_schema='{}'");
			const lines = written.trim().split("\n");
			expect(lines).toHaveLength(1);
			expect(JSON.parse(lines[0]!)).toMatchObject({
				actor: "devin:bitter-astronaut",
				transport: "wrangler-d1-execute",
				database: "DB",
				caller: "scripts/test.ts",
			});
			recordRemoteD1Audit(
				{ transport: "rest-d1-query", database: "db-uuid", sql: "SELECT 1" },
				env,
			);
			expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("d1AuditLogPath honors the override and the .cache default", () => {
		expect(
			d1AuditLogPath({
				TEDIX_D1_AUDIT_LOG: "/tmp/x.jsonl",
			} as NodeJS.ProcessEnv),
		).toBe("/tmp/x.jsonl");
		expect(d1AuditLogPath({} as NodeJS.ProcessEnv)).toEndWith(
			".cache/remote-d1-audit.jsonl",
		);
	});
});

describe("remote-d1 argv builders", () => {
	test("auditedRemoteD1ExecuteArgv records before returning the command", () => {
		const dir = mkdtempSync(join(tmpdir(), "remote-d1-command-"));
		try {
			expect(
				auditedRemoteD1ExecuteArgv({
					database: "DB",
					config: "apps/api/wrangler.jsonc",
					sql: "SELECT 1",
					env: {
						TEDIX_D1_AUDIT_LOG: join(dir, "audit.jsonl"),
					} as NodeJS.ProcessEnv,
				}),
			).toEqual([
				"d1",
				"execute",
				"DB",
				"--remote",
				"--config",
				"apps/api/wrangler.jsonc",
				"--json",
				"--command",
				"SELECT 1",
			]);
			expect(readFileSync(join(dir, "audit.jsonl"), "utf8")).toContain(
				'"transport":"wrangler-d1-execute"',
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("isRemoteD1Argv splits remote d1 from local and non-d1 calls", () => {
		expect(isRemoteD1Argv(["d1", "execute", "DB", "--remote"])).toBe(true);
		expect(isRemoteD1Argv(["d1", "execute", "DB", "--remote=true"])).toBe(true);
		expect(isRemoteD1Argv(["d1", "execute", "DB", "--local"])).toBe(false);
		expect(isRemoteD1Argv(["deploy"])).toBe(false);
	});
});

describe("auditRemoteD1Argv", () => {
	test("fingerprints --command SQL and keeps non-SQL tails verbatim", () => {
		const dir = mkdtempSync(join(tmpdir(), "remote-d1-argv-"));
		const env = { TEDIX_D1_AUDIT_LOG: join(dir, "a.jsonl") };
		try {
			auditRemoteD1Argv(
				["d1", "execute", "DB", "--remote", "--command", "SELECT 1"],
				{ env: env as NodeJS.ProcessEnv, caller: "t" },
			);
			const first = JSON.parse(
				readFileSync(env.TEDIX_D1_AUDIT_LOG, "utf8").trim(),
			);
			expect(first.transport).toBe("wrangler-d1-execute");
			expect(first.sqlSha256).toBe(
				createHash("sha256").update("SELECT 1", "utf8").digest("hex"),
			);
			expect(first.argv).toBeUndefined();

			auditRemoteD1Argv(["d1", "migrations", "apply", "DB", "--remote"], {
				env: env as NodeJS.ProcessEnv,
				caller: "t",
			});
			const second = JSON.parse(
				readFileSync(env.TEDIX_D1_AUDIT_LOG, "utf8").trim().split("\n")[1]!,
			);
			expect(second.argv).toBe("migrations apply DB --remote");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("remoteD1QueryRest", () => {
	test("posts to the D1 query endpoint, audits, and maps the envelope", async () => {
		const dir = mkdtempSync(join(tmpdir(), "remote-d1-rest-"));
		const env = {
			TEDIX_D1_AUDIT_LOG: join(dir, "a.jsonl"),
			USER: "tester",
		} as NodeJS.ProcessEnv;
		try {
			const calls: { url: string; body: string }[] = [];
			const result = await remoteD1QueryRest({
				accountId: "acct",
				databaseId: "db-1",
				sql: "CREATE TABLE t (id INTEGER)",
				apiToken: "token",
				env,
				fetchImplementation: async (input, init) => {
					calls.push({
						url: String(input),
						body: String(init?.body),
					});
					return new Response(JSON.stringify({ success: true, result: [] }));
				},
			});
			expect(result.ok).toBe(true);
			expect(calls[0]?.url).toBe(
				"https://api.cloudflare.com/client/v4/accounts/acct/d1/database/db-1/query",
			);
			const audit = JSON.parse(readFileSync(env.TEDIX_D1_AUDIT_LOG!, "utf8"));
			expect(audit).toMatchObject({
				actor: "tester",
				transport: "rest-d1-query",
				database: "db-1",
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("reports envelope errors without throwing", async () => {
		const dir = mkdtempSync(join(tmpdir(), "remote-d1-rest-err-"));
		const env = { TEDIX_D1_AUDIT_LOG: join(dir, "a.jsonl") };
		try {
			const result = await remoteD1QueryRest({
				accountId: "acct",
				databaseId: "db-1",
				sql: "SELECT 1",
				apiToken: "token",
				env: env as NodeJS.ProcessEnv,
				fetchImplementation: async () =>
					new Response(
						JSON.stringify({
							success: false,
							errors: [{ code: 7400, message: "denied" }],
						}),
						{ status: 403 },
					),
			});
			expect(result).toMatchObject({
				ok: false,
				status: 403,
				detail: "7400: denied",
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
