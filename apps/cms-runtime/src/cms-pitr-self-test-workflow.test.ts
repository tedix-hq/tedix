import { describe, expect, it, vi } from "vite-plus/test";
import { EmDashDB } from "./index";
import {
	CMS_PITR_SELF_TEST_DO_NAME,
	CMS_PITR_SELF_TEST_INSTANCE_ID,
	CMS_PITR_SELF_TEST_RECEIPT_KEY,
	runCmsPitrSelfTest,
} from "./cms-pitr-self-test-workflow";

function fakeReservedDo() {
	let table = false;
	let state: "before" | "after" = "before";
	let scheduled: "before" | "after" | null = null;
	let receipt: unknown;
	let putCount = 0;
	let failPutAt: number | undefined;
	const events: string[] = [];
	const idFromName = vi.fn((name: string) => ({
		toString: () =>
			name === CMS_PITR_SELF_TEST_DO_NAME ? "reserved-id" : name,
	}));
	const put = vi.fn(
		async (key: string, body: string, _options?: R2PutOptions) => {
			if (++putCount === failPutAt) throw new Error("R2 unavailable");
			expect(key).toBe(CMS_PITR_SELF_TEST_RECEIPT_KEY);
			receipt = JSON.parse(body) as unknown;
			events.push(`persist:${(receipt as { state: string }).state}`);
			return {};
		},
	);
	const object = Object.assign(Object.create(EmDashDB.prototype), {
		ctx: {
			id: { toString: () => "reserved-id" },
			storage: {
				sql: {
					exec: (sql: string) => {
						if (sql.startsWith("CREATE TABLE")) table = true;
						if (sql.startsWith("INSERT INTO")) state = "before";
						if (sql.startsWith("UPDATE")) state = "after";
						return {
							toArray: () =>
								sql.includes("FROM sqlite_master")
									? table
										? [{ name: "_tedix_pitr_self_test" }]
										: []
									: sql.includes("SELECT state")
										? [{ state }]
										: [],
						};
					},
				},
				getCurrentBookmark: vi.fn(async () => "before-bookmark"),
				onNextSessionRestoreBookmark: vi.fn(async (bookmark: string) => {
					events.push(`schedule:${bookmark}`);
					if (bookmark === "before-bookmark") {
						scheduled = "before";
						return "undo-bookmark";
					}
					if (bookmark === "undo-bookmark") {
						scheduled = "after";
						return "redo-bookmark";
					}
					throw new Error("unexpected bookmark");
				}),
			},
			abort: vi.fn(() => {
				events.push("abort");
				if (scheduled) state = scheduled;
				scheduled = null;
				throw new Error("Durable Object reset");
			}),
		},
		env: {
			DB_DO: { idFromName },
			RECOVERY_STORAGE: {
				get: vi.fn(async (key: string) => {
					expect(key).toBe(CMS_PITR_SELF_TEST_RECEIPT_KEY);
					return receipt ? { json: async () => receipt } : null;
				}),
				put,
			},
		},
	}) as EmDashDB;
	return {
		object,
		ctx: (
			object as unknown as {
				ctx: { id: { toString(): string }; storage: { primary?: unknown } };
			}
		).ctx,
		idFromName,
		put,
		failPutAt: (count: number) => {
			failPutAt = count;
		},
		events,
		get receipt() {
			return receipt;
		},
	};
}

describe("reserved CMS Durable Object PITR self-test", () => {
	it("restores and undoes only after persisting both recovery bookmarks", async () => {
		const harness = fakeReservedDo();
		await harness.object.preparePitrSelfTest();
		expect(await harness.object.readPitrSelfTestState()).toBe("after");
		expect(harness.receipt).toEqual({
			version: 1,
			state: "restore-scheduled",
			undoBookmark: "undo-bookmark",
		});
		await expect(harness.object.restartPitrSelfTest()).rejects.toThrow(
			"Durable Object reset",
		);
		expect(await harness.object.readPitrSelfTestState()).toBe("before");
		await harness.object.schedulePitrSelfTestUndo();
		expect(harness.receipt).toEqual({
			version: 1,
			state: "undo-scheduled",
			undoBookmark: "undo-bookmark",
			redoBookmark: "redo-bookmark",
		});
		await expect(harness.object.restartPitrSelfTest()).rejects.toThrow(
			"Durable Object reset",
		);
		expect(await harness.object.readPitrSelfTestState()).toBe("after");
		await harness.object.completePitrSelfTest();
		expect(harness.receipt).toEqual({ version: 1, state: "verified" });
		expect(harness.events).toEqual([
			"persist:preparing",
			"schedule:before-bookmark",
			"persist:restore-scheduled",
			"abort",
			"schedule:undo-bookmark",
			"persist:undo-scheduled",
			"abort",
			"persist:verified",
		]);
	});

	it("rejects a different Durable Object identity before any storage operation", async () => {
		const harness = fakeReservedDo();
		Object.assign(harness.ctx.id, { toString: () => "customer-id" });
		await expect(harness.object.preparePitrSelfTest()).rejects.toThrow(
			"identity mismatch",
		);
		expect(harness.events).toEqual([]);
	});

	it("forwards a replica to the primary", async () => {
		const harness = fakeReservedDo();
		const preparePitrSelfTest = vi.fn(async () => undefined);
		Object.assign(harness.ctx.storage, {
			primary: { preparePitrSelfTest },
		});
		await harness.object.preparePitrSelfTest();
		expect(preparePitrSelfTest).toHaveBeenCalledOnce();
		expect(harness.events).toEqual([]);
	});

	it("fails closed without abort when the undo receipt cannot be persisted", async () => {
		const harness = fakeReservedDo();
		harness.failPutAt(2);
		await expect(harness.object.preparePitrSelfTest()).rejects.toThrow(
			"R2 unavailable",
		);
		expect(harness.events).toEqual([
			"persist:preparing",
			"schedule:before-bookmark",
		]);
		expect(await harness.object.readPitrSelfTestState()).toBe("after");
		await expect(harness.object.preparePitrSelfTest()).rejects.toThrow(
			"operator reconciliation",
		);
		expect(harness.receipt).toEqual({
			version: 1,
			state: "preparing",
		});
		expect(harness.events).not.toContain("abort");
	});

	it("never mutates SQLite if another run wins the private R2 claim", async () => {
		const harness = fakeReservedDo();
		harness.put.mockResolvedValueOnce(null as never);
		await expect(harness.object.preparePitrSelfTest()).rejects.toThrow(
			"already claimed",
		);
		expect(await harness.object.readPitrSelfTestState()).toBe("missing");
		expect(harness.events).toEqual([]);
		const options = harness.put.mock.calls[0]?.[2];
		expect(options?.onlyIf).toBeInstanceOf(Headers);
		if (!(options?.onlyIf instanceof Headers))
			throw new Error("conditional R2 claim missing");
		expect(options.onlyIf.get("If-None-Match")).toBe("*");
	});
});

