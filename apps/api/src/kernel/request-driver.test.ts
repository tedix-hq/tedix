import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vite-plus/test";
import { createDbQueryClient } from "@tedix/db/query-client";
import {
	kernelRequests,
	kernelRequestEvents,
} from "@tedix/db/schema/kernel-requests";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import {
	getKernelRequest,
	listKernelRequestEvents,
	receiveKernelRequest,
} from "@tedix/db/queries/kernel-requests";
import {
	receivedKernelRequest,
	type KernelAcceptanceReader,
} from "./request-coordinator";
import {
	applyKernelRequestEvent,
	driveKernelRequest,
	type KernelRequestSourceReader,
} from "./request-driver";
const now = () => "2026-10-17T10:00:00.000Z";
const policy = {
	nextOwner: "kernel-example",
	retryMs: 1000,
	probeTimeoutMs: 100,
	maxProbeAttempts: 3,
	runBudgetMs: 1000,
};
const scope = {
	organizationId: "org-example",
	ownerUserId: "user-ada",
	id: "request-one",
};
async function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(schemaDdl(kernelRequests));
	sqlite.exec(schemaDdl(kernelRequestEvents));
	const db = createDbQueryClient(
		createD1Facade(sqlite, { maxBoundParams: 100 }),
	);
	let row = (await receiveKernelRequest(db, {
		...scope,
		sourceKind: "home",
		sourceId: "run-one",
		conversationId: "home-one",
		snapshot: receivedKernelRequest(),
		nextOwner: policy.nextOwner,
		nextAction: "file",
		nextDueAt: now(),
		lastEventId: "received",
		createdAt: now(),
		updatedAt: now(),
	}))!;
	row = await applyKernelRequestEvent(
		db,
		row,
		{ kind: "file", workItemId: "work-one" },
		policy,
		now(),
	);
	row = await applyKernelRequestEvent(
		db,
		row,
		{
			kind: "brief",
			revision: 1,
			checks: [
				{
					kind: "os_output_revision",
					outputId: "output-one",
					revisionId: "revision-one",
				},
			],
		},
		policy,
		now(),
	);
	row = await applyKernelRequestEvent(
		db,
		row,
		{ kind: "start", attemptId: "attempt-one" },
		policy,
		now(),
	);
	const reader: KernelAcceptanceReader = {
		readOutputRevision: vi.fn(async () => ({
			revisionId: "revision-one",
			evidenceRef: "output:one",
		})),
		readRepositoryDelivery: async () => {
			throw new Error("not configured");
		},
	};
	const reports = new Set<string>();
	const source: KernelRequestSourceReader = {
		readExecution: async () => ({
			attemptId: "attempt-one",
			outcome: "succeeded",
		}),
		deliverReport: vi.fn(async (_row, id) => {
			reports.add(id);
			return { status: "acknowledged" as const, receiptRef: "home:report-one" };
		}),
	};
	return { db, reader, source, reports };
}
describe("durable request driver", () => {
	it("recovers missed terminal events and records one acknowledged report without inventing a lesson", async () => {
		const { db, source, reader, reports } = await fixture();
		const row = await driveKernelRequest(
			db,
			scope,
			policy,
			source,
			reader,
			now,
		);
		expect(row?.snapshot).toMatchObject({
			state: "learned",
			outcome: "verified",
			learning: "no_new_lesson",
			delivery: { status: "acknowledged" },
		});
		expect(row?.nextDueAt).toBeNull();
		expect(reports.size).toBe(1);
		await driveKernelRequest(db, scope, policy, source, reader, now);
		expect(source.deliverReport).toHaveBeenCalledTimes(1);
		expect(
			(await listKernelRequestEvents(db, scope)).map((e) => e.snapshot.state),
		).toEqual([
			"received",
			"filed",
			"briefed",
			"running",
			"verifying",
			"verifying",
			"verifying",
			"reported",
			"learned",
		]);
	});
	it("replays a crash after delivery with the same durable report identity", async () => {
		const { db, source, reader, reports } = await fixture();
		const deliver = source.deliverReport;
		let crashed = false;
		source.deliverReport = async (row, id) => {
			const receipt = await deliver(row, id);
			if (!crashed) {
				crashed = true;
				throw new Error("eviction after delivery");
			}
			return receipt;
		};
		await expect(
			driveKernelRequest(db, scope, policy, source, reader, now),
		).rejects.toThrow("eviction");
		expect((await getKernelRequest(db, scope))?.snapshot.delivery?.status).toBe(
			"pending",
		);
		expect(
			(await driveKernelRequest(db, scope, policy, source, reader, now))
				?.snapshot.state,
		).toBe("learned");
		expect(reports.size).toBe(1);
		expect(reader.readOutputRevision).toHaveBeenCalledTimes(1);
	});
	it("keeps failed or unknown checks owned and due without success reports", async () => {
		for (const wrong of [false, true]) {
			const { db, source, reader } = await fixture();
			reader.readOutputRevision = async () => {
				if (!wrong) throw new Error("unavailable");
				return { revisionId: "wrong", evidenceRef: "output:wrong" };
			};
			const row = await driveKernelRequest(
				db,
				scope,
				policy,
				source,
				reader,
				now,
			);
			expect(row?.snapshot.state).toBe("verifying");
			expect(row?.snapshot.outcome).toBe(wrong ? "failed" : "unknown");
			expect(row?.nextDueAt).not.toBeNull();
			expect(row?.nextOwner).toBe(policy.nextOwner);
			expect(source.deliverReport).not.toHaveBeenCalled();
		}
	});
	it("ignores terminal observations from another Attempt", async () => {
		const { db, source, reader } = await fixture();
		source.readExecution = async () => ({
			attemptId: "attempt-other",
			outcome: "succeeded",
		});
		expect(
			(await driveKernelRequest(db, scope, policy, source, reader, now))
				?.snapshot.state,
		).toBe("running");
		expect(reader.readOutputRevision).not.toHaveBeenCalled();
	});
});
