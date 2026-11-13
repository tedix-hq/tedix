import { expect, test } from "bun:test";
import { activateAll } from "./activate";
import { main } from "./cli";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
	existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ReconcileReport } from "./reconcile";
import { Scope } from "./scope";
import { WORKSPACE_TABLES } from "./tables";
import {
	RemoteWorkspaceStore,
	type StoreDescription,
	type WorkspaceStoreFactory,
} from "./target";

const now = new Date("2026-11-12T03:00:00Z");
function fixture() {
	const report: ReconcileReport = {
		ok: true,
		checkedAt: now.toISOString(),
		freeze: { frozenAt: "2026-11-12T02:00:00Z", evidenceRef: "fixture:freeze" },
		workspaces: ["one", "two"].map((workspaceId) => ({
			organizationId: "fixture",
			workspaceId,
			ok: true,
			jurisdiction: "eu",
			importGeneration: 3,
			outputAuthority: "shared",
			rows: 1,
			drift: [],
			expectedRereads: [],
			objectNativeRows: [],
			problems: [],
			ms: 0,
		})),
		totals: WORKSPACE_TABLES.map(({ table }) => ({
			table,
			source: 1,
			bundled: 1,
			staying: 0,
		})),
		knownDifferences: [],
		problems: [],
	};
	const descriptions = new Map<string, StoreDescription>(
		report.workspaces.map((w) => [
			w.workspaceId,
			{
				organizationId: w.organizationId,
				workspaceId: w.workspaceId,
				createdAt: now.toISOString(),
				migrations: [],
				jurisdiction: "eu",
				importGeneration: 3,
				outputAuthority: "shared",
			},
		]),
	);
	const activated: string[] = [];
	let race = false;
	const stores: WorkspaceStoreFactory = {
		kind: "remote",
		async open(ref) {
			const current = descriptions.get(ref.workspaceId)!;
			return {
				async describe() {
					return { ...current };
				},
				async activate(input) {
					if (race) current.importGeneration! += 1;
					if (current.importGeneration !== input.importGeneration)
						throw new Error("Import changed");
					activated.push(ref.workspaceId);
					current.outputAuthority = "object";
					return input;
				},
				async readRows() {
					return { rows: [], next: null };
				},
				async importRows() {
					throw new Error("Unexpected import");
				},
				async close() {},
			};
		},
	};
	return {
		report,
		stores,
		descriptions,
		activated,
		race() {
			race = true;
		},
	};
}

test("activates exactly a clean frozen selection and reads authority back", async () => {
	const f = fixture();
	const receipts = await activateAll(
		f.report,
		f.stores,
		"fixture:report",
		Scope.parse("fixture/two"),
		now,
	);
	expect(receipts).toEqual([
		{
			organizationId: "fixture",
			workspaceId: "two",
			receipt: { importGeneration: 3, reconciliationRef: "fixture:report" },
		},
	]);
	expect(f.activated).toEqual(["two"]);
});

for (const change of [
	(r: ReconcileReport) => {
		r.ok = false;
	},
	(r: ReconcileReport) => {
		r.problems.push("coverage missing");
	},
	(r: ReconcileReport) => {
		delete r.freeze;
	},
	(r: ReconcileReport) => {
		r.totals = [];
	},
	(r: ReconcileReport) => {
		r.checkedAt = "2026-11-11T00:00:00Z";
	},
	(r: ReconcileReport) => {
		r.workspaces[1]!.ok = false;
	},
	(r: ReconcileReport) => {
		r.workspaces[1]!.expectedRereads.push({
			table: "os_outputs",
			key: "x",
			reason: "pending",
		});
	},
	(r: ReconcileReport) => {
		delete r.workspaces[1]!.importGeneration;
	},
])
	test("refuses incomplete evidence before activating any workspace", async () => {
		const f = fixture();
		change(f.report);
		await expect(
			activateAll(f.report, f.stores, "fixture:report", undefined, now),
		).rejects.toThrow();
		expect(f.activated).toEqual([]);
	});

test("preflights every generation before the first activation", async () => {
	const f = fixture();
	f.descriptions.get("two")!.importGeneration = 4;
	await expect(
		activateAll(f.report, f.stores, "fixture:report", undefined, now),
	).rejects.toThrow("Import changed");
	expect(f.activated).toEqual([]);
});

