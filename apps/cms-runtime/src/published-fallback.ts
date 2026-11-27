import { durableObjectStubByName } from "@tedix/worker-kit/durable-objects";
import {
	resolveSurfaceTenant,
	platformDomainForEnvironment,
} from "@tedix/tenant-directory";
import { isMarketingHost } from "./marketing";
import { pageCacheEligible } from "./tenant-page-cache";
import { HOT_THEME_PUBLIC_PATH } from "./public-proxy";
import type { Env } from "./env";

export const PUBLISHED_FALLBACK_ADMIN_PATH =
	"/_tedix/internal/published-fallback";
const MAX_PAGE_BYTES = 1024 * 1024;
const RETENTION_MS = 24 * 60 * 60_000;

export interface PublishedPage {
	body: ArrayBuffer;
	headers: [string, string][];
}

export type PublishedFallbackCommand =
	| { action: "ticket" }
	| { action: "read"; key: string }
	| { action: "save"; key: string; generation: string; page: PublishedPage }
	| { action: "block" | "unblock"; token: string; generation?: string };

export interface PublishedFallbackResult {
	generation: string | null;
	page?: PublishedPage;
}

export function publishedFallback(env: Pick<Env, "DB_DO">, slug: string) {
	return durableObjectStubByName(
		env.DB_DO,
		env,
		`published-fallback:${slug}`,
	) as unknown as {
		publishedFallback(
			slug: string,
			command: PublishedFallbackCommand,
		): Promise<PublishedFallbackResult>;
	};
}

/** This object is separate from the tenant PITR target. Its invalidation must
 * survive a restore of the tenant database, including an undo. All commands
 * are synchronous so invalidation cannot interleave with admission or a save. */
export function executePublishedFallback(
	sql: SqlStorage,
	command: PublishedFallbackCommand,
): PublishedFallbackResult {
	sql.exec(
		"CREATE TABLE IF NOT EXISTS _published_fallback_state (id INTEGER PRIMARY KEY, generation TEXT NOT NULL, blocks TEXT NOT NULL)",
	);
	sql.exec(
		"CREATE TABLE IF NOT EXISTS _published_fallback_pages (key TEXT PRIMARY KEY, body BLOB NOT NULL, headers TEXT NOT NULL, saved_at INTEGER NOT NULL)",
	);
	sql.exec(
		"INSERT OR IGNORE INTO _published_fallback_state VALUES (1, ?, '[]')",
		crypto.randomUUID(),
	);
	const state = sql
		.exec<{ generation: string; blocks: string }>(
			"SELECT generation, blocks FROM _published_fallback_state WHERE id = 1",
		)
		.one();
	const blocks = new Set<string>(JSON.parse(state.blocks));
	if (command.action === "block" || command.action === "unblock") {
		if (command.action === "block") {
			blocks.add(command.token);
			state.generation = crypto.randomUUID();
			sql.exec("DELETE FROM _published_fallback_pages");
		} else if (!command.generation || command.generation === state.generation)
			blocks.delete(command.token);
		sql.exec(
			"UPDATE _published_fallback_state SET generation = ?, blocks = ? WHERE id = 1",
			state.generation,
			JSON.stringify([...blocks]),
		);
	}
	if (command.action === "ticket") return { generation: state.generation };
	const generation = blocks.size ? null : state.generation;
	if (!generation) return { generation };
	if (
		command.action === "save" &&
		command.generation === generation &&
		command.page.body.byteLength <= MAX_PAGE_BYTES
	) {
		sql.exec(
			"INSERT OR REPLACE INTO _published_fallback_pages VALUES (?, ?, ?, ?)",
			command.key,
			command.page.body,
			JSON.stringify(command.page.headers),
			Date.now(),
		);
		sql.exec(
			"DELETE FROM _published_fallback_pages WHERE key IN (SELECT key FROM _published_fallback_pages ORDER BY saved_at DESC, key LIMIT -1 OFFSET 128)",
		);
	}
	if (command.action === "read") {
		const page = sql
			.exec<{ body: ArrayBuffer; headers: string }>(
				"SELECT body, headers FROM _published_fallback_pages WHERE key = ? AND saved_at > ?",
				command.key,
				Date.now() - RETENTION_MS,
			)
			.toArray()[0];
		if (page)
			return {
				generation,
				page: { body: page.body, headers: JSON.parse(page.headers) },
			};
	}
	return { generation };
}

/** Custom host mappings remain fresh-only: an outage must not revive a
 * removed domain or the previous owner after a transfer. */
export function publishedFallbackSlug(
	request: Request,
	env: Env,
): string | null {
	const url = new URL(request.url);
	if (
		!env.DB_DO ||
		!pageCacheEligible(
			request.method === "HEAD"
				? new Request(request, { method: "GET" })
				: request,
			url.pathname.startsWith("/_astro/") ||
				url.pathname === HOT_THEME_PUBLIC_PATH
				? "/"
				: url.pathname,
		)
	)
		return null;
	if (env.MARKETING_SITE_SLUG && isMarketingHost(url.hostname, env))
		return env.MARKETING_SITE_SLUG;
	const route = resolveSurfaceTenant(url.hostname, {
		platformDomain: platformDomainForEnvironment(env.ENVIRONMENT),
		expectedSurface: "cms",
	});
	return route.kind === "tenant" ? route.slug : null;
}

export async function savePublishedPage(
	response: Response,
	save: (page: PublishedPage) => Promise<unknown>,
): Promise<void> {
	const policy = response.headers.get("cache-control") ?? "";
	if (
		response.status !== 200 ||
		response.headers.has("set-cookie") ||
		!/\bpublic\b/i.test(policy) ||
		/private|no-store|no-cache/i.test(policy)
	)
		return;
	if (
		(response.headers.get("vary") ?? "")
			.split(",")
			.some(
				(field) =>
					![
						"",
						"host",
						"accept",
						"accept-language",
						"accept-encoding",
					].includes(field.trim().toLowerCase()),
			)
	)
		return;
	if (Number(response.headers.get("content-length")) > MAX_PAGE_BYTES) return;
	const reader = response.clone().body?.getReader();
	if (!reader) return;
	const chunks: Uint8Array[] = [];
	let length = 0;
	for (;;) {
		const next = await reader.read();
		if (next.done) break;
		length += next.value.byteLength;
		if (length > MAX_PAGE_BYTES) {
			await reader.cancel();
			return;
		}
		chunks.push(next.value);
	}
	const body = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	await save({ body: body.buffer, headers: [...response.headers] });
}
