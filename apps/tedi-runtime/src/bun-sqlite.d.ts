/**
 * Minimal ambient types for `bun:sqlite`, used only by the plain-`bun run`
 * source tests in `test:run`. The Worker TypeScript program does not load
 * Bun's runtime globals; declare only the SQLite surface those fixtures touch.
 */
declare module "bun:sqlite" {
	export class Database {
		constructor(filename: string);
		query(sql: string): { all(...params: unknown[]): unknown[] };
		run(sql: string, params?: unknown[]): void;
		transaction<T>(callback: () => T): () => T;
		close(): void;
	}
}
