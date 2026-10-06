import { afterEach, expect, it, vi } from "vite-plus/test";
import { runAlwaysOnKeepalive, sweepOrphanRunsTick } from "./platform-tick";

const fixtures = vi.hoisted(() => ({
	getAlwaysOnTedis: vi.fn(),
	sweepOrphanRuns: vi.fn(),
}));

vi.mock("@tedix/db/client", () => ({ createDbClient: () => ({}) }));
vi.mock("@tedix/db/queries/tedis", () => ({
	getAlwaysOnTedis: fixtures.getAlwaysOnTedis,
}));
vi.mock("../rpc/routers/cognitive-runtime/recovery-artifacts", () => ({
	sweepOrphanRuns: fixtures.sweepOrphanRuns,
}));
vi.mock("../rpc/routers/kernel/run-store", () => ({
	propagateSweptChildFailureToHomeRun: vi.fn(),
}));

afterEach(() => {
	vi.restoreAllMocks();
	fixtures.getAlwaysOnTedis.mockReset();
	fixtures.sweepOrphanRuns.mockReset();
});

it("logs wake status and exception topology without the response or thrown text", async () => {
	fixtures.getAlwaysOnTedis.mockResolvedValue([{ slug: "cto" }]);
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "log").mockImplementation(() => {});
	const waitUntil: Promise<unknown>[] = [];
	let wakeCount = 0;
	const env = {
		DB: {},
		TEDI_SERVICE: {
			fetch: vi.fn(async () => {
				wakeCount += 1;
				if (wakeCount === 1) return new Response(null, { status: 503 });
				if (wakeCount === 2) {
					return new Response("token=secret-in-response", { status: 502 });
				}
				throw new TypeError("token=secret-in-exception");
			}),
		},
	} as unknown as CloudflareEnv;
	const context = {
		waitUntil: (promise: Promise<unknown>) => waitUntil.push(promise),
	} as unknown as ExecutionContext;

	await runAlwaysOnKeepalive(env, context);
	await Promise.all(waitUntil);
	expect(warn).toHaveBeenCalledWith(
		"[Scheduled] alwaysOn-keepalive: wake cto → 502",
	);
	expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-in-response");

	await runAlwaysOnKeepalive(env, context);
	await Promise.all(waitUntil);
	expect(warn).toHaveBeenCalledWith(
		"[Scheduled] alwaysOn-keepalive: wake cto failed",
		{ type: "TypeError" },
	);
	expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-in-exception");
});

it("retains orphan sweep counts without logging returned error strings", async () => {
	fixtures.sweepOrphanRuns.mockResolvedValue({
		swept: 0,
		skipped: 1,
		errors: ["SQL token=secret-from-sweep"],
		propagatedRunIds: [],
		sweptRunIds: [],
	});
	const log = vi.spyOn(console, "log").mockImplementation(() => {});
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

	const result = await sweepOrphanRunsTick({ DB: {} } as CloudflareEnv);

	expect(result).toEqual({ swept: 0, skipped: 1, errors: 1 });
	expect(JSON.stringify(log.mock.calls)).toContain("errors=1");
	expect(JSON.stringify([log.mock.calls, warn.mock.calls])).not.toContain(
		"secret-from-sweep",
	);
});
