import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { matchesTenantPolicyPredicate } from "@tedix/api-contract/utils/tenant-policy-predicate";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const h = vi.hoisted(() => ({
	prepareRule: vi.fn(),
	probeAccount: vi.fn(),
	prepareHybrid: vi.fn(),
	saveRule: vi.fn(),
	revokeRule: vi.fn(),
	prepareProfile: vi.fn(),
	saveProfile: vi.fn(),
	revokeProfile: vi.fn(),
	disableLegacy: vi.fn(),
	descriptor: {
		kind: "profile",
		actorUserId: "owner",
		profileId: "old-profile",
		profileDigest: "a".repeat(64),
		accountRevisionDigest: "b".repeat(64),
		mount: {
			version: 1,
			organizationId: "org",
			rootAppId: "root",
			mountAppIds: ["root"],
			sourceAppId: "root",
			sourceToolRowId: "row",
			sourceToolId: "write",
			mountedToolId: "write",
			transport: "mcp",
			upstreamOperation: "write",
			endpointDigest: "c".repeat(64),
			effectiveToolDigest: "d".repeat(64),
			authBindingDigest: "e".repeat(64),
			acceptsEmptyArguments: true,
			providerId: "example",
			connectionScope: "user",
			requestedScopes: [],
		},
	},
}));
vi.mock("@/components/kumo/select", async () => {
	const React = await import("react");
	return {
		Select: ({ children, value, onValueChange }: any) =>
			React.createElement(
				"select",
				{ value, onChange: (e: any) => onValueChange(e.target.value) },
				children,
			),
		SelectContent: ({ children }: any) => children,
		SelectItem: ({ children, value }: any) =>
			React.createElement("option", { value }, children),
		SelectTrigger: ({ children }: any) => children,
		SelectValue: () => null,
	};
});
vi.mock("@/components/kumo/switch", async () => {
	const React = await import("react");
	return {
		Switch: ({ checked, onCheckedChange }: any) =>
			React.createElement("input", {
				type: "checkbox",
				checked,
				onChange: (e: any) => onCheckedChange(e.target.checked),
			}),
	};
});
vi.mock("@/lib/api", () => ({
	osApi: {
		mcpGovernance: {
			prepareTenantToolPolicy: h.prepareRule,
			probeProviderIdentityProfile: h.probeAccount,
			prepareHybridTenantToolPolicy: h.prepareHybrid,
			createTenantToolPolicy: h.saveRule,
			revokeTenantToolPolicy: h.revokeRule,
			prepareProviderIdentityProfile: h.prepareProfile,
			createProviderIdentityProfile: h.saveProfile,
			revokeProviderIdentityProfile: h.revokeProfile,
			setActionTypeOptIn: h.disableLegacy,
		},
	},
}));
vi.mock("@/lib/os-query-options", () => {
	const query = (key: string, data: unknown) => ({
		queryOptions: () => ({ queryKey: [key], queryFn: async () => data }),
		key: () => [key],
	});
	return {
		osQuery: {
			mcpGovernance: {
				listDeletedTenantPolicyFences: query("deleted", {
					items: [
						{
							rootAppId: "root",
							mountedToolId: "write",
							revisionId: "deleted-rule",
							subjectKey: JSON.stringify(["user", "owner"]),
							sourceAppId: "source",
							sourceToolId: "write",
						},
						{
							rootAppId: "root",
							mountedToolId: "write",
							revisionId: "unknown-rule",
							sourceAppId: "source",
							sourceToolId: "write",
							subjectKey: null,
						},
					],
				}),
				listLegacyActionTypeInventory: query("legacy", {
					grants: [
						{
							grantId: "grant",
							actionType: "comment_on_issue",
							createdAt: "2026-01-01",
							reason: null,
						},
					],
					tools: [
						{
							appId: "app",
							appName: "Example",
							appSlug: "example",
							toolRowId: "row",
							toolId: "comment",
							title: "Comment",
							actionType: "comment_on_issue",
							enabled: true,
						},
					],
					truncated: false,
				}),
				listTenantToolPolicies: query("rules", {
					items: [
						{
							id: "old-rule",
							toolRowId: "t",
							revokedAt: null,
							mountDescriptor: h.descriptor,
							policySet: {
								evaluatorVersion: 1,
								defaultDisposition: "ask",
								rules: [
									{
										id: "one",
										predicate: {
											version: 1,
											schema: {
												type: "object",
												properties: {},
												required: [],
												additionalProperties: false,
											},
										},
										effect: {
											disposition: "ask",
											riskTier: "bounded_write",
											blastRadius: "single_resource",
										},
									},
								],
							},
						},
						{
							id: "revoked-rule",
							toolRowId: "t",
							revokedAt: "2026-01-01",
							mountDescriptor: h.descriptor,
							policySet: {
								evaluatorVersion: 1,
								defaultDisposition: "ask",
								rules: [
									{
										id: "one",
										predicate: {
											version: 1,
											schema: {
												type: "object",
												properties: {},
												required: [],
												additionalProperties: false,
											},
										},
										effect: {
											disposition: "ask",
											riskTier: "bounded_write",
											blastRadius: "single_resource",
										},
									},
								],
							},
						},
					],
				}),
				listProviderIdentityProfiles: query("profiles", {
					items: [
						{
							id: "old-profile",
							revokedAt: null,
							mount: {
								rootAppId: "root",
								mountedToolId: "write",
								providerId: "example",
								connectionScope: "tenant",
							},
							profile: { operation: "identity", selectors: [["id"]] },
						},
					],
				}),
				listMachineProviderProbes: query("proofs", { items: [] }),
				listMachinePolicyInventory: query("inventory", { items: [] }),
			},
			mcpServer: { previewToolScopes: query("tools", { toolScopes: {} }) },
		},
		appListQueryOptions: () => ({
			queryKey: ["apps"],
			queryFn: async () => ({ data: [{ id: "root", name: "Sample app" }] }),
		}),
	};
});
import { TenantToolPolicies } from "./tenant-tool-policies";
import { ProviderIdentityProfiles } from "./provider-identity-profiles";
import { LegacyActionGrants } from "./legacy-action-grants";
let dispose: (() => void) | undefined;
afterEach(() => {
	dispose?.();
	dispose = undefined;
	vi.clearAllMocks();
});
const flush = async () => {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 30));
	});
};
function mount(element: React.ReactNode) {
	const node = document.createElement("div");
	document.body.append(node);
	const root = createRoot(node);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	act(() =>
		root.render(
			<QueryClientProvider client={client}>{element}</QueryClientProvider>,
		),
	);
	dispose = () => {
		act(() => root.unmount());
		node.remove();
		client.clear();
	};
	return node;
}
function change(element: Element, value: string) {
	const proto =
		element instanceof HTMLTextAreaElement
			? HTMLTextAreaElement.prototype
			: element instanceof HTMLSelectElement
				? HTMLSelectElement.prototype
				: HTMLInputElement.prototype;
	const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
	act(() => {
		setter.call(element, value);
		element.dispatchEvent(
			new Event(element instanceof HTMLSelectElement ? "change" : "input", {
				bubbles: true,
			}),
		);
	});
}
function click(node: HTMLElement, label: string) {
	const button = [...node.querySelectorAll("button")].find(
		(el) => el.textContent?.trim() === label,
	);
	expect(button, label).toBeTruthy();
	act(() => button!.click());
}

