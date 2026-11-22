import { afterEach, expect, it, vi } from "vite-plus/test";
import { osQueryClient } from "./router";

vi.mock("@/routeTree.gen", async () => {
	const { createRootRoute } = await import("@tanstack/react-router");
	return { routeTree: createRootRoute() };
});
vi.mock("@/components/os-route-boundaries", () => ({
	OsRouteError: () => null,
	OsRoutePending: () => null,
}));

afterEach(() => {
	osQueryClient.clear();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

it.each(["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND", "BAD_REQUEST", "CONFLICT"])(
	"does not retry a %s read with the global defaults",
	async (code) => {
		const error = { code };
		const read = vi.fn().mockRejectedValue(error);
		await expect(
			osQueryClient.fetchQuery({ queryKey: ["failed-read"], queryFn: read }),
		).rejects.toBe(error);
		expect(read).toHaveBeenCalledTimes(1);
	},
);

it("retries a 503 read twice with jittered backoff", async () => {
	vi.useFakeTimers();
	vi.spyOn(Math, "random").mockReturnValue(0.5);
	const error = { code: "SERVICE_UNAVAILABLE", status: 503 };
	const attempts: number[] = [];
	const start = Date.now();
	const result = osQueryClient
		.fetchQuery({
			queryKey: ["unavailable-read"],
			queryFn: () => {
				attempts.push(Date.now() - start);
				throw error;
			},
		})
		.catch((failure: unknown) => failure);
	await vi.advanceTimersByTimeAsync(4500);
	expect(await result).toBe(error);
	expect(attempts).toEqual([0, 1500, 4500]);
});
