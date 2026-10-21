/**
 * Over-budget Code Mode results are kept whole behind a handle (R2
 * `AGGREGATE_CACHE`) and paged back through `discover.read_result`. A handle
 * resolves only for the organization and principal that produced it, and
 * only until it expires; a small result is untouched.
 */

import {
	isCodeModeResultHandle,
	isTruncatedCodeModeResult,
	type CodeModeResultHandle,
} from "@tedix/tedi-codemode-core/bounded-result";
import { describe, expect, it } from "vite-plus/test";
import { buildCatalogProvider } from "./codemode-catalog";
import {
	CODEMODE_RESULT_HANDLE_TTL_MS,
	codeModeResultOwner,
	createCodeModeResultStore,
} from "./codemode-result-store";
import { shapeCodeModeResultWithHandle } from "./codemode-results";
import type { ServerContext } from "./server-context";

const EXECUTION_ID = "2f6c1e6e-6b1e-4b7e-9c6e-3f1a2b3c4d5e";

class FakeBucket {
	objects = new Map<
		string,
		{ body: string; customMetadata?: Record<string, string> }
	>();
	failPut = false;
	async put(
		key: string,
		body: string,
		options?: { customMetadata?: Record<string, string> },
	) {
		if (this.failPut) throw new Error("r2 unavailable");
		this.objects.set(key, { body, customMetadata: options?.customMetadata });
	}
	async get(key: string) {
		const stored = this.objects.get(key);
		if (!stored) return null;
		return {
			customMetadata: stored.customMetadata,
			text: async () => stored.body,
		};
	}
	async delete(key: string) {
		this.objects.delete(key);
	}
}

function serverCtx(input: {
	bucket: FakeBucket | null;
	organizationId: string;
	userId?: string;
	tediId?: string;
}): ServerContext {
	return {
		loadedTools: new Map(),
		app: { organizationId: input.organizationId },
		env: input.bucket ? { AGGREGATE_CACHE: input.bucket } : {},
		callerIdentity: {
			authType: "user",
			organizationId: input.organizationId,
			...(input.userId ? { userId: input.userId } : {}),
			...(input.tediId ? { tediId: input.tediId } : {}),
		},
	} as unknown as ServerContext;
}

function oversizedPage(rows = 400): { data: Record<string, unknown>[] } {
	return {
		data: Array.from({ length: rows }, (_, i) => ({
			id: `31090c72-e6eb-4bc1-b3a1-4d799845${String(i).padStart(4, "0")}`,
			title: `work item ${i} with a long descriptive title carrying detail`,
			description: "long description body ".repeat(12),
		})),
	};
}

async function readResult(
	ctx: ServerContext,
	input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const tools = buildCatalogProvider(ctx, undefined).tools as Record<
		string,
		{ execute: (input: unknown) => Promise<unknown> }
	>;
	return (await tools.read_result!.execute(input)) as Record<string, unknown>;
}

