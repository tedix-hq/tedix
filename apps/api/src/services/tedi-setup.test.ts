import { describe, expect, it } from "vite-plus/test";
import { deriveTediSetup, type SetupConfig } from "./tedi-setup";

const tool = {
	id: "tool-1",
	appId: "app-1",
	toolId: "read_mail",
	title: "Read mail",
	enabled: true,
	config: {
		auth: { type: "connection", connectionId: "mail", scopes: ["read"] },
	},
};
const config = (): SetupConfig => ({
	tediId: "worker",
	tools: [tool],
	assignedAppIds: ["app-1"],
	skills: [],
	accounts: [],
	assignmentsComplete: true,
});

describe("tedi setup derivation", () => {
	it("derives missing credentials from assigned tool config, with an exact provider link", () => {
		const result = deriveTediSetup(config());
		expect(result.items).toContainEqual(
			expect.objectContaining({
				kind: "connection",
				state: "missing",
				href: "/admin/connections?connect=mail&scopes=read",
				label: "mail",
			}),
		);
		expect(deriveTediSetup({ ...config(), assignedAppIds: [] }).items).toEqual(
			[],
		);
	});
	it("only marks the exact account and required scopes ready", () => {
		const base = {
			...config(),
			accounts: [
				{
					providerId: "mail",
					scope: "tenant" as const,
					instanceId: null,
					state: "present" as const,
					connected: true,
					scopes: ["read"],
				},
			],
		};
		expect(deriveTediSetup(base).items.every((x) => x.state === "ready")).toBe(
			true,
		);
		expect(
			deriveTediSetup({
				...base,
				accounts: [{ ...base.accounts[0]!, scopes: [] }],
			}).items.find((x) => x.kind === "connection")?.state,
		).toBe("needs_you");
		expect(
			deriveTediSetup({
				...base,
				tools: [
					{
						...tool,
						config: {
							auth: {
								type: "connection",
								connectionId: "mail",
								connectionInstanceId: "other",
							},
						},
					},
				],
			}).items.find((x) => x.kind === "connection")?.state,
		).toBe("missing");
	});
	it("does not confuse personal credentials, expired tokens or unavailable checks with readiness", () => {
		for (const state of ["unknown", "restricted", "expired"] as const) {
			const r = deriveTediSetup({
				...config(),
				accounts: [
					{
						providerId: "mail",
						scope: "tenant",
						instanceId: null,
						state,
						connected: false,
						scopes: [],
					},
				],
			});
			expect(r.items.find((x) => x.kind === "connection")?.state).toBe(
				"needs_you",
			);
		}
		expect(
			deriveTediSetup({
				...config(),
				accounts: [
					{
						providerId: "mail",
						scope: "user",
						instanceId: null,
						state: "present",
						connected: true,
						scopes: ["read"],
					},
				],
			}).items.find((x) => x.kind === "connection")?.state,
		).toBe("missing");
	});
	it("shows build still owed for absent skill tools, disabled tools as missing, and human preconditions", () => {
		const r = deriveTediSetup({
			...config(),
			assignedAppIds: [],
			tools: [{ ...tool, enabled: false }],
			skills: [
				{
					id: "skill-1",
					title: "Inbox",
					slug: "inbox",
					toolIds: ["tool-1", "unbuilt"],
					requires: ["owner approval"],
				},
			],
		});
		expect(r.items).toContainEqual(
			expect.objectContaining({
				kind: "build",
				state: "missing",
				label: "Build still owed: unbuilt",
			}),
		);
		expect(r.items).toContainEqual(
			expect.objectContaining({
				kind: "tool",
				state: "missing",
				label: "Read mail",
			}),
		);
		expect(r.items).toContainEqual(
			expect.objectContaining({
				kind: "human",
				state: "needs_you",
				href: "/skills/skill-1",
				label: "owner approval",
			}),
		);
		for (const item of r.items.filter((x) => x.state !== "ready"))
			expect(item.href).toMatch(/^\//);
	});
	it("does not report ready when assignment verification is incomplete", () => {
		expect(
			deriveTediSetup({ ...config(), tools: [], assignmentsComplete: false })
				.items,
		).toContainEqual(
			expect.objectContaining({ state: "needs_you", kind: "human" }),
		);
	});
	it("keeps required scopes visible when configured groups do not cover a tool", () => {
		const result = deriveTediSetup({
			...config(),
			accounts: [
				{
					providerId: "mail",
					scope: "tenant",
					instanceId: null,
					state: "present",
					connected: true,
					scopes: ["other"],
					capabilities: [
						{
							id: "other",
							label: "Other",
							requiredScopes: ["other"],
							state: "connected",
							verified: true,
							setupUrl: "/admin/connections?connect=mail",
						},
					],
				},
			],
		});
		const connection = result.items.find((item) => item.kind === "connection")!;
		expect(connection.capabilities).toEqual([
			expect.objectContaining({
				id: "required-access",
				requiredScopes: ["read"],
				state: "needs_reauth",
			}),
		]);
		for (const capability of connection.capabilities ?? []) {
			if (capability.state === "connected") continue;
			const url = new URL(capability.setupUrl, "https://example.test");
			expect(url.searchParams.get("connect")).toBe("mail");
			expect(url.searchParams.get("scopes")).toBe("read");
		}
	});
});
