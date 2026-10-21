import assert from "node:assert/strict";
import type { ToolExecuteFunction } from "ai";
import type { z } from "zod";
import { createObjectStoreTools } from "./object-store-tools";

const root = "tedi-example/objects/";
const peerRoot = "tedi-peer/objects/";
const uploaded = new Date("2026-01-01T00:00:00.000Z");
const options = {
	toolCallId: "object-store-test",
	messages: [],
	context: undefined,
};
type ListInput = { prefix?: string; limit?: number; cursor?: string };
type ListResult = {
	ok: boolean;
	prefix: string;
	root: string;
	objects: { path: string; size: number; uploaded: string | null }[];
	truncated: boolean;
	cursor: string | null;
};

function fixture() {
	const objects = [
		{ key: `${root}reports/a.txt`, size: 1, uploaded },
		{ key: `${root}reports/日本語.txt`, size: 3 },
		{ key: `${root}secret.txt`, size: 6 },
		{ key: `${peerRoot}reports/private.txt`, size: 9 },
		{ key: "tedi-example/artifacts/report.txt", size: 10 },
	];
	const calls: R2ListOptions[] = [];
	const cursors = new Map<string, number>();
	let identity: string | null = null;
	let resolvedIdentity: string | null = "tedi-example";
	let identityError: Error | undefined;
	let identityCalls = 0;
	const tools = createObjectStoreTools({
		bucket: {
			async list(input: R2ListOptions) {
				calls.push(input);
				const matching = objects.filter((object) =>
					object.key.startsWith(input.prefix ?? ""),
				);
				const offset = cursors.get(input.cursor ?? "") ?? 0;
				const page = matching.slice(offset, offset + (input.limit ?? 100));
				const truncated = offset + page.length < matching.length;
				const cursor = ` opaque+/=日本語:${calls.length} `;
				cursors.set(cursor, offset + page.length);
				return { objects: page, truncated, cursor };
			},
			async get() {
				assert.fail("listing must not read object bodies");
			},
			async put() {
				assert.fail("listing must not write objects");
			},
		} as unknown as R2Bucket,
		ensureIdentity: async () => {
			identityCalls++;
			if (identityError) throw identityError;
			identity = resolvedIdentity;
		},
		getTediId: () => identity,
		getSlug: () => "example",
		getPlatformClient: async () => null,
		recordArtifact: async () =>
			assert.fail("listing must not record artifacts"),
	});
	const list = tools.object_store_list!;
	assert.ok(list.execute);
	const execute = list.execute as ToolExecuteFunction<
		ListInput,
		unknown,
		unknown
	>;
	const schema = list.inputSchema as z.ZodType<ListInput>;
	return {
		calls,
		schema,
		identityCalls: () => identityCalls,
		resolveTo: (value: string | null) => {
			resolvedIdentity = value;
		},
		failIdentity: (error: Error) => {
			identityError = error;
		},
		list: async (input: ListInput) =>
			(await execute(schema.parse(input), options)) as ListResult,
		execute: async (input: ListInput) =>
			(await execute(input, options)) as ListResult,
	};
}

const failures: unknown[] = [];
async function check(name: string, run: () => Promise<void>) {
	try {
		await run();
		console.log(`PASS: ${name}`);
	} catch (error) {
		console.error(`FAIL: ${name}`, error);
		failures.push(error);
	}
}

await check(
	"resume a truncated listing through the real schema and execute",
	async () => {
		const f = fixture();
		const first = await f.list({ prefix: " ///reports ", limit: 1 });
		assert.deepEqual(first, {
			ok: true,
			prefix: "reports",
			root,
			objects: [
				{ path: "reports/a.txt", size: 1, uploaded: uploaded.toISOString() },
			],
			truncated: true,
			cursor: " opaque+/=日本語:1 ",
		});
		const second = await f.list({
			prefix: "reports",
			limit: 1,
			cursor: first.cursor!,
		});
		assert.deepEqual(second, {
			ok: true,
			prefix: "reports",
			root,
			objects: [{ path: "reports/日本語.txt", size: 3, uploaded: null }],
			truncated: false,
			cursor: null,
		});
		assert.equal(f.calls[1]!.cursor, first.cursor);
		assert.equal(f.calls[1]!.prefix, `${root}reports`);
		assert.equal(f.calls[1]!.limit, 1);
		assert.equal(f.identityCalls(), 2);
	},
);

await check(
	"reject invalid nonempty prefixes before bucket access",
	async () => {
		for (const prefix of [
			"../secret",
			"reports/../secret",
			"reports/./a",
			"reports//a",
			"reports/",
			"a\0b",
			"/",
			"a".repeat(1025),
		]) {
			const f = fixture();
			const result = await f.list({ prefix, cursor: "opaque" });
			assert.deepEqual(
				f.calls,
				[],
				`bucket accessed for ${JSON.stringify(prefix)}`,
			);
			assert.deepEqual(result, {
				ok: false,
				error: "prefix must be a safe object path",
			});
		}
	},
);

await check(
	"omitted and empty prefixes list only the per-tedi root",
	async () => {
		for (const prefix of [undefined, "", "   "]) {
			const f = fixture();
			const result = await f.list({ prefix });
			assert.equal(result.prefix, "");
			assert.equal(result.root, root);
			assert.deepEqual(
				result.objects.map((object) => object.path),
				["reports/a.txt", "reports/日本語.txt", "secret.txt"],
			);
			assert.equal(result.cursor, null);
			assert.equal(f.calls[0]!.prefix, root);
			assert.equal(f.calls[0]!.limit, 100);
		}
	},
);

await check(
	"cursor does not replace a freshly resolved tedi root",
	async () => {
		const f = fixture();
		const first = await f.list({ prefix: "reports", limit: 1 });
		f.resolveTo("tedi-peer");
		const second = await f.list({ prefix: "reports", cursor: first.cursor! });
		assert.equal(f.calls[1]!.prefix, `${peerRoot}reports`);
		assert.equal(f.calls[1]!.cursor, first.cursor);
		assert.equal(second.root, peerRoot);
		assert.ok(
			second.objects.every((object) => !object.path.includes("tedi-example")),
		);
		const rootResult = await f.list({});
		assert.deepEqual(
			rootResult.objects.map((object) => object.path),
			["reports/private.txt"],
		);
	},
);

await check(
	"identity failures never reach the bucket, including on resume",
	async () => {
		const f = fixture();
		const first = await f.list({ limit: 1 });
		f.resolveTo(null);
		assert.deepEqual(await f.list({ cursor: first.cursor! }), {
			ok: false,
			error: "Tedi identity is not resolved",
		});
		assert.equal(f.calls.length, 1);
		const error = new Error("identity unavailable");
		f.failIdentity(error);
		await assert.rejects(
			f.list({ cursor: first.cursor! }),
			(caught) => caught === error,
		);
		assert.equal(f.calls.length, 1);
	},
);

await check("schema and direct execution preserve bounded limits", async () => {
	const f = fixture();
	for (const limit of [0, -1, 1.5, 501, Infinity, NaN]) {
		assert.equal(f.schema.safeParse({ limit }).success, false);
	}
	assert.equal(f.schema.safeParse({ cursor: 123 }).success, false);
	for (const [limit, expected] of [
		[undefined, 100],
		[0, 1],
		[-1, 1],
		[1.9, 1],
		[501, 500],
		[Infinity, 100],
		[NaN, 100],
	] as const) {
		await f.execute({ limit });
		assert.equal(f.calls.at(-1)!.limit, expected);
	}
});

if (failures.length)
	throw new AggregateError(failures, "object store listing regressions");
