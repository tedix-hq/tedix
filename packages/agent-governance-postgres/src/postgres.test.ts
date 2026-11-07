import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createInMemoryAdapters } from "@tedix/agent-governance/in-memory";
import { evaluateCall } from "@tedix/agent-governance/compliance";
import {
	guardedCall,
	CallRefusedError,
} from "@tedix/agent-governance/wrap-binding";
import type {
	CallDescription,
	GovernanceAdapters,
} from "@tedix/agent-governance/types";
import { createPostgresAdapters } from "./adapters";
import { complianceDecisions } from "./schema";

const container = `tedix-governance-${crypto.randomUUID()}`;
let pool: Pool;
let db: ReturnType<typeof drizzle>;
const actor = { id: "agent-1", kind: "agent", organizationId: "org-test" };
const provenance = {
	actor,
	source: { surface: "test" },
	changeRecordId: "change-1",
};
const call: CallDescription = {
	actor,
	source: provenance.source,
	resource: "tool:test",
	operation: "read",
	args: { token: "secret" },
	riskTier: "read",
	blastRadius: "none",
};

beforeAll(async () => {
	execFileSync(
		"docker",
		[
			"run",
			"--detach",
			"--name",
			container,
			"--publish",
			"127.0.0.1::5432",
			"--env",
			"POSTGRES_PASSWORD=governance-test",
			"--health-cmd",
			"pg_isready -U postgres",
			"--health-interval",
			"1s",
			"--health-timeout",
			"3s",
			"--health-retries",
			"30",
			"postgres:17-alpine",
		],
		{ stdio: "pipe" },
	);
	// Docker health checks distinguish startup from a failed server.
	let status = "starting";
	while (status === "starting") {
		status = execFileSync(
			"docker",
			["inspect", "--format", "{{.State.Health.Status}}", container],
			{ encoding: "utf8" },
		).trim();
		if (status === "starting")
			await new Promise((resolve) => setTimeout(resolve, 200));
	}
	expect(status).toBe("healthy");
	const port = execFileSync(
		"docker",
		[
			"inspect",
			"--format",
			'{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}',
			container,
		],
		{ encoding: "utf8" },
	).trim();
	pool = new Pool({
		host: "127.0.0.1",
		port: Number(port),
		user: "postgres",
		password: "governance-test",
		database: "postgres",
		max: 12,
	});
	await pool.query(
		readFileSync(
			new URL("../migrations/0001_governance.sql", import.meta.url),
			"utf8",
		),
	);
	db = drizzle({ client: pool });
}, 60000);
afterAll(async () => {
	try {
		await pool?.end();
	} finally {
		execFileSync("docker", ["rm", "--force", container], { stdio: "pipe" });
	}
});

// Run identical contract exercises on the reference adapters and on a real server.
for (const implementation of ["memory", "postgres"] as const) {
	describe(`${implementation} governance conformance`, () => {
		const build = (): GovernanceAdapters =>
			implementation === "memory"
				? createInMemoryAdapters()
				: createPostgresAdapters(db, { scope: crypto.randomUUID() });
		it("writes provenance, reviews once, preserves approved values, and rolls back by append", async () => {
			const { memory } = build();
			expect(await memory.read("missing")).toBeNull();
			expect(await memory.history("missing")).toEqual([]);
			const r1 = await memory.write({
				key: "prefs/tone",
				value: { tone: "formal" },
				provenance,
			});
			const r2 = await memory.write({
				key: "prefs/tone",
				value: null,
				provenance,
			});
			expect(r1).toMatchObject({ revision: 1, review: "pending", provenance });
			expect((await memory.read(r1.key))?.approved).toBeUndefined();
			await memory.review(r1.revisionId, "approve", actor, "reviewed");
			await memory.review(r2.revisionId, "reject", actor);
			expect(await memory.read(r1.key)).toMatchObject({
				current: { revisionId: r2.revisionId, review: "rejected" },
				approved: {
					revisionId: r1.revisionId,
					reviewedBy: actor.id,
					reviewNote: "reviewed",
				},
			});
			await expect(
				memory.review(r1.revisionId, "reject", actor),
			).rejects.toThrow("already approved");
			await expect(memory.review("absent", "approve", actor)).rejects.toThrow(
				"Unknown memory revision",
			);
			const r3 = await memory.rollback(r1.key, r1.revisionId, provenance);
			expect(r3).toMatchObject({
				revision: 3,
				value: r1.value,
				hash: r1.hash,
				review: "approved",
				rolledBackFrom: r1.revisionId,
			});
			expect((await memory.history(r1.key)).map((r) => r.revision)).toEqual([
				1, 2, 3,
			]);
			await expect(
				memory.rollback("other", r1.revisionId, provenance),
			).rejects.toThrow("not a revision");
			expect((await memory.list("prefs/")).map((e) => e.key)).toEqual([r1.key]);
			await memory.write({ key: "literal%_\\", value: false, provenance });
			expect((await memory.list("literal%_\\")).map((e) => e.key)).toEqual([
				"literal%_\\",
			]);
		});
		it("records allowed, refused and uncertain calls in an immutable ordered ledger", async () => {
			const adapters = build();
			await guardedCall(call, async () => "ok", adapters);
			await expect(
				guardedCall(
					{ ...call, destructive: true },
					async () => {
						throw new Error("must not run");
					},
					adapters,
				),
			).rejects.toBeInstanceOf(CallRefusedError);
			await expect(
				guardedCall(
					call,
					async () => {
						throw new Error("upstream");
					},
					adapters,
				),
			).rejects.toThrow("upstream");
			const rows = await adapters.accountability.list();
			expect(rows.map((r) => r.outcome)).toEqual([
				"applied",
				"needs_approval",
				"unknown",
			]);
			expect(
				rows.every((r, i) => i === 0 || r.sequence > rows[i - 1]!.sequence),
			).toBe(true);
			expect(Object.isFrozen(rows[0])).toBe(true);
			expect(await adapters.accountability.get(rows[0]!.id)).toEqual(rows[0]);
			expect(await adapters.accountability.get("missing")).toBeNull();
			expect(
				await adapters.accountability.list({
					resource: call.resource,
					actorId: actor.id,
					afterSequence: rows[0]!.sequence,
					limit: 1,
				}),
			).toEqual([rows[1]]);
			expect(await adapters.accountability.list({ actorId: "other" })).toEqual(
				[],
			);
			expect(await adapters.accountability.list({ limit: 0 })).toEqual([]);
			expect((await adapters.accountability.export()).records).toEqual(rows);
		});
		it("enforces tier budgets and separates actors", async () => {
			const adapters = build();
			const write = { ...call, riskTier: "high_impact_write" as const };
			for (let i = 0; i < 5; i++)
				expect((await adapters.compliance.check(write)).verdict).toBe("allow");
			expect(await adapters.compliance.check(write)).toMatchObject({
				verdict: "deny",
				gate: "risk_rate_limit",
				rate: { limited: true },
			});
			expect(
				(
					await adapters.compliance.check({
						...write,
						actor: { ...actor, id: "other" },
					})
				).verdict,
			).toBe("allow");
		});
	});
}

