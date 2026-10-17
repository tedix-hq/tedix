import { describe, expect, it, vi } from "vite-plus/test";
import {
	mintTediConsoleSession,
	verifyTediConsoleSession,
} from "./tedi-console-session";
const key = "fictional-console-test-key";
const identity = {
	tediId: "atlas",
	organizationId: "acme",
	grantRevision: "revision-one",
};
describe("restricted console credential", () => {
	it("binds the tedi, tenant and grant revision", async () => {
		const token = await mintTediConsoleSession(
			key,
			identity,
			Math.floor(Date.now() / 1000) + 300,
		);
		expect(token.startsWith("tcs_")).toBe(true);
		expect(await verifyTediConsoleSession(key, token)).toEqual(identity);
		await expect(
			verifyTediConsoleSession("other-key", token),
		).rejects.toThrow();
		await expect(
			verifyTediConsoleSession(key, token + "bad"),
		).rejects.toThrow();
		await expect(
			verifyTediConsoleSession(key, token.slice(4)),
		).rejects.toThrow();
	});
	it("rejects excessive and expired lifetimes", async () => {
		const now = Math.floor(Date.now() / 1000);
		await expect(
			mintTediConsoleSession(key, identity, now + 301),
		).rejects.toThrow();
		await expect(mintTediConsoleSession(key, identity, now)).rejects.toThrow();
		const token = await mintTediConsoleSession(key, identity, now + 60);
		vi.useFakeTimers();
		try {
			vi.setSystemTime((now + 61) * 1000);
			await expect(verifyTediConsoleSession(key, token)).rejects.toThrow();
		} finally {
			vi.useRealTimers();
		}
	});
});
