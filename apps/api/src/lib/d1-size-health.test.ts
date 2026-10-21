import { DatabaseSync } from "node:sqlite";
import { createDbClient } from "@tedix/db/client";
import { readD1SizeBytes } from "@tedix/db/queries/d1-size";
import { createDbQueryClient } from "@tedix/db/query-client";
import { opsAlertState } from "@tedix/db/schema/ops-alert-state";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
	D1_SIZE_CONDITION_KEYS,
	LOGS_D1_ALERT_BYTES,
	MAIN_D1_ALERT_BYTES,
	reconcileD1SizeAlert,
} from "./d1-size-health";
import * as egress from "./ops-alert-egress";

vi.mock("./ops-alert-egress", () => ({ sendOpsAlert: vi.fn() }));

const ENV = {
	HEALTH_ALERT_EMAIL: "ops@example.test",
	HEALTH_ALERT_WEBHOOK: "",
};
const GB = 1_000_000_000;

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(schemaDdl(opsAlertState));
	return {
		db: createDbClient(createD1Facade(sqlite)),
		state: (key: string) =>
			sqlite
				.prepare(
					"SELECT status, metric_bucket AS bucket, notify_count AS notified FROM ops_alert_state WHERE condition_key = ?",
				)
				.get(key) as
				| { status: string; bucket: string; notified: number }
				| undefined,
	};
}

/** A D1 binding whose every statement returns `result`. */
function d1Returning(result: () => Promise<unknown>): D1Database {
	const statement = { bind: () => statement, run: result };
	return { prepare: () => statement } as unknown as D1Database;
}

describe("readD1SizeBytes", () => {
	it("reads D1's reported size after a trivial statement", async () => {
		const db = createDbQueryClient(
			d1Returning(async () => ({ success: true, meta: { size_after: 123 } })),
		);
		expect(await readD1SizeBytes(db)).toBe(123);
	});

	it("returns null when the size is missing or the probe fails", async () => {
		expect(
			await readD1SizeBytes(
				createDbQueryClient(
					d1Returning(async () => ({ success: true, meta: {} })),
				),
			),
		).toBeNull();
		expect(
			await readD1SizeBytes(
				createDbQueryClient(
					d1Returning(async () => {
						throw new Error("D1_ERROR: overloaded");
					}),
				),
			),
		).toBeNull();
	});
});

describe("reconcileD1SizeAlert", () => {
	beforeEach(() => {
		vi.mocked(egress.sendOpsAlert)
			.mockClear()
			.mockResolvedValue({ emailed: true, webhookPosted: false });
	});

	it("pages once when the main database reaches 9 GB, again on escalation, and on recovery", async () => {
		const { db, state } = fixture();
		const key = D1_SIZE_CONDITION_KEYS.main;
		expect(
			await reconcileD1SizeAlert(
				db,
				ENV,
				{ store: "main", bytes: MAIN_D1_ALERT_BYTES - 1 },
				"2026-10-22T00:00:00.000Z",
			),
		).toBe("unchanged");
		expect(state(key)).toBeUndefined();

		expect(
			await reconcileD1SizeAlert(
				db,
				ENV,
				{ store: "main", bytes: MAIN_D1_ALERT_BYTES },
				"2026-10-22T01:00:00.000Z",
			),
		).toBe("new");
		expect(state(key)).toMatchObject({ status: "open", notified: 1 });
		const first = vi.mocked(egress.sendOpsAlert).mock.calls.at(-1)?.[1];
		expect(first?.subject).toContain("Main D1 is near its size cap");
		expect(first?.text).toContain("9.00 GB");

		// Same quarter-gigabyte bucket: silent.
		expect(
			await reconcileD1SizeAlert(
				db,
				ENV,
				{ store: "main", bytes: MAIN_D1_ALERT_BYTES + 0.1 * GB },
				"2026-10-22T02:00:00.000Z",
			),
		).toBe("ongoing");
		expect(vi.mocked(egress.sendOpsAlert)).toHaveBeenCalledTimes(1);

		expect(
			await reconcileD1SizeAlert(
				db,
				ENV,
				{ store: "main", bytes: 9.5 * GB },
				"2026-10-22T03:00:00.000Z",
			),
		).toBe("escalated");
		expect(state(key)).toMatchObject({ status: "open", notified: 2 });

		expect(
			await reconcileD1SizeAlert(
				db,
				ENV,
				{ store: "main", bytes: 7 * GB },
				"2026-10-22T04:00:00.000Z",
			),
		).toBe("resolved");
		expect(state(key)).toMatchObject({ status: "resolved" });
		expect(vi.mocked(egress.sendOpsAlert)).toHaveBeenCalledTimes(3);
	});

	it("uses the 6 GB rotation trigger for the logs database", async () => {
		const { db, state } = fixture();
		expect(
			await reconcileD1SizeAlert(
				db,
				ENV,
				{ store: "logs", bytes: LOGS_D1_ALERT_BYTES },
				"2026-10-22T01:00:00.000Z",
			),
		).toBe("new");
		expect(state(D1_SIZE_CONDITION_KEYS.logs)).toMatchObject({
			status: "open",
		});
		const sent = vi.mocked(egress.sendOpsAlert).mock.calls.at(-1)?.[1];
		expect(sent?.text).toContain("rebind LOGS_DB");
	});

	it("leaves the state alone when the probe gave no size", async () => {
		const { db, state } = fixture();
		expect(
			await reconcileD1SizeAlert(
				db,
				ENV,
				{ store: "main", bytes: null },
				"2026-10-22T01:00:00.000Z",
			),
		).toBe("unchanged");
		expect(state(D1_SIZE_CONDITION_KEYS.main)).toBeUndefined();
		expect(vi.mocked(egress.sendOpsAlert)).not.toHaveBeenCalled();
	});
});
