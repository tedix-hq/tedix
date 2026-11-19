/**
 * TD10/TR8 application data migration. SQL cannot derive per-tedi AES-GCM keys.
 * Dry run by default; --apply inserts missing secrets without changing channels
 * or overwriting the authoritative secret. Run separately from schema releases.
 */
import { remoteD1QueryRest } from "../../../scripts/lib/remote-d1";
import {
	decryptTediSecret,
	encryptTediSecret,
} from "../src/utils/secrets-encryption";

type QueryResult = {
	results: Record<string, unknown>[];
	meta?: { changes?: number };
};
type Query = (
	sql: string,
	params: (string | number | null)[],
) => Promise<QueryResult>;

export async function backfillTediTelegramSecrets(
	query: Query,
	masterKey: string,
	options: { apply: boolean },
) {
	const report = {
		candidates: 0,
		existing: 0,
		unreadable: 0,
		copied: 0,
		skipped: 0,
	};
	let after = "";
	while (true) {
		const page = await query(
			`SELECT t.id AS tedi_id,
				json_extract(t.channels, '$.telegram.botToken') AS token,
				s.encrypted_value AS encrypted_value
			 FROM tedis t LEFT JOIN tedi_secrets s
				ON s.tedi_id = t.id AND s.name = 'TELEGRAM_BOT_TOKEN'
			 WHERE t.id > ? AND CASE WHEN json_valid(t.channels)
				THEN json_type(t.channels, '$.telegram.botToken') = 'text'
					AND length(json_extract(t.channels, '$.telegram.botToken')) > 0
				ELSE 0 END
			 ORDER BY t.id LIMIT 50`,
			[after],
		);
		if (!page.results.length) return report;
		for (const row of page.results) {
			if (typeof row.tedi_id !== "string" || typeof row.token !== "string") {
				throw new Error("Unexpected Telegram migration row");
			}
			after = row.tedi_id;
			report.candidates++;
			if (row.encrypted_value !== null) {
				try {
					if (
						typeof row.encrypted_value !== "string" ||
						!(await decryptTediSecret(
							masterKey,
							row.tedi_id,
							row.encrypted_value,
						))
					) {
						report.unreadable++;
					} else report.existing++;
				} catch {
					report.unreadable++;
				}
				continue;
			}
			if (!options.apply) continue;
			const encrypted = await encryptTediSecret(
				masterKey,
				row.tedi_id,
				row.token,
			);
			const at = new Date().toISOString();
			// Compare the source inside the INSERT: a concurrent token edit or
			// secret creation must survive this migration unchanged.
			const result = await query(
				`INSERT INTO tedi_secrets
					(id, tedi_id, name, encrypted_value, hint, key_version, created_at, updated_at)
				 SELECT ?, id, 'TELEGRAM_BOT_TOKEN', ?, NULL, 1, ?, ? FROM tedis
				 WHERE id = ? AND CASE WHEN json_valid(channels)
					THEN json_extract(channels, '$.telegram.botToken') = ? ELSE 0 END
				 ON CONFLICT(tedi_id, name) DO NOTHING`,
				[crypto.randomUUID(), encrypted, at, at, row.tedi_id, row.token],
			);
			if (result.meta?.changes === 1) report.copied++;
			else report.skipped++;
		}
	}
}

async function main() {
	const args = process.argv.slice(2);
	if (args.some((arg) => arg !== "--apply"))
		throw new Error("Only --apply is supported");
	const required = (name: string) => {
		const value = process.env[name];
		if (!value) throw new Error(`${name} is required`);
		return value;
	};
	const databaseId = required("CLOUDFLARE_D1_DATABASE_ID");
	if (
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
			databaseId,
		)
	) {
		throw new Error(
			"CLOUDFLARE_D1_DATABASE_ID must be an explicit database UUID",
		);
	}
	const accountId = required("CLOUDFLARE_ACCOUNT_ID");
	const apiToken = required("CLOUDFLARE_API_TOKEN");
	const masterKey = required("SECRETS_MASTER_KEY");
	const query: Query = async (sql, params) => {
		const response = await remoteD1QueryRest({
			accountId,
			databaseId,
			apiToken,
			sql,
			params,
			caller: "packages/db/scripts/backfill-tedi-telegram-secrets.ts",
		});
		const results = response.result as
			| (QueryResult & { success?: boolean })[]
			| undefined;
		if (
			!response.ok ||
			!Array.isArray(results) ||
			results.length !== 1 ||
			results[0]?.success !== true
		) {
			// Provider error text may contain a bound secret; report only status.
			throw new Error(
				`Telegram migration query failed (HTTP ${response.status})`,
			);
		}
		return results[0];
	};
	const apply = args.includes("--apply");
	const report = await backfillTediTelegramSecrets(query, masterKey, { apply });
	console.log(JSON.stringify({ apply, ...report }));
	if (report.unreadable || report.skipped) process.exitCode = 2;
}

if (import.meta.main) {
	main().catch(() => {
		console.error("Telegram migration failed; no secret values were logged");
		process.exitCode = 1;
	});
}
