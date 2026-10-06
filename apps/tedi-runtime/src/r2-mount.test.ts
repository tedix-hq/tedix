/**
 * R2 identity mount — behavioral coverage over the real VFS
 * (bun:sqlite DO-storage fixture, same pattern as workspace-fs.test.ts):
 *   1. objects under the source prefix materialize under `.r2/` and are
 *      readable through the Tedix adapter;
 *   2. the mount is enforced read-only (writes under `.r2/` reject);
 *   3. a null source mounts empty without breaking workspace ops.
 * The mount is a one-shot snapshot by upstream design — freshness and
 * write-mode conditions are recorded in workspace-fs.ts.
 */

import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { Workspace } from "@cloudflare/computer";
import { createPrivacySafeComputerObserver } from "./computer-observer";
import {
	adaptVfsToWorkspaceFs,
	createTediComputerTools,
	createTediWorkspaceVfs,
	type R2IdentityMountSource,
	type WorkspaceVfsStorage,
} from "./workspace-fs";
import { getTediWorkspaceClient } from "../test/workspace-client";

function makeStorage(): WorkspaceVfsStorage {
	const db = new Database(":memory:");
	return {
		sql: {
			exec: (query: string, ...bindings: unknown[]) => {
				let rows: Record<string, unknown>[] = [];
				try {
					rows =
						(db.query(query).all(...(bindings as never[])) as Record<
							string,
							unknown
						>[]) ?? [];
				} catch (err) {
					if (bindings.length === 0) db.run(query);
					else throw err;
				}
				const snapshot = rows;
				return {
					toArray: () => snapshot,
					one: () => snapshot[0],
					raw: () => snapshot.map((r) => Object.values(r)),
					[Symbol.iterator]() {
						return snapshot[Symbol.iterator]();
					},
				};
			},
		},
		transactionSync<T>(closure: () => T): T {
			db.run("BEGIN");
			try {
				const result = closure();
				db.run("COMMIT");
				return result;
			} catch (error) {
				db.run("ROLLBACK");
				throw error;
			}
		},
	} as unknown as WorkspaceVfsStorage;
}

// Computer's native write tool must remain usable beside the nested read-only
// identity mount. Upstream 0.3.0 eagerly mkdir()s the parent on every write;
// that mkdir rejects an ancestor of a read-only mount even when it already
// exists, so Tedix makes the recursive parent check idempotent at composition.
{
	const workspace = createTediWorkspaceVfs(makeStorage(), {
		identityMount: async () => ({
			bucket: makeBucket({ "tedi-native/SOUL.md": "# native" }),
			prefix: "tedi-native/",
		}),
	});
	const client = await getTediWorkspaceClient(workspace);
	const tools = createTediComputerTools(client);
	const read = tools.read as unknown as {
		execute(input: { path: string }): Promise<{ text?: string }>;
	};
	assert.match(
		JSON.stringify(await read.execute({ path: "/workspace/.r2/SOUL.md" })),
		/# native/,
		"the first native tool access sees the mounted identity without an adapter read",
	);
	const write = tools.write as unknown as {
		execute(input: { path: string; content: string }): Promise<unknown>;
	};
	await write.execute({
		path: "/workspace/computer-native-cert.txt",
		content: "computer-native-ok\n",
	});
	assert.equal(
		await adaptVfsToWorkspaceFs(client).readFile("computer-native-cert.txt"),
		"computer-native-ok\n",
	);
	// Run the released edit tool through Tedix's real composer and mounted VFS.
	// A fuzzy match must preserve Unicode and whitespace outside the edit.
	const original = "keep “this” — unchanged  \nconst target\u00a0= 1;\n";
	await write.execute({ path: "/workspace/edit.txt", content: original });
	const edit = tools.edit as unknown as {
		execute(input: {
			path: string;
			edits: { oldText: string; newText: string }[];
		}): Promise<unknown>;
	};
	await edit.execute({
		path: "/workspace/edit.txt",
		edits: [{ oldText: "const target = 1;", newText: "const target = 2;" }],
	});
	assert.equal(
		await adaptVfsToWorkspaceFs(client).readFile("edit.txt"),
		"keep “this” — unchanged  \nconst target = 2;\n",
	);
}

// Computer owns the mount initialization promise and retries failed indexing.
{
	let attempts = 0;
	const workspace = createTediWorkspaceVfs(makeStorage(), {
		identityMount: async () => {
			attempts++;
			if (attempts === 1) throw new Error("identity source unavailable");
			return {
				bucket: makeBucket({ "retry/SOUL.md": "ready" }),
				prefix: "retry/",
			};
		},
	});
	await assert.rejects(
		getTediWorkspaceClient(workspace),
		/identity source unavailable/,
	);
	const client = await getTediWorkspaceClient(workspace);
	const read = createTediComputerTools(client).read!;
	assert.match(
		JSON.stringify(
			await read.execute!({ path: "/workspace/.r2/SOUL.md" }, {
				toolCallId: "retry",
				messages: [],
			} as never),
		),
		/ready/,
	);
	const adapter = adaptVfsToWorkspaceFs(client);
	assert.equal(await adapter.readFile(".r2/SOUL.md"), "ready");
	assert.equal(await adapter.readFile(".r2/SOUL.md"), "ready");
	assert.equal(attempts, 2);
}