describe("Code Mode result handles", () => {
	it("leaves a within-budget result untouched and writes nothing", async () => {
		const bucket = new FakeBucket();
		const ctx = serverCtx({ bucket, organizationId: "org_a", userId: "u1" });
		const value = { data: [{ id: "a" }] };
		const shaped = await shapeCodeModeResultWithHandle(value, {
			store: createCodeModeResultStore(ctx.env, codeModeResultOwner(ctx)),
			executionId: EXECUTION_ID,
		});
		expect(shaped).toBe(value);
		expect(bucket.objects.size).toBe(0);
	});

	it("keeps an over-budget result whole and returns a handle envelope", async () => {
		const bucket = new FakeBucket();
		const ctx = serverCtx({ bucket, organizationId: "org_a", userId: "u1" });
		const value = oversizedPage();
		const shaped = await shapeCodeModeResultWithHandle(value, {
			store: createCodeModeResultStore(ctx.env, codeModeResultOwner(ctx)),
			executionId: EXECUTION_ID,
		});
		expect(isCodeModeResultHandle(shaped)).toBe(true);
		const envelope = shaped as CodeModeResultHandle;
		expect(envelope.handle).toBe(EXECUTION_ID);
		expect(envelope.keys).toEqual(["data"]);
		expect(envelope.total).toBe(JSON.stringify(value).length);
		expect(JSON.stringify(envelope).length).toBeLessThan(8_000);
		expect([...bucket.objects.keys()]).toEqual([
			`codemode-results/v1/org_a/${EXECUTION_ID}`,
		]);
	});

	it("falls back to the truncation envelope when the result cannot be stored", async () => {
		const bucket = new FakeBucket();
		bucket.failPut = true;
		const ctx = serverCtx({ bucket, organizationId: "org_a", userId: "u1" });
		const shaped = await shapeCodeModeResultWithHandle(oversizedPage(), {
			store: createCodeModeResultStore(ctx.env, codeModeResultOwner(ctx)),
			executionId: EXECUTION_ID,
		});
		expect(isTruncatedCodeModeResult(shaped)).toBe(true);

		// No bucket bound, or no caller identity to bind the handle to.
		expect(
			createCodeModeResultStore({}, { organizationId: "o", principal: "p" }),
		).toBeNull();
		expect(
			codeModeResultOwner(serverCtx({ bucket, organizationId: "org_a" })),
		).toBeNull();
	});

	it("pages the full result back through discover.read_result", async () => {
		const bucket = new FakeBucket();
		const ctx = serverCtx({ bucket, organizationId: "org_a", userId: "u1" });
		const value = oversizedPage();
		await shapeCodeModeResultWithHandle(value, {
			store: createCodeModeResultStore(ctx.env, codeModeResultOwner(ctx)),
			executionId: EXECUTION_ID,
		});

		const parts: string[] = [];
		let offset: number | undefined = 0;
		while (offset !== undefined) {
			const page = await readResult(ctx, {
				handle: EXECUTION_ID,
				offset,
				limit: 20_000,
			});
			parts.push(page.text as string);
			offset = page.nextOffset as number | undefined;
		}
		expect(parts.length).toBeGreaterThan(1);
		expect(JSON.parse(parts.join(""))).toEqual(value);

		const nested = await readResult(ctx, {
			handle: EXECUTION_ID,
			path: "data[3].id",
		});
		expect(nested).toMatchObject({
			value: value.data[3]!.id,
			complete: true,
		});
	});

	it("refuses a handle from another organization or another user", async () => {
		const bucket = new FakeBucket();
		const producer = serverCtx({
			bucket,
			organizationId: "org_a",
			userId: "u1",
		});
		await shapeCodeModeResultWithHandle(oversizedPage(), {
			store: createCodeModeResultStore(
				producer.env,
				codeModeResultOwner(producer),
			),
			executionId: EXECUTION_ID,
		});

		const otherOrg = serverCtx({
			bucket,
			organizationId: "org_b",
			userId: "u1",
		});
		await expect(
			readResult(otherOrg, { handle: EXECUTION_ID }),
		).rejects.toThrow(/unknown, expired, or was produced for another/);

		const otherUser = serverCtx({
			bucket,
			organizationId: "org_a",
			userId: "u2",
		});
		await expect(
			readResult(otherUser, { handle: EXECUTION_ID }),
		).rejects.toThrow(/unknown, expired, or was produced for another/);

		const tedi = serverCtx({ bucket, organizationId: "org_a", tediId: "u1" });
		await expect(readResult(tedi, { handle: EXECUTION_ID })).rejects.toThrow();

		// The producer still reads it; a malformed handle never reaches the bucket.
		expect(await readResult(producer, { handle: EXECUTION_ID })).toMatchObject({
			handle: EXECUTION_ID,
		});
		await expect(
			readResult(producer, { handle: "../org_b/anything" }),
		).rejects.toThrow(/unknown, expired/);
		await expect(readResult(producer, {})).rejects.toThrow(/requires/);
	});

	it("expires a handle after its TTL and drops the stored object", async () => {
		const bucket = new FakeBucket();
		let now = Date.parse("2026-01-01T00:00:00.000Z");
		const owner = { organizationId: "org_a", principal: "user:u1" };
		const store = createCodeModeResultStore(
			{ AGGREGATE_CACHE: bucket },
			owner,
			{ now: () => now },
		)!;
		const { expiresAt } = await store.put(EXECUTION_ID, '{"ok":true}');
		expect(Date.parse(expiresAt) - now).toBe(CODEMODE_RESULT_HANDLE_TTL_MS);

		now += CODEMODE_RESULT_HANDLE_TTL_MS - 1;
		expect(await store.get(EXECUTION_ID)).toBe('{"ok":true}');

		now += 1;
		expect(await store.get(EXECUTION_ID)).toBeNull();
		expect(bucket.objects.size).toBe(0);
	});
});
