/**
 * The scoped reads ARE the memory bound. Nothing else in this change reduces
 * peak memory: batching the writes alone would still load every `app_tools` row
 * for the whole admin app on every batch, which is ~3 MB of schema/config JSON
 * and the thing that OOMed the unscoped run in the first place.
 *
 * They were covered by nothing. The db fake in `tool-schema-sync-batching.test.ts`
 * returns the whole store from `select().from().where().orderBy()`, discarding
 * the WHERE, so swapping `listToolsForSchemaSyncScoped` back to the unscoped
 * `listToolsForSchemaSync` left the entire suite green — the "prunes only
 * within its own batch" tests pass through the in-memory `onlyToolIds` filter
 * instead. Behaviour is equivalent either way, which is exactly why a
 * behavioural test cannot see the difference: the property at stake is WHICH
 * ROWS ARE READ, not which rows are written.
 *
 * So this asserts the read itself, at the module boundary.
 */

import { beforeAll, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
	listToolsForSchemaSync: vi.fn(async () => []),
	listToolsForSchemaSyncScoped: vi.fn(async () => []),
}));

vi.mock("@tedix/db/queries/tools", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/db/queries/tools")>()),
	listToolsForSchemaSync: mocks.listToolsForSchemaSync,
	listToolsForSchemaSyncScoped: mocks.listToolsForSchemaSyncScoped,
}));

const { runToolSchemaSync } = await import("./tool-schema-sync");

/** Minimal db surface: every read this path performs is mocked above. */
function db() {
	return {
		select: () => ({
			from: () => ({ where: () => ({ orderBy: async () => [] }) }),
		}),
		query: {
			apps: { findFirst: async () => ({ id: "app-1", slug: "tedix" }) },
			appTools: { findFirst: async () => undefined },
		},
	} as never;
}

async function run(options: Record<string, unknown>) {
	vi.clearAllMocks();
	mocks.listToolsForSchemaSync.mockResolvedValue([]);
	mocks.listToolsForSchemaSyncScoped.mockResolvedValue([]);
	await runToolSchemaSync(db(), options as never, undefined as never);
}

describe("a scoped batch reads only its own rows", () => {
	// Warm the expensive fixture once, outside any assertion body. `runToolSchemaSync` walks the router on its first call.
	// Paying that inside whichever `it()` runs first puts it under vitest's 5s
	// default, so under CPU contention — a shared CI runner, or a busy laptop —
	// the test times out and reports as a failure of the assertion rather than
	// of the fixture.
	beforeAll(async () => {
		// `run()` clears mocks before each assertion, so this warm-up cannot
		// leak into the call-count expectations below.
		await run({ mode: "projection", apply: false });
	}, 120_000);

	it("projection mode with endpoints uses the SCOPED read, never the full-table one", async () => {
		await run({
			mode: "projection",
			apply: false,
			endpoints: ["osWorkspaces/workspaces/create"],
		});

		expect(mocks.listToolsForSchemaSyncScoped).toHaveBeenCalledTimes(1);
		// The whole point: the unscoped read must not run for a scoped batch.
		expect(mocks.listToolsForSchemaSync).not.toHaveBeenCalled();

		const scope = mocks.listToolsForSchemaSyncScoped.mock.calls[0]?.[2] as {
			endpoints?: string[];
			toolIds?: string[];
		};
		// Both lookup keys `runToolProjectionSync` matches on must be scoped, or
		// the read silently misses an existing row and creates a duplicate.
		expect(scope.endpoints?.length).toBeGreaterThan(0);
		expect(Array.isArray(scope.toolIds)).toBe(true);
	});

	it("schema mode with toolIds uses the SCOPED read", async () => {
		await run({ mode: "schema", apply: false, toolIds: ["get_os_workspace"] });

		expect(mocks.listToolsForSchemaSyncScoped).toHaveBeenCalledTimes(1);
		expect(mocks.listToolsForSchemaSync).not.toHaveBeenCalled();
		const scope = mocks.listToolsForSchemaSyncScoped.mock.calls[0]?.[2] as {
			toolIds?: string[];
		};
		expect(scope.toolIds).toEqual(["get_os_workspace"]);
	});

	it("an UNSCOPED run still reads the full table — scoping must not leak into it", async () => {
		// The fallback matters: a plan-less manual run has no batch to scope to,
		// and silently reading nothing would report a no-op success.
		await run({ mode: "projection", apply: false });

		expect(mocks.listToolsForSchemaSync).toHaveBeenCalledTimes(1);
		expect(mocks.listToolsForSchemaSyncScoped).not.toHaveBeenCalled();
	});
});