// Native tools and adapter calls share Computer's actual observer surface.
{
	const spans: Array<{ name: string; attributes: Record<string, unknown> }> =
		[];
	const workspace = new Workspace({
		storage: makeStorage(),
		observer: createPrivacySafeComputerObserver({
			async span(name, attributes, run) {
				const recorded = { name, attributes: { ...attributes } };
				spans.push(recorded);
				return run({
					setAttribute(key, value) {
						recorded.attributes[key] = value;
					},
				});
			},
		}),
	});
	const client = await getTediWorkspaceClient(workspace);
	const tools = createTediComputerTools(client);
	await tools.write!.execute!(
		{ path: "/workspace/private-customer.txt", content: "private-secret" },
		{ toolCallId: "write", messages: [] } as never,
	);
	await tools.read!.execute!({ path: "/workspace/private-customer.txt" }, {
		toolCallId: "read",
		messages: [],
	} as never);
	assert.ok(spans.some((span) => span.name === "workspace.fs.writeFile"));
	assert.ok(spans.some((span) => span.name === "workspace.fs.readFile"));
	assert.doesNotMatch(JSON.stringify(spans), /private-customer|private-secret/);
	const before = spans.length;
	assert.equal(
		await adaptVfsToWorkspaceFs(client).readFile("private-customer.txt"),
		"private-secret",
	);
	assert.ok(
		spans.slice(before).some((span) => span.name === "workspace.fs.readFile"),
	);
}

function textStream(text: string): ReadableStream<Uint8Array> {
	const bytes = new TextEncoder().encode(text);
	return new ReadableStream({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}

function makeBucket(objects: Record<string, string>) {
	return {
		async list(options?: { prefix?: string; limit?: number }) {
			const prefix = options?.prefix ?? "";
			const limit = options?.limit ?? Number.POSITIVE_INFINITY;
			return {
				objects: Object.entries(objects)
					.filter(([key]) => key.startsWith(prefix))
					.slice(0, limit)
					.map(([key, text]) => ({ key, size: text.length })),
				truncated: false,
			};
		},
		async get(key: string) {
			const text = objects[key];
			if (text === undefined) return null;
			return { body: textStream(text), size: text.length };
		},
	};
}

// A busy tedi can have thousands of generated objects below its own prefix.
// They must not count toward the identity mount or disable scratch workspace
// operations. Only the canonical identity allowlist is projected.
{
	const objects: Record<string, string> = {
		"tedi-noisy/SOUL.md": "# bounded soul",
		"tedi-noisy/MEMORY.md": "- bounded memory",
	};
	for (let i = 0; i < 600; i += 1) {
		objects[`tedi-noisy/artifacts/turn-${i}.json`] = `{"turn":${i}}`;
	}
	const workspace = adaptVfsToWorkspaceFs(
		await getTediWorkspaceClient(
			createTediWorkspaceVfs(makeStorage(), {
				identityMount: async () => ({
					bucket: makeBucket(objects),
					prefix: "tedi-noisy/",
				}),
			}),
		),
	);
	assert.equal(await workspace.readFile(".r2/SOUL.md"), "# bounded soul");
	assert.equal(await workspace.readFile(".r2/MEMORY.md"), "- bounded memory");
	assert.equal(
		await workspace.readFile(".r2/artifacts/turn-0.json"),
		null,
		"generated objects stay outside the identity projection",
	);
	await workspace.writeFile("cert/live.txt", "workspace remains writable");
	assert.equal(
		await workspace.readFile("cert/live.txt"),
		"workspace remains writable",
	);
}

// 1 + 2: materialization + read-only enforcement.
{
	const bucket = makeBucket({
		"tedi-1/SOUL.md": "# soul\npersistent identity",
		"tedi-1/memory/MEMORY.md": "- fact one",
		"other-tedi/SOUL.md": "must not appear",
	});
	const source: R2IdentityMountSource = async () => ({
		bucket,
		prefix: "tedi-1/",
	});
	const workspace = adaptVfsToWorkspaceFs(
		await getTediWorkspaceClient(
			createTediWorkspaceVfs(makeStorage(), { identityMount: source }),
		),
	);

	const soul = await workspace.readFile(".r2/SOUL.md");
	assert.ok(soul?.includes("persistent identity"), "mounted file readable");
	const nested = await workspace.readFile(".r2/memory/MEMORY.md");
	assert.ok(nested?.includes("fact one"), "nested key materialized");
	assert.equal(
		await workspace.readFile(".r2/other-tedi/SOUL.md"),
		null,
		"prefix scoping: foreign tedi keys must not materialize",
	);

	let rejected = false;
	try {
		await workspace.writeFile(".r2/SOUL.md", "mutated");
	} catch (error) {
		rejected = true;
		assert.match(
			error instanceof Error ? error.message : String(error),
			/read-only|EROFS/i,
			"write rejection names the read-only mount",
		);
	}
	assert.ok(rejected, "writes under .r2/ must reject (read-only mount)");
}

// 3: null source → empty mount, workspace stays fully usable.
{
	const workspace = adaptVfsToWorkspaceFs(
		await getTediWorkspaceClient(
			createTediWorkspaceVfs(makeStorage(), {
				identityMount: async () => null,
			}),
		),
	);
	assert.equal(
		await workspace.readFile(".r2/SOUL.md"),
		null,
		"empty mount serves nothing",
	);
	await workspace.writeFile("scratch/ok.txt", "still writable");
	assert.equal(await workspace.readFile("scratch/ok.txt"), "still writable");
}

console.log("r2-mount OK");
