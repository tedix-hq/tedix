import { describe, expect, it, vi } from "vite-plus/test";
import {
	authenticateCollabPresence,
	collabIdentityFromPayload,
} from "./worker-presence";

describe("collaboration Worker presence", () => {
	it("derives a tenant-bound human identity without exposing raw claims", async () => {
		const identity = await collabIdentityFromPayload(
			{
				sub: "user-secret",
				dct: "tenant-a",
				name: "Ada Lovelace",
				email: "ada@example.com",
				roles: ["owner"],
			},
			"tenant-a",
		);
		expect(identity).toMatchObject({
			displayName: "Ada Lovelace",
			kind: "human",
			role: "owner",
			verified: true,
		});
		expect(identity?.key).toMatch(/^p_[a-f0-9]{32}$/);
		expect(JSON.stringify(identity)).not.toContain("user-secret");
		expect(JSON.stringify(identity)).not.toContain("ada@example.com");
	});

	it("classifies tedis and external agents as operators", async () => {
		await expect(
			collabIdentityFromPayload(
				{
					sub: "descope-user",
					dct: "tenant-a",
					entityType: "tedi",
					tediId: "tedi-cto",
					name: "CTO",
				},
				"tenant-a",
			),
		).resolves.toMatchObject({ kind: "tedi", role: "operator" });
		await expect(
			collabIdentityFromPayload(
				{
					sub: "service",
					client_id: "agent-client",
				},
				"tenant-a",
			),
		).resolves.toMatchObject({
			displayName: "External agent",
			kind: "external_agent",
			role: "operator",
		});
	});

	it("accepts a verified external-agent access key after Workspace authorization", async () => {
		const verify = vi.fn().mockResolvedValue({
			sub: "service",
			client_id: "agent-client",
		});
		await expect(
			authenticateCollabPresence(
				new Request("https://tenant.os.tedix.dev/collab/w", {
					headers: { "X-API-Key": "sk_external" },
				}),
				"project",
				"tenant-a",
				verify,
			),
		).resolves.toMatchObject({ kind: "external_agent", role: "operator" });
		expect(verify).toHaveBeenCalledWith("sk_external", {
			projectId: "project",
			allowTediJwt: true,
		});
	});

	it("uses the Worker-verified browser session after cookie normalization", async () => {
		const verify = vi.fn().mockResolvedValue({
			sub: "user-1",
			dct: "tenant-a",
		});
		await expect(
			authenticateCollabPresence(
				new Request("https://tenant.os.tedix.dev/collab/w", {
					headers: { Cookie: "DS=canonicalized" },
				}),
				"project",
				"tenant-a",
				verify,
				"verified-browser-session",
			),
		).resolves.toMatchObject({ kind: "human", verified: true });
		expect(verify).toHaveBeenCalledWith("verified-browser-session", {
			projectId: "project",
			allowTediJwt: true,
		});
	});

	it("fails closed on tenant mismatch and invalid JWTs", async () => {
		await expect(
			collabIdentityFromPayload({ sub: "u", dct: "tenant-b" }, "tenant-a"),
		).resolves.toBeNull();
		const verify = vi.fn().mockRejectedValue(new Error("invalid"));
		await expect(
			authenticateCollabPresence(
				new Request("https://tenant.os.tedix.dev/collab/w", {
					headers: { Authorization: "Bearer invalid" },
				}),
				"project",
				"tenant-a",
				verify,
			),
		).resolves.toBeNull();
	});
});
