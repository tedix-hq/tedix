import { createRouterClient } from "@orpc/server";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import type { BaseContext } from "../../orpc";

const mocks = vi.hoisted(() => ({
	getCatalogAppsNeedingScan: vi.fn(),
	getCatalogScanBacklogSummary: vi.fn(),
}));
vi.mock("@tedix/db/queries/catalog/health-metrics", async (load) => ({
	...(await load<typeof import("@tedix/db/queries/catalog/health-metrics")>()),
	...mocks,
}));

import { triggerScanCatalog } from "./tenant-install";

const appIds = [
	"00000000-0000-4000-8000-000000000001",
	"00000000-0000-4000-8000-000000000002",
];
const db = {} as BaseContext["db"];

function client(create?: ReturnType<typeof vi.fn>) {
	return createRouterClient(
		{ triggerScan: triggerScanCatalog },
		{
			context: {
				db,
				env: {
					ENVIRONMENT: "test",
					TEDIX_FLEET_AUTHORITY_MODE: "co-located",
					DB: {},
					...(create ? { MCP_SCAN_WORKFLOW: { create } } : {}),
				},
				organizationId: "00000000-0000-4000-8000-000000000003",
				headers: new Headers({
					"X-Service-Binding": "true",
					"X-Tedix-Tedi-Scopes": "catalog:manage",
				}),
				url: new URL("https://api.example.test/rpc/catalog/triggerScan"),
			} as BaseContext,
		},
	);
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.getCatalogAppsNeedingScan.mockResolvedValue(
		appIds.map((id) => ({ id })),
	);
	mocks.getCatalogScanBacklogSummary.mockResolvedValue({
		skippedRequiresAuth: 0,
		skippedBlocked: 0,
	});
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe.each(["targeted", "discovered"] as const)(
	"%s catalog scans",
	(mode) => {
		function input() {
			return {
				limit: mode === "targeted" ? 1 : 10,
				maxAgeHours: 48,
				...(mode === "targeted" ? { catalogAppIds: appIds } : {}),
			};
		}

		it("reports no scans started when the workflow binding is unavailable", async () => {
			const result = await client().triggerScan(input());
			expect(result).toEqual({
				success: false,
				appsQueued: 0,
				workflowInstanceId: undefined,
				message:
					"Scans did not start because the scan workflow is unavailable. Contact an operator to configure it and retry.",
			});
			expect(console.warn).toHaveBeenCalledWith(
				"[Catalog] MCP_SCAN_WORKFLOW binding not available",
			);
		});

		it.each([
			new Error("internal startup failure: token=fixture-private-token"),
			"internal startup failure: token=fixture-private-token",
		])("keeps startup diagnostics in server logging (%s)", async (error) => {
			const create = vi.fn().mockRejectedValue(error);
			const result = await client(create).triggerScan(input());
			expect(result).toEqual({
				success: false,
				appsQueued: 0,
				workflowInstanceId: undefined,
				message: "Scans did not start. Please retry or contact an operator.",
			});
			expect(JSON.stringify(result)).not.toContain("fixture-private-token");
			expect(console.error).toHaveBeenCalledWith(
				"[Catalog] Failed to start MCP scan workflow:",
				error,
			);
			expect(create).toHaveBeenCalledTimes(1);
		});

		it("returns the created workflow receipt and the actual queued count", async () => {
			const create = vi.fn().mockResolvedValue({ id: "scan-fixture-instance" });
			expect(await client(create).triggerScan(input())).toEqual({
				success: true,
				appsQueued: 2,
				workflowInstanceId: "scan-fixture-instance",
				message: "MCP scan workflow started for 2 apps",
			});
			expect(create).toHaveBeenCalledExactlyOnceWith({
				params: { limit: 2, maxAgeHours: 48, catalogAppIds: appIds },
			});
			if (mode === "targeted") {
				expect(mocks.getCatalogAppsNeedingScan).not.toHaveBeenCalled();
			} else {
				expect(mocks.getCatalogAppsNeedingScan).toHaveBeenCalledWith(db, {
					limit: 10,
					maxAgeHours: 48,
					catalogAppIds: undefined,
				});
			}
			expect(mocks.getCatalogScanBacklogSummary).not.toHaveBeenCalled();
		});
	},
);

it.each([false, true])(
	"preserves empty-backlog success with workflow available=%s",
	async (available) => {
		mocks.getCatalogAppsNeedingScan.mockResolvedValue([]);
		const create = vi.fn();
		const result = await client(available ? create : undefined).triggerScan({});
		expect(result).toEqual({
			success: true,
			appsQueued: 0,
			workflowInstanceId: undefined,
			message:
				"No actionable apps need scans at this time; 0 auth-gated and 0 blocked app(s) are intentionally skipped until their weekly cadence or auth state changes",
		});
		expect(mocks.getCatalogScanBacklogSummary).toHaveBeenCalledWith(db, {
			maxAgeHours: 24,
		});
		expect(create).not.toHaveBeenCalled();
		expect(console.warn).not.toHaveBeenCalled();
		expect(console.error).not.toHaveBeenCalled();
	},
);
