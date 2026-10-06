import type { DurableCodeWorkspace } from "./durable-codemode";
import { wrapUntrustedInput } from "./untrusted-input";

const INDEX_PATH = ".tedix/mcp-results/index.json";
const RESULT_DIR = ".tedix/mcp-results";
const RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_RESULTS = 20;
const MAX_TOTAL_CHARS = 2_000_000;
const MAX_RESULT_CHARS = 1_000_000;
const MAX_PAGE_CHARS = 50_000;

interface Entry {
	id: string;
	createdAt: number;
	chars: number;
}

function serialize(value: unknown): string {
	return JSON.stringify({ value });
}

export class McpToolResultStore {
	private pending: Promise<void> = Promise.resolve();
	private active = 0;
	get isIdle(): boolean {
		return this.active === 0;
	}
	constructor(
		private readonly workspace: DurableCodeWorkspace,
		private readonly now: () => number = Date.now,
	) {}

	private async index(): Promise<Entry[]> {
		const raw = await this.workspace.readFile(INDEX_PATH);
		if (!raw) return [];
		try {
			const parsed = JSON.parse(raw) as unknown;
			if (!Array.isArray(parsed)) throw new Error("Corrupt MCP result index");
			const ids = new Set<string>();
			const valid =
				parsed.length <= MAX_RESULTS &&
				parsed.every((row) => {
					const entry = row as Entry;
					const idValid =
						!!row &&
						typeof row === "object" &&
						/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
							entry.id,
						) &&
						!ids.has(entry.id);
					if (idValid) ids.add(entry.id);
					return (
						idValid &&
						Number.isFinite(entry.createdAt) &&
						entry.createdAt >= 0 &&
						Number.isFinite(entry.chars) &&
						entry.chars >= 0 &&
						entry.chars <= MAX_RESULT_CHARS
					);
				});
			if (!valid) throw new Error("Corrupt MCP result index");
			return parsed as Entry[];
		} catch {
			throw new Error("Corrupt MCP result index");
		}
	}

	private path(id: string): string {
		return `${RESULT_DIR}/${id}.json`;
	}

	async retain(
		result: unknown,
	): Promise<{ resultId: string; totalChars: number }> {
		const prior = this.pending;
		this.active++;
		let release!: () => void;
		this.pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		await prior;
		try {
			const content = serialize(result);
			if (content.length > MAX_RESULT_CHARS)
				throw new Error(
					`Result exceeds retention limit (${MAX_RESULT_CHARS} characters)`,
				);
			const now = this.now();
			let entries = await this.index();
			const expired = entries.filter(
				(entry) => now - entry.createdAt >= RETENTION_MS,
			);
			entries = entries.filter((entry) => now - entry.createdAt < RETENTION_MS);
			for (const entry of expired)
				await this.workspace.deleteFile(this.path(entry.id));
			while (
				entries.length >= MAX_RESULTS ||
				entries.reduce((sum, entry) => sum + entry.chars, 0) + content.length >
					MAX_TOTAL_CHARS
			) {
				const evicted = entries.shift();
				if (!evicted) break;
				await this.workspace.deleteFile(this.path(evicted.id));
			}
			const id = crypto.randomUUID();
			await this.workspace.writeFile(this.path(id), content);
			entries.push({ id, createdAt: now, chars: content.length });
			try {
				await this.workspace.writeFile(INDEX_PATH, JSON.stringify(entries));
			} catch (error) {
				await this.workspace.deleteFile(this.path(id)).catch(() => false);
				throw error;
			}
			return { resultId: id, totalChars: content.length };
		} finally {
			this.active--;
			release();
		}
	}

	async read(input: {
		resultId: string;
		offset?: number;
		limit?: number;
		query?: string;
	}): Promise<unknown> {
		if (
			!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
				input.resultId,
			)
		)
			throw new Error("Invalid resultId");
		const entry = (await this.index()).find(
			(item) => item.id === input.resultId,
		);
		if (!entry || this.now() - entry.createdAt >= RETENTION_MS)
			throw new Error("Retained result not found or expired");
		const content = await this.workspace.readFile(this.path(entry.id));
		if (!content) throw new Error("Retained result is unavailable");
		const query = input.query;
		let start = Math.max(0, Math.floor(input.offset ?? 0));
		if (start > 0 && /[\uDC00-\uDFFF]/.test(content[start] ?? "")) start--;
		if (query) {
			const found = content.indexOf(query, start);
			if (found < 0)
				return {
					resultId: entry.id,
					query,
					found: false,
					totalChars: content.length,
				};
			start = found;
		}
		const limit = Math.min(
			MAX_PAGE_CHARS,
			Math.max(1, Math.floor(input.limit ?? 12_000)),
		);
		let end = Math.min(content.length, start + limit);
		if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1] ?? ""))
			end++;
		return {
			resultId: entry.id,
			offset: start,
			nextOffset: end < content.length ? end : null,
			totalChars: content.length,
			...(query ? { query, found: true } : {}),
			content: wrapUntrustedInput(content.slice(start, end), "mcp_result"),
		};
	}
}
