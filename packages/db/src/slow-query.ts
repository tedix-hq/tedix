import { createLogger } from "@tedix/worker-kit/logger";

const logger = createLogger<{
	sqlShape: string;
	caller: string;
	durationMs: number;
	durationSource: string;
	operation: string;
	rowsRead: number;
	sampleRate: number;
}>({ component: "db.slow_query" });

// Keep quoted identifiers, but remove literals and comments even in raw SQL.
const SQL_TOKENS =
	/"(?:""|[^"])*"|`(?:``|[^`])*`|\[(?:[^\]])*\]|(?:x)?'(?:''|[^'])*'|--[^\r\n]*|\/\*[\s\S]*?\*\/|\b(?:0x[\da-f]+|\d+(?:\.\d*)?(?:e[+-]?\d+)?)\b/gi;
const observed = new WeakMap<object, object>();
const statements = new WeakMap<
	D1PreparedStatement,
	{ native: D1PreparedStatement; sql: string }
>();

function caller(): string {
	return (new Error().stack ?? "")
		.split("\n")
		.slice(1)
		.filter(
			(line) =>
				!/\/slow-query\.(?:ts|js):|node_modules\/.*drizzle-orm/.test(line),
		)
		.slice(0, 6)
		.join("\n");
}

function report(
	sql: string,
	origin: string,
	operation: string,
	durationMs: number,
	durationSource: string,
	result?: D1Result,
): void {
	if (durationMs <= 1_000) return;
	logger.warn("D1 operation exceeded 1 s", {
		event: "db.query.slow",
		sqlShape: sql.replace(SQL_TOKENS, (token) =>
			/^["`\[]/.test(token) ? token : "?",
		),
		caller: origin,
		durationMs,
		durationSource,
		operation,
		rowsRead: result?.meta?.rows_read,
		sampleRate: 1,
	});
}

/** Observe native execution without changing SQL, bindings, results or errors. */
export function observeD1<T extends Pick<D1Database, "prepare" | "batch">>(
	database: T,
): T {
	const existing = observed.get(database);
	if (existing) return existing as T;
	const wrap = (
		native: D1PreparedStatement,
		sql: string,
	): D1PreparedStatement => {
		const proxy = new Proxy(native, {
			get(target, key) {
				if (key === "bind")
					return (...values: unknown[]) => wrap(target.bind(...values), sql);
				const value = Reflect.get(target, key);
				if (["all", "run", "raw", "first"].includes(String(key)))
					return async (...args: unknown[]) => {
						const origin = caller();
						const start = performance.now();
						let result: D1Result | undefined;
						try {
							const valueResult = await Reflect.apply(value, target, args);
							if (key === "all" || key === "run")
								result = valueResult as D1Result;
							return valueResult;
						} finally {
							report(
								sql,
								origin,
								String(key),
								performance.now() - start,
								"wall",
								result,
							);
						}
					};
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		statements.set(proxy, { native, sql });
		return proxy;
	};
	const proxy = new Proxy(database, {
		get(target, key) {
			if (key === "prepare")
				return (sql: string) => wrap(target.prepare(sql), sql);
			if (key === "withSession")
				return (...args: unknown[]) =>
					observeD1(
						Reflect.apply(
							Reflect.get(target, key) as D1Database["withSession"],
							target,
							args,
						),
					);
			if (key === "batch")
				return async (batch: D1PreparedStatement[]) => {
					const origin = caller();
					const start = performance.now();
					let results: D1Result[] | undefined;
					try {
						results = await target.batch(
							batch.map((s) => statements.get(s)?.native ?? s),
						);
						return results;
					} finally {
						const elapsed = performance.now() - start;
						batch.forEach((statement, index) => {
							const result = results?.[index];
							// A batch's wall time cannot be attributed to one statement.
							const duration = result?.meta?.duration;
							report(
								statements.get(statement)?.sql ?? "<unobserved statement>",
								origin,
								"batch",
								duration ?? elapsed,
								duration === undefined ? "batch_wall" : "d1",
								result,
							);
						});
					}
				};
			const value = Reflect.get(target, key);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	observed.set(database, proxy);
	observed.set(proxy, proxy);
	return proxy;
}
