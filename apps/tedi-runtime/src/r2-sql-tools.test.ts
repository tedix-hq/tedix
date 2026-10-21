import assert from "node:assert/strict";
import { createR2SqlTools } from "./r2-sql-tools";

const options: { toolCallId: string; messages: never[] } = {
	toolCallId: "r2-sql-test",
	messages: [],
};
const config = {
	accountId: "account",
	table: "default.analytics",
	token: "token",
	warehouse: "warehouse",
};

type R2SqlResult = {
	ok: boolean;
	configured?: boolean;
	error?: string;
	query?: string;
	rows?: unknown[];
	status?: number;
	table?: string;
};

const toolFor = (getOrgId: () => string | undefined = () => "org-example") =>
	createR2SqlTools({ getConfig: () => config, getOrgId })
		.r2_sql_query as unknown as {
		execute(
			input: Record<string, unknown>,
			toolOptions: typeof options,
		): Promise<R2SqlResult>;
	};

const responseFor = (body: unknown, status = 200) =>
	new Response(body === "invalid-json" ? "not json" : JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});

const expectedRows = (body: unknown) => {
	if (Array.isArray(body)) return body;
	if (typeof body !== "object" || body === null) return undefined;
	const envelope = body as {
		rows?: unknown;
		result?: unknown;
	};
	if (Array.isArray(envelope.rows)) return envelope.rows;
	if (Array.isArray(envelope.result)) return envelope.result;
	if (typeof envelope.result === "object" && envelope.result !== null) {
		const result = envelope.result as { rows?: unknown };
		if (Array.isArray(result.rows)) return result.rows;
	}
	return undefined;
};

const originalFetch = globalThis.fetch;
try {
	const calls: Array<{ query: string }> = [];
	globalThis.fetch = async (_input, init) => {
		calls.push({ query: JSON.parse(String(init?.body)).query });
		return responseFor({ rows: [] });
	};

	assert.deepEqual(await toolFor().execute({ select: ["count(*)"] }, options), {
		ok: true,
		configured: true,
		table: config.table,
		query: calls[0]!.query,
		rows: [],
	});
	assert.equal(calls.length, 1);

	for (const body of [
		"invalid-json",
		null,
		[{ count: 1 }],
		42,
		{},
		{ rows: null },
		{ rows: { count: 1 } },
		{ result: {} },
		{ result: { rows: null } },
	]) {
		globalThis.fetch = async () => responseFor(body);
		const result = await toolFor().execute({ select: ["count(*)"] }, options);
		assert.equal(result.ok, false, `expected failure for ${String(body)}`);
		assert.equal(result.configured, true);
		assert.match(result.error!, /^analytics provider returned /);
	}

	for (const body of [
		{ rows: [] },
		{ rows: [{ count: 1 }] },
		{ result: [] },
		{ result: [{ count: 1 }] },
		{ result: { rows: [] } },
		{ result: { rows: [{ count: 1 }] } },
	]) {
		globalThis.fetch = async () => responseFor(body);
		const result = await toolFor().execute({ select: ["count(*)"] }, options);
		assert.equal(result.ok, true);
		assert.deepEqual(result.rows, expectedRows(body));
	}

	globalThis.fetch = async () =>
		responseFor({ success: false, errors: ["secret"] });
	assert.deepEqual(await toolFor().execute({ select: ["count(*)"] }, options), {
		ok: false,
		configured: true,
		error: "analytics provider rejected the query",
	});

	globalThis.fetch = async () =>
		responseFor("<html>secret provider body</html>", 503);
	assert.deepEqual(await toolFor().execute({ select: ["count(*)"] }, options), {
		ok: false,
		configured: true,
		status: 503,
		error: "analytics provider returned HTTP 503",
	});

	let fetchCount = 0;
	globalThis.fetch = async () => {
		fetchCount += 1;
		return responseFor({ rows: [] });
	};
	assert.equal(
		(await toolFor(() => undefined).execute({ select: ["count(*)"] }, options))
			.ok,
		false,
	);
	assert.equal(
		(await toolFor().execute({ table: "default.other" }, options)).ok,
		false,
	);
	assert.equal(
		(await toolFor().execute({ where: { "x OR 1=1": "hostile" } }, options)).ok,
		false,
	);
	assert.equal(fetchCount, 0);
} finally {
	globalThis.fetch = originalFetch;
}

console.log("r2-sql-tools.test.ts OK");