describe("CMS PITR self-test Workflow", () => {
	it("accepts no target or bookmark parameters", async () => {
		const idFromName = vi.fn();
		await expect(
			runCmsPitrSelfTest(
				{ DB_DO: { idFromName } } as never,
				{} as never,
				CMS_PITR_SELF_TEST_INSTANCE_ID,
				{ siteId: "customer", bookmark: "forged" },
			),
		).rejects.toThrow("only empty parameters");
		expect(idFromName).not.toHaveBeenCalled();
	});

	it("requires one fixed Workflow instance ID before touching the DO", async () => {
		const idFromName = vi.fn();
		await expect(
			runCmsPitrSelfTest(
				{ DB_DO: { idFromName } } as never,
				{} as never,
				"another-instance",
				{},
			),
		).rejects.toThrow("fixed Workflow instance ID");
		expect(idFromName).not.toHaveBeenCalled();
	});

	it("does not certify a failed restart without restored readback", async () => {
		const stub = {
			readPitrSelfTestReceiptState: vi.fn(async () => "restore-scheduled"),
			preparePitrSelfTest: vi.fn(async () => undefined),
			restartPitrSelfTest: vi.fn(async () => {
				throw new Error("Durable Object reset");
			}),
			readPitrSelfTestState: vi.fn(async () => "after"),
			schedulePitrSelfTestUndo: vi.fn(),
			completePitrSelfTest: vi.fn(),
		};
		await expect(
			runCmsPitrSelfTest(
				{
					DB_DO: { idFromName: (name: string) => name, get: () => stub },
				} as never,
				{
					do: async (_name: string, fn: () => Promise<unknown>) => fn(),
				} as never,
				CMS_PITR_SELF_TEST_INSTANCE_ID,
				{},
			),
		).rejects.toThrow("restore did not recover marker");
		expect(stub.schedulePitrSelfTestUndo).not.toHaveBeenCalled();
		expect(stub.completePitrSelfTest).not.toHaveBeenCalled();
	});

	it("proves restore and undo through fresh reads after expected disconnects", async () => {
		let state: "before" | "after" = "after";
		const stub = {
			readPitrSelfTestReceiptState: vi.fn(async () => "missing"),
			preparePitrSelfTest: vi.fn(async () => undefined),
			restartPitrSelfTest: vi.fn(async () => {
				state = state === "after" ? "before" : "after";
				throw new Error("Durable Object reset");
			}),
			readPitrSelfTestState: vi.fn(async () => state),
			schedulePitrSelfTestUndo: vi.fn(async () => undefined),
			completePitrSelfTest: vi.fn(async () => undefined),
		};
		const idFromName = vi.fn((name: string) => name);
		const get = vi.fn(() => stub);
		const step = {
			do: vi.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
		};
		const result = await runCmsPitrSelfTest(
			{ DB_DO: { idFromName, get } } as never,
			step as never,
			CMS_PITR_SELF_TEST_INSTANCE_ID,
			{},
		);
		expect(result).toEqual({
			status: "verified",
			evidence: "fresh",
			restored: "before",
			undone: "after",
		});
		expect(idFromName).toHaveBeenCalledWith(CMS_PITR_SELF_TEST_DO_NAME);
		expect(stub.readPitrSelfTestState).toHaveBeenCalledTimes(2);
		expect(stub.completePitrSelfTest).toHaveBeenCalledOnce();
	});

	it("returns a prior verified result without restarting the object", async () => {
		const stub = {
			readPitrSelfTestReceiptState: vi.fn(async () => "verified"),
			preparePitrSelfTest: vi.fn(),
			restartPitrSelfTest: vi.fn(),
			readPitrSelfTestState: vi.fn(),
			schedulePitrSelfTestUndo: vi.fn(),
			completePitrSelfTest: vi.fn(),
		};
		const result = await runCmsPitrSelfTest(
			{
				DB_DO: { idFromName: (name: string) => name, get: () => stub },
			} as never,
			{
				do: async (_name: string, fn: () => Promise<unknown>) => fn(),
			} as never,
			CMS_PITR_SELF_TEST_INSTANCE_ID,
			{},
		);
		expect(result).toEqual({
			status: "verified",
			evidence: "prior",
			restored: "before",
			undone: "after",
		});
		expect(stub.preparePitrSelfTest).not.toHaveBeenCalled();
		expect(stub.restartPitrSelfTest).not.toHaveBeenCalled();
	});
});