async function reviewProfile(node: HTMLElement) {
	h.probeAccount.mockResolvedValue({
		resultReceiptId: "receipt",
		credentialSummary: { scope: "user" },
	});
	h.prepareHybrid.mockResolvedValue({
		preparationId: "receipt",
		descriptorDigest: "digest",
		descriptor: h.descriptor,
	});
	const select = [...node.querySelectorAll("select")].find((entry) =>
		[...entry.options].some((option) => option.value === "old-profile"),
	)!;
	change(select, "old-profile");
	click(node, "Verify account and review tool");
	await flush();
}

describe("policy owner interaction", () => {
	it("explains that saved rules can apply while other safeguards remain", async () => {
		const node = mount(<TenantToolPolicies canChange />);
		await flush();
		expect(node.textContent).toContain(
			"A saved rule can apply to matching calls",
		);
		expect(node.textContent).toContain(
			"Permissions and other safeguards still apply",
		);
		expect(node.textContent).not.toContain("not yet active in tool execution");
	});
	it("requires a fresh review to replace a deleted revision", async () => {
		h.prepareRule.mockResolvedValue({
			preparationId: "receipt",
			descriptorDigest: "digest",
			descriptor: {
				mountedToolId: "write",
				providerId: "example",
				upstreamOperation: "write",
			},
		});
		h.saveRule.mockResolvedValue({});
		const node = mount(<TenantToolPolicies canChange />);
		await flush();
		click(node, "Review a new rule for this tool");
		expect(node.textContent).toContain("The deleted rule is not restored");
		expect(h.saveRule).not.toHaveBeenCalled();
		await reviewProfile(node);
		click(node, "Save rule");
		await flush();
		expect(h.saveRule).toHaveBeenCalledWith(
			expect.objectContaining({
				expectedRevisionId: "deleted-rule",
				recoverDeleted: true,
			}),
		);
	});
	it("explicitly reviews recovery of a deleted fence with an unknown subject", async () => {
		h.saveRule.mockResolvedValue({});
		const node = mount(<TenantToolPolicies canChange />);
		await flush();
		expect(node.textContent).toContain("The prior subject is unknown");
		const cards = [...node.querySelectorAll("div")].filter(
			(item) =>
				item.textContent?.includes("The prior subject is unknown") &&
				item.querySelector("button"),
		);
		const card = cards.at(-1)!;
		click(card, "Review a new rule for this tool");
		await reviewProfile(node);
		click(node, "Save rule");
		expect(node.textContent).toContain(
			"Choose the current revision for this subject",
		);
		expect(h.saveRule).not.toHaveBeenCalled();
		const revisions = [...node.querySelectorAll("select")].find((entry) =>
			[...entry.options].some((option) => option.value === "old-rule"),
		)!;
		change(revisions, "old-rule");
		click(node, "Save rule");
		await flush();
		expect(h.saveRule).toHaveBeenCalledWith(
			expect.objectContaining({
				recoverUnknownRevisionId: "unknown-rule",
				recoverDeleted: true,
				expectedRevisionId: "old-rule",
			}),
		);
	});
	it.each([
		["revoked-rule", "revoked"],
		["deleted-rule", "deleted"],
	] as const)(
		"explicitly recovers unknown and %s subject fences",
		async (revisionId, mode) => {
			h.saveRule.mockResolvedValue({});
			const node = mount(<TenantToolPolicies canChange />);
			await flush();
			const card = [...node.querySelectorAll("div")]
				.filter(
					(item) =>
						item.textContent?.includes("The prior subject is unknown") &&
						item.querySelector("button"),
				)
				.at(-1)!;
			click(card, "Review a new rule for this tool");
			await reviewProfile(node);
			const select = [...node.querySelectorAll("select")].find((entry) =>
				[...entry.options].some((option) => option.value === revisionId),
			)!;
			change(select, revisionId);
			click(node, "Save rule");
			await flush();
			expect(h.saveRule).toHaveBeenCalledWith(
				expect.objectContaining({
					recoverUnknownRevisionId: "unknown-rule",
					recoverDeleted: true,
					expectedRevisionId: revisionId,
					subjectRecoveryMode: mode,
				}),
			);
		},
	);
	it("inventories the exact legacy grant and disables it only after explicit review", async () => {
		h.disableLegacy.mockResolvedValue({});
		const node = mount(<LegacyActionGrants canChange />);
		await flush();
		expect(node.textContent).toContain("grant");
		expect(node.textContent).toContain("Example (example)");
		expect(h.disableLegacy).not.toHaveBeenCalled();
		click(node, "Review turning off");
		expect(h.disableLegacy).not.toHaveBeenCalled();
		click(node, "Turn off legacy grant");
		await flush();
		expect(h.disableLegacy).toHaveBeenCalledWith({
			actionType: "comment_on_issue",
			enabled: false,
		});
	});
	it("re-reviews an edit and submits the exact previous revision", async () => {
		h.prepareRule.mockResolvedValue({
			preparationId: "receipt",
			descriptorDigest: "digest",
			descriptor: {
				mountedToolId: "write",
				providerId: "example",
				upstreamOperation: "write",
			},
		});
		h.saveRule.mockRejectedValueOnce(
			new Error("This rule changed or was revoked"),
		);
		const node = mount(<TenantToolPolicies canChange />);
		await flush();
		click(node, "Edit revision");
		expect(node.textContent).toContain(
			"Saving creates a replacement only if this revision is still current",
		);
		await reviewProfile(node);
		click(node, "Save rule");
		await flush();
		expect(h.saveRule).toHaveBeenCalledWith(
			expect.objectContaining({ expectedRevisionId: "old-rule" }),
		);
		expect(node.textContent).toContain("This rule changed or was revoked");
	});
	it("explicitly reviews a new grant after revocation", async () => {
		h.prepareRule.mockResolvedValue({
			preparationId: "receipt",
			descriptorDigest: "digest",
			descriptor: {
				mountedToolId: "write",
				providerId: "example",
				upstreamOperation: "write",
			},
		});
		h.saveRule.mockResolvedValue({});
		const node = mount(<TenantToolPolicies canChange />);
		await flush();
		click(node, "Review new rule after revocation");
		expect(node.textContent).toContain("The revoked rule stays revoked");
		await reviewProfile(node);
		click(node, "Save rule");
		await flush();
		expect(h.saveRule).toHaveBeenCalledWith(
			expect.objectContaining({
				expectedRevisionId: "revoked-rule",
				regrantRevoked: true,
			}),
		);
	});
	it("reviews nested conditions, saves a bounded rule, revokes and reports failure", async () => {
		h.prepareRule.mockResolvedValue({
			preparationId: "receipt",
			descriptorDigest: "digest",
			descriptor: {
				mountedToolId: "write",
				providerId: "example",
				upstreamOperation: "write",
				connectionInstanceId: "account",
			},
		});
		h.saveRule.mockResolvedValue({});
		h.revokeRule.mockRejectedValueOnce(new Error("Cannot revoke rule"));
		const node = mount(<TenantToolPolicies canChange />);
		await flush();
		change(node.querySelector("select")!, "root");
		change(node.querySelector("#policy-mounted-tool")!, "write");
		change(
			node.querySelector("#policy-example")!,
			JSON.stringify({
				resource: { id: "one", text: "sample" },
				changes: [{ kind: "set", value: "example" }],
			}),
		);
		await reviewProfile(node);
		expect(node.textContent).toContain("Unlisted fields are rejected");
		const textField = [...node.querySelectorAll("fieldset")].find(
			(f) => f.querySelector("legend")?.textContent === "resource.text",
		)!;
		const labels = [...textField.querySelectorAll("label")];
		const any = labels
			.find((l) => l.textContent?.includes("Allow any non-blank text"))!
			.querySelector("input")!;
		act(() => any.click());
		click(node, "Save rule");
		await flush();
		const saved = h.saveRule.mock.calls[0]![0].policySet.rules[0].predicate;
		expect(
			matchesTenantPolicyPredicate(saved, {
				resource: { id: "one", text: "changed" },
				changes: [{ kind: "set", value: "example" }],
			}),
		).toBe(true);
		expect(
			matchesTenantPolicyPredicate(saved, {
				resource: { id: "one", text: "changed", extra: true },
				changes: [{ kind: "set", value: "example" }],
			}),
		).toBe(false);
		expect(
			matchesTenantPolicyPredicate(saved, {
				resource: { id: "one", text: "changed" },
				changes: [],
			}),
		).toBe(false);
		click(node, "Revoke rule");
		await flush();
		expect(node.textContent).toContain("Cannot revoke rule");
	});
	it("shows the verified connection scope and explains the workspace is not shown", async () => {
		h.probeAccount.mockResolvedValue({
			resultReceiptId: "receipt",
			credentialSummary: {
				scope: "user",
				connectionInstanceId: "00000000-0000-4000-8000-000000000001",
			},
		});
		h.prepareHybrid.mockResolvedValue({
			preparationId: "p",
			descriptorDigest: "d",
			descriptor: {
				kind: "profile",
				mount: {
					rootAppId: "root",
					mountedToolId: "write",
					providerId: "example",
					upstreamOperation: "write",
				},
			},
		});
		const node = mount(<TenantToolPolicies canChange />);
		await flush();
		const select = [...node.querySelectorAll("select")].find((entry) =>
			[...entry.options].some((option) => option.value === "old-profile"),
		)!;
		change(select, "old-profile");
		click(node, "Verify account and review tool");
		await flush();
		expect(node.textContent).toContain(
			"The verified connection is your personal connection",
		);
		expect(node.textContent).toContain(
			"Connection ID: 00000000-0000-4000-8000-000000000001",
		);
		expect(node.textContent).toContain("The workspace name is not shown");
	});
	it("reviews and explicitly attests a profile before saving, then revokes", async () => {
		h.prepareProfile.mockResolvedValue({
			preparationId: "p",
			profileDigest: "d",
			mount: { mountedToolId: "write", providerId: "example" },
			probeMount: { mountedToolId: "identity" },
			profile: { operation: "identity", selectors: [["id"]] },
		});
		h.saveProfile.mockResolvedValue({});
		h.revokeProfile.mockResolvedValue({});
		const node = mount(<ProviderIdentityProfiles canChange />);
		await flush();
		change(node.querySelector("select")!, "root");
		change(node.querySelector("#identity-write-tool")!, "write");
		change(node.querySelector("#identity-probe-tool")!, "identity");
		change(node.querySelector("#identity-paths")!, "id");
		click(node, "Review identity profile");
		await flush();
		const save = [...node.querySelectorAll("button")].find(
			(el) => el.textContent?.trim() === "Save reviewed profile",
		)!;
		expect(save.disabled).toBe(true);
		act(() =>
			node
				.querySelector('input[type="checkbox"]')!
				.dispatchEvent(new MouseEvent("click", { bubbles: true })),
		);
		expect(save.disabled).toBe(false);
		click(node, "Save reviewed profile");
		await flush();
		expect(h.saveProfile).toHaveBeenCalledWith(
			expect.objectContaining({ safetyAttestation: "safe_empty_probe" }),
		);
		click(node, "Revoke profile");
		await flush();
		expect(h.revokeProfile).toHaveBeenCalledWith({ id: "old-profile" });
	});
});