test("server fence rejects an import racing the activation", async () => {
	const f = fixture();
	f.race();
	await expect(
		activateAll(f.report, f.stores, "fixture:report", undefined, now),
	).rejects.toThrow("Import changed");
	expect(f.activated).toEqual([]);
});

test("remote activation uses the scoped authenticated admin route", async () => {
	let called = false;
	const request = { importGeneration: 3, reconciliationRef: "fixture:report" };
	const store = new RemoteWorkspaceStore(
		"https://fixture.invalid",
		{
			mode: "tedix",
			headers: async () => ({ Authorization: "Bearer fixture" }),
		},
		{ organizationId: "fixture", workspaceId: "one" },
		(async (url, init) => {
			expect(String(url)).toBe(
				"https://fixture.invalid/admin/migration/workspaces/fixture/one/activate",
			);
			expect(init?.method).toBe("POST");
			expect(JSON.parse(String(init?.body))).toEqual(request);
			called = true;
			return Response.json(request);
		}) as typeof fetch,
	);
	expect(await store.activate(request)).toEqual(request);
	expect(called).toBe(true);
});

test("preserves clean pre-existing object owners without a new activation", async () => {
	const f = fixture();
	f.report.workspaces[0]!.outputAuthority = "object";
	f.report.workspaces[0]!.importGeneration = 0;
	f.descriptions.get("one")!.outputAuthority = "object";
	f.descriptions.get("one")!.importGeneration = 0;
	const retained: unknown[] = [];
	const receipts = await activateAll(
		f.report,
		f.stores,
		"fixture:report",
		undefined,
		now,
		(r) => retained.push(r),
	);
	expect(f.activated).toEqual(["two"]);
	expect(receipts[0]!.receipt).toEqual({
		status: "already_object_owned",
		importGeneration: 0,
	});
	expect(retained).toEqual(receipts);
});

test("retains the first receipt when a later workspace activation fails", async () => {
	const f = fixture();
	const retained: unknown[] = [];
	await expect(
		activateAll(f.report, f.stores, "fixture:report", undefined, now, (r) => {
			retained.push(r);
			f.race();
		}),
	).rejects.toThrow("Import changed");
	expect(f.activated).toEqual(["one"]);
	expect(retained).toHaveLength(1);
});

test("CLI validates frozen evidence before HTTP and writes activation receipts", async () => {
	const dir = mkdtempSync(join(tmpdir(), "activate-cli-"));
	const input = join(dir, "reconcile.json");
	const output = join(dir, "receipts.json");
	const f = fixture();
	const actualNow = new Date();
	f.report.checkedAt = actualNow.toISOString();
	f.report.freeze!.frozenAt = new Date(
		actualNow.getTime() - 1000,
	).toISOString();
	let calls = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			calls += 1;
			expect(request.headers.get("authorization")).toBe("Bearer fixture");
			const path = new URL(request.url).pathname.split("/");
			const current = f.descriptions.get(path[4]!)!;
			if (path[5] === "activate") {
				const body = (await request.json()) as {
					importGeneration: number;
					reconciliationRef: string;
				};
				expect(body.importGeneration).toBe(current.importGeneration!);
				current.outputAuthority = "object";
				return Response.json(body);
			}
			return Response.json(current);
		},
	});
	const args = [
		"activate",
		"--reconciliation",
		input,
		"--reconciliation-ref",
		"fixture:report",
		"--remote",
		server.url.toString(),
	];
	try {
		await expect(
			main(args, { MIGRATE_WORKSPACES_TOKEN: "fixture" }, () => {}),
		).rejects.toThrow("--report is required");
		writeFileSync(input, JSON.stringify({ ...f.report, ok: false }));
		await expect(
			main(
				[...args, "--report", output],
				{ MIGRATE_WORKSPACES_TOKEN: "fixture" },
				() => {},
			),
		).rejects.toThrow("clean frozen reconciliation");
		expect(calls).toBe(0);
		expect(existsSync(output)).toBe(false);
		writeFileSync(input, JSON.stringify(f.report));
		expect(
			await main(
				[...args, "--report", output],
				{ MIGRATE_WORKSPACES_TOKEN: "fixture" },
				() => {},
			),
		).toBe(0);
		const receipts = JSON.parse(readFileSync(output, "utf8")) as Array<{
			workspaceId: string;
		}>;
		expect(receipts.map((r) => r.workspaceId)).toEqual(["one", "two"]);
		expect(calls).toBe(6);
	} finally {
		server.stop(true);
		rmSync(dir, { recursive: true, force: true });
	}
});
