import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createAppRuntimeServerCall } from "./app-runtime-session";

const scope = {
	workspaceId: "workspace",
	gadgetId: "gadget",
	revisionId: "revision-1",
};
function fixture() {
	const api = {
		open: vi.fn(async () => ({
			session: "signed",
			revisionId: scope.revisionId,
			role: "use" as const,
			expiresAt: Math.floor(Date.now() / 1000) + 60,
		})),
		call: vi.fn(async () => ({ result: { decision: "Hilfreich" } })),
	};
	return { api, call: createAppRuntimeServerCall(api, scope) };
}
afterEach(() => vi.useRealTimers());
describe("app runtime session", () => {
	it("shares opening across concurrent calls and keeps the signed session in the host", async () => {
		const { api, call } = fixture();
		expect(
			await Promise.all([
				call("ratings", []),
				call("rate", [{ cardId: "one" }]),
			]),
		).toEqual([{ decision: "Hilfreich" }, { decision: "Hilfreich" }]);
		expect(api.open).toHaveBeenCalledTimes(1);
		expect(api.call).toHaveBeenLastCalledWith({
			workspaceId: scope.workspaceId,
			gadgetId: scope.gadgetId,
			session: "signed",
			method: "rate",
			args: [{ cardId: "one" }],
		});
	});
	it("refuses a session for a different revision before executing", async () => {
		const { api, call } = fixture();
		api.open.mockResolvedValueOnce({
			session: "other",
			revisionId: "revision-2",
			role: "use",
			expiresAt: Date.now() / 1000 + 60,
		});
		await expect(call("rate", [])).rejects.toThrow("revision changed");
		expect(api.call).not.toHaveBeenCalled();
	});
	it("renews an expiring session before the next call", async () => {
		vi.useFakeTimers();
		const { api, call } = fixture();
		await call("ratings", []);
		vi.advanceTimersByTime(56000);
		await call("ratings", []);
		expect(api.open).toHaveBeenCalledTimes(2);
	});
	it("allows a later open after failure but never replays a failed mutation", async () => {
		const { api, call } = fixture();
		api.open.mockRejectedValueOnce(new Error("Unavailable"));
		await expect(call("ratings", [])).rejects.toThrow("Unavailable");
		api.call.mockRejectedValueOnce(new Error("Response lost"));
		await expect(call("rate", [])).rejects.toThrow("Response lost");
		expect(api.open).toHaveBeenCalledTimes(2);
		expect(api.call).toHaveBeenCalledTimes(1);
	});
});