describe("Postgres persistence and concurrency", () => {
	it("shares memory and limiter state across instances and isolates storage scopes", async () => {
		const scope = crypto.randomUUID();
		const first = createPostgresAdapters(db, { scope });
		const second = createPostgresAdapters(db, { scope });
		const other = createPostgresAdapters(db, { scope: crypto.randomUUID() });
		const writes = await Promise.all(
			Array.from({ length: 20 }, (_, value) =>
				(value % 2 ? first : second).memory.write({
					key: "shared",
					value,
					provenance,
				}),
			),
		);
		expect(writes.map((r) => r.revision).sort((a, b) => a - b)).toEqual(
			Array.from({ length: 20 }, (_, i) => i + 1),
		);
		expect(await second.memory.history("shared")).toHaveLength(20);
		expect(await other.memory.read("shared")).toBeNull();
		const pending = writes[0]!;
		const reviewed = await Promise.allSettled([
			first.memory.review(pending.revisionId, "approve", actor),
			second.memory.review(pending.revisionId, "reject", actor),
		]);
		expect(reviewed.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		await expect(
			other.memory.review(pending.revisionId, "approve", actor),
		).rejects.toThrow("Unknown");
		const decisions = await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				(i % 2 ? first : second).compliance.check({
					...call,
					riskTier: "high_impact_write",
				}),
			),
		);
		expect(decisions.filter((d) => d.verdict === "allow")).toHaveLength(5);
		expect(
			(await other.compliance.check({ ...call, riskTier: "high_impact_write" }))
				.verdict,
		).toBe("allow");
	});
	it("expires budget windows across instances", async () => {
		let time = 0;
		const scope = crypto.randomUUID();
		const options = { scope, now: () => new Date(time) };
		const a = createPostgresAdapters(db, options);
		const b = createPostgresAdapters(db, options);
		const write = { ...call, riskTier: "high_impact_write" as const };
		for (let i = 0; i < 5; i++) await a.compliance.check(write);
		expect((await b.compliance.check(write)).verdict).toBe("deny");
		time = 60000;
		expect((await b.compliance.check(write)).verdict).toBe("allow");
	});
	it("allocates contiguous per-scope ledger positions under concurrent appends", async () => {
		const scope = crypto.randomUUID();
		const a = createPostgresAdapters(db, { scope });
		const b = createPostgresAdapters(db, { scope });
		const decision = await a.compliance.check(call);
		const input = {
			actor,
			source: provenance.source,
			resource: call.resource,
			operation: call.operation,
			argsHash: "hash",
			decision,
			outcome: "applied" as const,
		};
		await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				(i % 2 ? a : b).accountability.append(input),
			),
		);
		expect((await b.accountability.list()).map((r) => r.sequence)).toEqual(
			Array.from({ length: 20 }, (_, i) => i + 1),
		);
		const other = createPostgresAdapters(db, { scope: crypto.randomUUID() });
		expect((await other.accountability.append(input)).sequence).toBe(1);
	});
	it("uses shared policy evaluation and persists outcomes without raw arguments", async () => {
		const scope = crypto.randomUUID();
		const facts = {
			riskTier: "read" as const,
			scopeDenied: true,
			approval: "not_required" as const,
		};
		const adapters = createPostgresAdapters(db, {
			scope,
			facts: async () => facts,
		});
		const decision = await adapters.compliance.check(call);
		expect(decision).toEqual(evaluateCall(facts));
		await adapters.compliance.record(call, decision, {
			status: "not_applied",
			error: "scope_denied",
		});
		const [row] = await db
			.select()
			.from(complianceDecisions)
			.where(eq(complianceDecisions.scope, scope));
		expect(row?.decision).toEqual(decision);
		expect(row?.outcome.status).toBe("not_applied");
		expect(row?.call).not.toHaveProperty("args");
		expect(row?.call.argsHash).toMatch(/^[0-9a-f]{64}$/);
		const other = createPostgresAdapters(db, { scope: crypto.randomUUID() });
		const record = await adapters.accountability.append({
			actor,
			source: provenance.source,
			resource: call.resource,
			operation: call.operation,
			argsHash: row!.call.argsHash,
			decision,
			outcome: "denied",
		});
		expect(await other.accountability.get(record.id)).toBeNull();
	});
});
