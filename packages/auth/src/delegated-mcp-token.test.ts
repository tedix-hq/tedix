import { describe, expect, it } from "vite-plus/test";
import {
	isDelegatedWorkTool,
	issueDelegatedMcpToken,
	verifyDelegatedMcpToken,
} from "./delegated-mcp-token";

const input = {
	secret: "test-service-secret",
	audience: "https://tedix-unified.mcp.tedix.dev/mcp",
	runId: "child-run",
	homeRunId: "home-run",
	workItemId: "work-item",
	tediId: "tedi-1",
	organizationId: "org-1",
	scopes: ["mcp:apps.read", "mcp:content.write"],
	now: 1_780_000_000,
};

describe("delegated MCP token", () => {
	it("permits exact messaging replies while retaining the human handoff and Work mutation fences", () => {
		for (const [name, endpoint] of [
			["get_work_interaction", "workInteractions/get"],
			["respond_work_interaction", "workInteractions/respond"],
		]) {
			expect(
				isDelegatedWorkTool(`tedix__${name}`, "work", { endpoint }, "rpc"),
			).toBe(false);
			expect(
				isDelegatedWorkTool(`tedix__${name}`, "work", { endpoint }, "code"),
			).toBe(true);
			expect(
				isDelegatedWorkTool(`tedix__${name}`, "work", {
					endpoint: "workItems/complete",
				}),
			).toBe(true);
		}
		expect(
			isDelegatedWorkTool("delegate_work_interaction", "work", {
				endpoint: "workInteractions/delegate",
			}),
		).toBe(true);
		expect(
			isDelegatedWorkTool("complete_work_item", "work", {
				endpoint: "workItems/complete",
			}),
		).toBe(true);
	});
	it("binds the audience, run, work, tedi and organization", async () => {
		const { token, expiresAt } = await issueDelegatedMcpToken(input);
		expect(expiresAt).toBe(input.now + 180);
		expect(await verifyDelegatedMcpToken(token, input)).toMatchObject({
			audience: input.audience,
			runId: input.runId,
			homeRunId: input.homeRunId,
			workItemId: input.workItemId,
			tediId: input.tediId,
			organizationId: input.organizationId,
			scopes: input.scopes,
		});
		await expect(
			verifyDelegatedMcpToken(token, {
				...input,
				audience: "https://other.mcp.tedix.dev/mcp",
			}),
		).rejects.toThrow();
		await expect(
			verifyDelegatedMcpToken(token, { ...input, secret: "forged" }),
		).rejects.toThrow();
		await expect(
			verifyDelegatedMcpToken(token, { ...input, now: input.now + 181 }),
		).rejects.toThrow();
	});

	it("carries an issuer-approved exact platform scope with the same short-lived delegation fences", async () => {
		const scopes = [...input.scopes, "platform:admin", "mcp:work.read"];
		const { token, expiresAt } = await issueDelegatedMcpToken({
			...input,
			scopes,
		});
		expect(expiresAt).toBe(input.now + 180);
		expect(await verifyDelegatedMcpToken(token, input)).toEqual({
			audience: input.audience,
			runId: input.runId,
			homeRunId: input.homeRunId,
			workItemId: input.workItemId,
			tediId: input.tediId,
			organizationId: input.organizationId,
			scopes,
		});
		await expect(
			verifyDelegatedMcpToken(token, {
				...input,
				audience: "https://other.mcp.tedix.dev/mcp",
			}),
		).rejects.toThrow();
		await expect(
			verifyDelegatedMcpToken(token, { ...input, secret: "forged" }),
		).rejects.toThrow();
		await expect(
			verifyDelegatedMcpToken(token, { ...input, now: expiresAt }),
		).rejects.toThrow();
		for (const forbidden of [
			"*",
			"mcp:*",
			"mcp:work.write",
			"mcp:work.admin",
		]) {
			await expect(
				issueDelegatedMcpToken({ ...input, scopes: [...scopes, forbidden] }),
			).rejects.toThrow();
		}
	});

	it("allows Work read while refusing Work mutation and wildcard authority", async () => {
		const { token } = await issueDelegatedMcpToken({
			...input,
			scopes: ["mcp:work.read"],
		});
		expect((await verifyDelegatedMcpToken(token, input)).scopes).toEqual([
			"mcp:work.read",
		]);
		for (const scope of ["mcp:work.write", "mcp:work.admin", "mcp:*", "*"]) {
			await expect(
				issueDelegatedMcpToken({ ...input, scopes: [scope] }),
			).rejects.toThrow();
		}
	});

	it.each([
		["list_work_item_evidence", "list_work_evidence", "workItems/listEvidence"],
		["list_work_item_events", "list_work_events", "workItems/listEvents"],
	])(
		"allows the exact %s read without admitting mutation aliases",
		(canonical, alias, endpoint) => {
			expect(
				isDelegatedWorkTool(`tedix__${canonical}`, "work", { endpoint }, "rpc"),
			).toBe(false);
			expect(
				isDelegatedWorkTool(
					`tedix__${canonical}`,
					"work",
					{ endpoint },
					"code",
				),
			).toBe(true);
			expect(
				isDelegatedWorkTool(
					`reader__${alias}`,
					"reader",
					{
						endpoint,
						_aggregateNamespace: "reader",
						_aggregateTediRemoteName: alias,
					},
					"rpc",
				),
			).toBe(false);
			expect(
				isDelegatedWorkTool(
					canonical,
					"work",
					{ endpoint: "workItems/complete" },
					"rpc",
				),
			).toBe(true);
			expect(
				isDelegatedWorkTool("complete_work_item", "work", { endpoint }, "rpc"),
			).toBe(true);
			expect(isDelegatedWorkTool(canonical, "other", { endpoint }, "rpc")).toBe(
				true,
			);
		},
	);
	it("classifies Work aliases and Home re-entry independently of configured scopes", () => {
		for (const [name, namespace] of [
			["complete_work_item", "apps"],
			["start_assigned_work", "tedi"],
			["ask", "home"],
			["home__retry_delegation", "home"],
			["any", "kernel"],
			["list_work_items", "work"],
		] as const) {
			expect(isDelegatedWorkTool(name, namespace)).toBe(true);
		}
		expect(isDelegatedWorkTool("list_posts", "cms")).toBe(false);
		expect(
			isDelegatedWorkTool("finish_task", "ops", {
				endpoint: "workItems/complete",
			}),
		).toBe(true);
		expect(
			isDelegatedWorkTool("finish_task", "ops", {
				rpcEndpoint: "/workItems/complete",
			}),
		).toBe(true);
		expect(
			isDelegatedWorkTool(
				"echo__work_items_list",
				"echo",
				{
					endpoint: "workItems/list",
					_aggregateNamespace: "echo",
					_aggregateTediRemoteName: "work_items_list",
				},
				"rpc",
			),
		).toBe(false);
		expect(
			isDelegatedWorkTool(
				"cto__work_item_get",
				"cto",
				{
					endpoint: "workItems/getById",
					_aggregateNamespace: "cto",
					_aggregateTediRemoteName: "work_item_get",
				},
				"rpc",
			),
		).toBe(false);
		for (const [name, namespace, endpoint, remoteName] of [
			["tedix__list_work_items", "work", "workItems/list", undefined],
			[
				"tedix__get_work_item_readiness",
				"work",
				"workItems/getReadiness",
				undefined,
			],
			[
				"tedix__list_work_item_attempts",
				"work",
				"workItems/listAttempts",
				undefined,
			],
			[
				"cto__get_work_item_readiness",
				"cto",
				"workItems/getReadiness",
				"get_work_item_readiness",
			],
			[
				"cto__list_work_attempts",
				"cto",
				"workItems/listAttempts",
				"list_work_attempts",
			],
		] as const) {
			expect(
				isDelegatedWorkTool(
					name,
					namespace,
					{
						endpoint,
						...(remoteName
							? {
									_aggregateNamespace: namespace,
									_aggregateTediRemoteName: remoteName,
								}
							: {}),
					},
					"rpc",
				),
			).toBe(false);
		}
		expect(
			isDelegatedWorkTool("tedix__complete_work_item", "work", {
				endpoint: "workItems/list",
			}),
		).toBe(true);
		for (const config of [
			{
				endpoint: "workItems/complete",
				_aggregateNamespace: "cto",
				_aggregateTediRemoteName: "work_item_get",
			},
			{
				endpoint: "workItems/getById",
				_aggregateNamespace: "cto",
				_aggregateTediRemoteName: "complete_work_item",
			},
			{
				endpoint: "workItems/getById",
				_aggregateNamespace: "cmo",
				_aggregateTediRemoteName: "work_item_get",
			},
		]) {
			expect(isDelegatedWorkTool("cto__work_item_get", "cto", config)).toBe(
				true,
			);
		}
		expect(
			isDelegatedWorkTool("echo__work_items_list", "echo", {
				endpoint: "workItems/complete",
				_aggregateNamespace: "echo",
				_aggregateTediRemoteName: "work_items_list",
			}),
		).toBe(true);
		expect(isDelegatedWorkTool("work_items_list", "echo")).toBe(true);
	});
});
