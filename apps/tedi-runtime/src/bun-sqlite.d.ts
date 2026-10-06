/**
 * Minimal ambient types for `bun:sqlite`, used only by the plain-`bun run`
 * test scripts (this app's tests do not run under vitest/workerd — see
 * `test:run`). The monorepo deliberately does not depend on `bun-types`;
 * declare only the shared surface those fixtures touch.
 */
declare module "bun:sqlite" {
	export class Database {
		constructor(filename: string);
		query(sql: string): { all(...params: unknown[]): unknown[] };
		run(sql: string, params?: unknown[]): void;
	}
}
