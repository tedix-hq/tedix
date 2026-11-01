import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vite-plus/test";
import {
	TediSessionRepo,
	type SessionRepoSql,
} from "@tedix/tedi-session/session-repo";

const namespace = (env as unknown as { PI_TEST: DurableObjectNamespace })
	.PI_TEST;

function measure(sql: SqlStorage, query: string, values: SqlStorageValue[]) {
	const cursor = sql.exec(query, ...values);
	const rows = cursor.toArray();
	return { rows, rowsRead: cursor.rowsRead, rowsWritten: cursor.rowsWritten };
}

function fixture(sql: SqlStorage, limit = 40) {
	let projection:
		| (ReturnType<typeof measure> & {
				query: string;
				values: SqlStorageValue[];
		  })
		| undefined;
	const runner: SessionRepoSql = <T>(
		strings: TemplateStringsArray,
		...input: (string | number | boolean | null)[]
	) => {
		const query = strings.join("?");
		const values = input.map((value) =>
			typeof value === "boolean" ? Number(value) : value,
		);
		const measured = measure(sql, query, values);
		if (query.trimStart().startsWith("WITH latest_compactions AS"))
			projection = { ...measured, query, values };
		return measured.rows as T[];
	};
	const repo = new TediSessionRepo({
		sql: runner,
		readDurable: async () => ({ entries: [], compaction: null }),
		maxRecentTurns: limit,
	});
	repo.listTurns();
	return {
		repo,
		compare() {
			const turns = repo.listTurns();
			expect(projection).toBeDefined();
			const current = projection!;
			const baselineQuery = current.query.replace(
				"latest_compactions AS MATERIALIZED (",
				"latest_compactions AS (",
			);
			expect(baselineQuery).not.toBe(current.query);
			return {
				turns,
				current,
				baseline: measure(sql, baselineQuery, current.values),
			};
		},
	};
}

it("reuses the compaction projection across both branches with fewer DO rows read", async () => {
	const stub = namespace.get(namespace.idFromName(crypto.randomUUID()));
	const reads = await runInDurableObject(stub, async (_agent, state) => {
		const f = fixture(state.storage.sql);
		state.storage.transactionSync(() => {
			for (let session = 0; session < 30; session++) {
				for (let message = 0; message < 200; message++)
					state.storage.sql.exec(
						"INSERT INTO session_entries (id,session_key,type,role,content,ts) VALUES (?,?,'message','user',?,?)",
						`message-${session}-${message}`,
						`session-${session}`,
						`content-${session}-${message}`,
						session * 1_000 + message,
					);
				for (let compaction = 0; compaction < 6; compaction++)
					state.storage.sql.exec(
						"INSERT INTO session_entries (id,session_key,type,role,content,ts,first_kept_entry_id) VALUES (?,?,'compaction','assistant',?,?,?)",
						`compaction-${session}-${compaction}`,
						`session-${session}`,
						`summary-${session}-${compaction}`,
						session * 1_000 + 190 + compaction,
						`message-${session}-${50 + compaction * 20}`,
					);
			}
		});
		const { current, baseline, turns } = f.compare();
		expect(current.rows).toEqual(baseline.rows);
		expect(turns).toHaveLength(40);
		expect(turns[0]?.content).toBe("content-29-160");
		expect(turns.at(-1)?.content).toBe("content-29-199");
		expect(current.rowsWritten).toBe(0);
		expect(baseline.rowsWritten).toBe(0);
		expect(current.rowsRead).toBeLessThan(baseline.rowsRead);
		return {
			baseline: baseline.rowsRead,
			materialized: current.rowsRead,
		};
	});
	console.log("session projection DO rowsRead", reads);
});

it("preserves latest-marker ties, scoped boundaries, missing boundaries and global limits", async () => {
	const stub = namespace.get(namespace.idFromName(crypto.randomUUID()));
	await runInDurableObject(stub, async (_agent, state) => {
		const f = fixture(state.storage.sql);
		const insert = (
			id: string,
			session: string,
			type: string,
			ts: number,
			boundary: string | null = null,
		) =>
			state.storage.sql.exec(
				"INSERT INTO session_entries (id,session_key,type,role,content,ts,first_kept_entry_id) VALUES (?,?,?,'assistant',?,?,?)",
				id,
				session,
				type,
				id,
				ts,
				boundary,
			);
		insert("before", "compacted", "message", 10);
		insert("kept", "compacted", "message", 30);
		insert("after", "compacted", "message", 40);
		insert("marker-a", "compacted", "compaction", 100, "before");
		insert("marker-z", "compacted", "compaction", 100, "kept");
		for (const [session, ts, boundary] of [
			["foreign", 150, "kept"],
			["missing", 200, "absent"],
			["wrong-type", 300, "branch"],
			["null", 400, null],
		] as const) {
			insert(`${session}-before`, session, "message", ts - 1);
			insert(`${session}-after`, session, "message", ts + 1);
			insert(`${session}-summary`, session, "compaction", ts, boundary);
		}
		insert("branch", "wrong-type", "branch_summary", 1);
		insert("tie-a", "tie-session-a", "message", 500);
		insert("tie-b", "tie-session-b", "message", 500);
		insert("newest", "uncompacted", "message", 501);
		const { current, baseline, turns } = f.compare();
		const sorted = (rows: Record<string, SqlStorageValue>[]) =>
			[...rows].sort((a, b) =>
				String(a.content).localeCompare(String(b.content)),
			);
		expect(sorted(current.rows)).toEqual(sorted(baseline.rows));
		expect(turns.map((turn) => turn.content).sort()).toEqual(
			[
				"marker-z",
				"kept",
				"after",
				"foreign-summary",
				"foreign-after",
				"missing-summary",
				"missing-after",
				"wrong-type-summary",
				"wrong-type-after",
				"null-summary",
				"null-after",
				"tie-a",
				"tie-b",
				"newest",
			].sort(),
		);
		const bounded = fixture(state.storage.sql, 2).compare();
		// Equal timestamps have no specified cross-session tie-breaker.
		for (const rows of [bounded.current.rows, bounded.baseline.rows]) {
			expect(rows).toHaveLength(2);
			expect(rows[0]?.content).toBe("newest");
			expect(["tie-a", "tie-b"]).toContain(rows[1]?.content);
		}
	});
});
