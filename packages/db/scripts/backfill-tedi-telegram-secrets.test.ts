import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
	decryptTediSecret,
	encryptTediSecret,
	generateMasterKey,
} from "../src/utils/secrets-encryption";
import { backfillTediTelegramSecrets } from "./backfill-tedi-telegram-secrets";

const databases: DatabaseSync[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});
function fixture() {
	const db = new DatabaseSync(":memory:");
	databases.push(db);
	db.exec(`CREATE TABLE tedis (id TEXT PRIMARY KEY, channels TEXT);
		CREATE TABLE tedi_secrets (id TEXT PRIMARY KEY, tedi_id TEXT, name TEXT, encrypted_value TEXT, hint TEXT, key_version INTEGER, created_at TEXT, updated_at TEXT, UNIQUE(tedi_id, name));`);
	const query = async (sql: string, params: SQLInputValue[]) => {
		const statement = db.prepare(sql);
		if (sql.trimStart().startsWith("SELECT"))
			return { results: statement.all(...params) };
		return {
			results: [],
			meta: { changes: Number(statement.run(...params).changes) },
		};
	};
	const add = (id: string, token: string) =>
		db
			.prepare("INSERT INTO tedis VALUES (?, ?)")
			.run(
				id,
				JSON.stringify({ telegram: { botToken: token }, untouched: true }),
			);
	return { db, query, add };
}

describe("Telegram secret migration", () => {
	it("dry runs without writes, encrypts by tedi, preserves channels and is repeatable", async () => {
		const { db, query, add } = fixture();
		const key = generateMasterKey();
		add("one", "first-token");
		add("two", "second-token");
		const before = db.prepare("SELECT * FROM tedis").all();
		expect(
			await backfillTediTelegramSecrets(query, key, { apply: false }),
		).toMatchObject({ candidates: 2, copied: 0 });
		expect(db.prepare("SELECT count(*) AS n FROM tedi_secrets").get()?.n).toBe(
			0,
		);
		expect(
			await backfillTediTelegramSecrets(query, key, { apply: true }),
		).toMatchObject({ copied: 2, skipped: 0 });
		const saved = db
			.prepare("SELECT * FROM tedi_secrets ORDER BY tedi_id")
			.all();
		expect(
			await decryptTediSecret(key, "one", String(saved[0]?.encrypted_value)),
		).toBe("first-token");
		expect(
			await decryptTediSecret(key, "two", String(saved[1]?.encrypted_value)),
		).toBe("second-token");
		expect(JSON.stringify(saved)).not.toContain("first-token");
		expect(db.prepare("SELECT * FROM tedis").all()).toEqual(before);
		expect(
			await backfillTediTelegramSecrets(query, key, { apply: true }),
		).toMatchObject({ existing: 2, copied: 0 });
		expect(
			db.prepare("SELECT * FROM tedi_secrets ORDER BY tedi_id").all(),
		).toEqual(saved);
	});

	it("preserves authoritative secrets, reports unreadable ciphertext, and ignores absent or malformed tokens", async () => {
		const { db, query, add } = fixture();
		const key = generateMasterKey();
		add("one", "old-token");
		add("two", "old-token");
		const encrypted = await encryptTediSecret(
			key,
			"one",
			"authoritative-token",
		);
		db.prepare(
			"INSERT INTO tedi_secrets (id, tedi_id, name, encrypted_value) VALUES ('s1', 'one', 'TELEGRAM_BOT_TOKEN', ?), ('s2', 'two', 'TELEGRAM_BOT_TOKEN', 'broken')",
		).run(encrypted);
		for (const [id, channels] of [
			["bad", "{"],
			["absent", "{}"],
			["numeric", '{"telegram":{"botToken":123}}'],
			["empty", '{"telegram":{"botToken":""}}'],
		]) {
			db.prepare("INSERT INTO tedis VALUES (?, ?)").run(id!, channels!);
		}
		expect(
			await backfillTediTelegramSecrets(query, key, { apply: true }),
		).toMatchObject({ candidates: 2, existing: 1, unreadable: 1, copied: 0 });
		expect(
			db.prepare("SELECT encrypted_value FROM tedi_secrets WHERE id='s1'").get()
				?.encrypted_value,
		).toBe(encrypted);
	});

	it("pages past 50 rows", async () => {
		const { query, add } = fixture();
		for (let i = 0; i < 51; i++) add(String(i).padStart(3, "0"), "token");
		expect(
			await backfillTediTelegramSecrets(query, generateMasterKey(), {
				apply: true,
			}),
		).toMatchObject({ candidates: 51, copied: 51 });
	});

	it.each(["token-edit", "secret-create"])(
		"skips a concurrent %s",
		async (change) => {
			const { db, query, add } = fixture();
			const key = generateMasterKey();
			add("one", "initial-token");
			const concurrent = await encryptTediSecret(
				key,
				"one",
				"concurrent-token",
			);
			const racedQuery: typeof query = async (sql, params) => {
				if (sql.trimStart().startsWith("INSERT")) {
					if (change === "token-edit")
						db.prepare("UPDATE tedis SET channels=?").run(
							'{"telegram":{"botToken":"changed"}}',
						);
					else
						db.prepare(
							"INSERT INTO tedi_secrets (id, tedi_id, name, encrypted_value) VALUES ('other', 'one', 'TELEGRAM_BOT_TOKEN', ?)",
						).run(concurrent);
				}
				return query(sql, params);
			};
			expect(
				await backfillTediTelegramSecrets(racedQuery, key, { apply: true }),
			).toMatchObject({ copied: 0, skipped: 1 });
			if (change === "secret-create")
				expect(
					db.prepare("SELECT encrypted_value FROM tedi_secrets").get()
						?.encrypted_value,
				).toBe(concurrent);
		},
	);
});
