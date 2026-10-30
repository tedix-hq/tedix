import { describe, expect, it } from "vite-plus/test";
import { providerIdentityDigest } from "./provider-identity-probe";

const profile = {
	version: 1 as const,
	operation: "read_identity",
	selectors: [
		["account", "id"],
		["workspace", "id"],
	],
};
const input = {
	profile,
	binding: "org:source:credential",
	secret: "test-only-secret",
	result: {
		structuredContent: {
			account: { id: "account-a" },
			workspace: { id: "workspace-a" },
		},
	},
};

describe("provider identity probe", () => {
	it("requires exact server-derived assertions on reviewed identity selectors", async () => {
		const assertion = { path: ["workspace", "id"], value: "workspace-a" };
		expect(
			await providerIdentityDigest({ ...input, assertions: [assertion] }),
		).toMatch(/^[a-f0-9]{64}$/);
		expect(
			await providerIdentityDigest({
				...input,
				assertions: [{ ...assertion, value: "other" }],
			}),
		).toBeNull();
		expect(
			await providerIdentityDigest({
				...input,
				assertions: [{ path: ["unreviewed"], value: "x" }],
			}),
		).toBeNull();
		expect(
			await providerIdentityDigest({
				...input,
				assertions: [assertion, assertion],
			}),
		).toBeNull();
	});
	it("binds the exact identity, profile and caller context without returning identity data", async () => {
		const digest = await providerIdentityDigest(input);
		expect(digest).toMatch(/^[a-f0-9]{64}$/);
		expect(digest).not.toContain("account-a");
		expect(
			await providerIdentityDigest({ ...input, binding: "other" }),
		).not.toBe(digest);
		expect(
			await providerIdentityDigest({
				...input,
				result: {
					structuredContent: {
						account: { id: "account-b" },
						workspace: { id: "workspace-a" },
					},
				},
			}),
		).not.toBe(digest);
		expect(
			await providerIdentityDigest({
				...input,
				profile: { ...profile, operation: "other_identity" },
			}),
		).not.toBe(digest);
	});

	it("rejects errors, unsafe selectors, ambiguous content and missing identity", async () => {
		for (const change of [
			{
				result: {
					isError: true,
					structuredContent: input.result.structuredContent,
				},
			},
			{ result: { structuredContent: { account: { id: "account-a" } } } },
			{
				result: {
					content: [
						{ type: "text", text: "{}" },
						{ type: "text", text: "{}" },
					],
				},
			},
			{ profile: { ...profile, selectors: [["constructor", "name"]] } },
			{
				profile: {
					...profile,
					selectors: [
						["account", "id"],
						["account", "id"],
					],
				},
			},
			{ secret: "" },
		])
			expect(await providerIdentityDigest({ ...input, ...change })).toBeNull();
	});
});
