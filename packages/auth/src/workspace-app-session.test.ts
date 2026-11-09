import { describe, expect, it, vi } from "vite-plus/test";
import {
	mintWorkspaceAppSession,
	mintAppCallGrant,
	verifyAppCallGrant,
	verifyWorkspaceAppSession,
	type WorkspaceAppSession,
} from "./workspace-app-session";

const secret = "fictional-session-test-key";
const identity: WorkspaceAppSession = {
	organizationId: "fictional-org",
	workspaceId: "11111111-1111-4111-8111-111111111111",
	gadgetId: "22222222-2222-4222-8222-222222222222",
	revisionId: "33333333-3333-4333-8333-333333333333",
	revision: 1,
	principal: { kind: "user", id: "fictional-member" },
	role: "use",
	grants: [{ slot: "sheet", operations: ["outputs.read"] }],
	codeDigest: "abc",
};
describe("workspace app sessions", () => {
	it("signs the tenant, app, revision, caller, role and exact grants", async () => {
		const { token, expiresAt } = await mintWorkspaceAppSession(
			secret,
			identity,
		);
		expect(await verifyWorkspaceAppSession(secret, token)).toMatchObject({
			...identity,
			expiresAt,
		});
		await expect(
			verifyWorkspaceAppSession("wrong-key", token),
		).rejects.toThrow();
		const [header, payload, signature] = token.split(".");
		const forged = btoa(
			JSON.stringify({
				...JSON.parse(atob(payload!)),
				app: { ...identity, role: "build" },
			}),
		)
			.replaceAll("+", "-")
			.replaceAll("/", "_")
			.replace(/=+$/, "");
		await expect(
			verifyWorkspaceAppSession(secret, `${header}.${forged}.${signature}`),
		).rejects.toThrow();
	});
	it("expires after five minutes and fails closed without a signing key", async () => {
		const { token, expiresAt } = await mintWorkspaceAppSession(
			secret,
			identity,
		);
		vi.useFakeTimers();
		try {
			vi.setSystemTime((expiresAt + 1) * 1000);
			await expect(verifyWorkspaceAppSession(secret, token)).rejects.toThrow();
		} finally {
			vi.useRealTimers();
		}
		await expect(mintWorkspaceAppSession("", identity)).rejects.toThrow();
	});
});

describe("app call grants", () => {
	it("vouch only for the session they were minted for, within a minute", async () => {
		const grant = {
			sessionId: "session-1",
			role: "use" as const,
			revisionId: identity.revisionId,
		};
		const token = await mintAppCallGrant(secret, grant);
		expect(await verifyAppCallGrant(secret, token, "session-1")).toEqual(grant);
		expect(await verifyAppCallGrant(secret, token, "session-2")).toBeNull();
		expect(
			await verifyAppCallGrant("another-key", token, "session-1"),
		).toBeNull();
		const { token: appSession } = await mintWorkspaceAppSession(
			secret,
			identity,
		);
		expect(
			await verifyAppCallGrant(secret, appSession, "session-1"),
		).toBeNull();
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			vi.setSystemTime(Date.now() + 61_000);
			expect(await verifyAppCallGrant(secret, token, "session-1")).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});
});
