// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ApiKey } from "@tedix/api-contract/schemas/organization";
import {
	buildApiKeysWebMcpTools,
	type ApiKeysWebMcpContext,
} from "./api-keys-webmcp-tools";

const keyId = "11111111-1111-4111-8111-111111111111";
const organizationId = "22222222-2222-4222-8222-222222222222";
const key = {
	id: keyId,
	name: "Observer",
	status: "active",
	scopes: ["apps:read"],
	keyPreview: "…1234",
	rawKey: "NEVER_RETURN_THIS",
	metadata: { secret: "NEVER_RETURN_THIS" },
} as unknown as ApiKey;
const draft = {
	name: "Observer",
	environment: "live",
	scopes: ["apps:read"],
};
let context: ApiKeysWebMcpContext;
const listKeys = vi.fn();
const prepareCreate = vi.fn();
const prepareAction = vi.fn();
const tools = () =>
	buildApiKeysWebMcpTools({
		context: () => context,
		listKeys,
		prepareCreate,
		prepareAction,
	});
const tool = (name: string) => tools().find((tool) => tool.name === name)!;
beforeEach(() => {
	vi.resetAllMocks();
	context = { organizationId, offset: 25, limit: 25, busy: false };
	listKeys.mockResolvedValue({ data: [key], pagination: { total: 26 } });
	prepareCreate.mockReturnValue(true);
	prepareAction.mockReturnValue(true);
});
describe("API key WebMCP safety", () => {
	it("exposes only metadata and preparation, never credential mutations", () => {
		expect(tools().map((tool) => tool.name)).toEqual([
			"list_api_keys",
			"prepare_create_api_key",
			"prepare_rotate_api_key",
			"prepare_revoke_api_key",
		]);
		expect(tool("list_api_keys").annotations).toEqual({
			readOnlyHint: true,
			untrustedContentHint: true,
		});
		for (const entry of tools().slice(1))
			expect(entry.annotations.readOnlyHint).toBe(false);
	});
	it("reads the bound tenant and page and explicitly projects metadata", async () => {
		const result = await tool("list_api_keys").execute({});
		expect(listKeys).toHaveBeenCalledWith(
			{ organizationId, offset: 25, limit: 25 },
			undefined,
		);
		expect(result.structuredContent).toMatchObject({
			keys: [{ id: keyId, name: "Observer" }],
			total: 26,
			offset: 25,
		});
		expect(JSON.stringify(result)).not.toContain("NEVER_RETURN_THIS");
	});
	it.each(["organizationId", "rawKey", "confirm"])(
		"rejects injected list field %s",
		async (field) => {
			expect(
				(await tool("list_api_keys").execute({ [field]: "bad" })).isError,
			).toBe(true);
			expect(listKeys).not.toHaveBeenCalled();
		},
	);
	it("prepares an explicit scoped draft without issuing credentials", async () => {
		const result = await tool("prepare_create_api_key").execute(draft);
		expect(prepareCreate).toHaveBeenCalledWith(draft);
		expect(listKeys).not.toHaveBeenCalled();
		expect(result.structuredContent).toMatchObject({
			status: "awaiting_human_confirmation",
			credentialIssued: false,
		});
	});
	it.each([
		{ ...draft, scopes: ["*"] },
		{ ...draft, scopes: ["platform:admin"] },
		{ ...draft, scopes: [] },
		{ ...draft, scopes: undefined },
		{ ...draft, environment: undefined },
		{ ...draft, name: " " },
		{ ...draft, name: "x".repeat(101) },
		{ ...draft, description: "x".repeat(501) },
		{ ...draft, confirm: true },
		{ ...draft, organizationId },
		{ ...draft, rawKey: "secret" },
		{ ...draft, resume: true },
		{ ...draft, rateLimit: 123 },
	])("rejects unsafe or unsupported create inputs %#", async (input) => {
		expect((await tool("prepare_create_api_key").execute(input)).isError).toBe(
			true,
		);
		expect(prepareCreate).not.toHaveBeenCalled();
	});
	it.each(["rotate", "revoke"])(
		"prepares %s using the canonical current key name",
		async (operation) => {
			const result = await tool(`prepare_${operation}_api_key`).execute({
				keyId,
			});
			expect(prepareAction).toHaveBeenCalledWith({
				type: operation,
				id: keyId,
				name: "Observer",
			});
			expect(result.structuredContent).toMatchObject({
				status: "awaiting_human_confirmation",
				credentialChanged: false,
			});
		},
	);
	it.each(["rotate", "revoke"])(
		"does not prepare %s for an absent or inactive key",
		async (operation) => {
			listKeys.mockResolvedValueOnce({ data: [], pagination: { total: 0 } });
			expect(
				(await tool(`prepare_${operation}_api_key`).execute({ keyId })).isError,
			).toBe(true);
			listKeys.mockResolvedValueOnce({
				data: [{ ...key, status: "revoked" }],
				pagination: { total: 1 },
			});
			expect(
				(await tool(`prepare_${operation}_api_key`).execute({ keyId })).isError,
			).toBe(true);
			expect(prepareAction).not.toHaveBeenCalled();
		},
	);
	it("preserves an existing dialog and rejects concurrent reservations", async () => {
		context.busy = true;
		expect((await tool("prepare_create_api_key").execute(draft)).isError).toBe(
			true,
		);
		expect(
			(await tool("prepare_rotate_api_key").execute({ keyId })).isError,
		).toBe(true);
		expect(prepareCreate).not.toHaveBeenCalled();
		expect(prepareAction).not.toHaveBeenCalled();
		context.busy = false;
		prepareCreate.mockReturnValue(false);
		expect((await tool("prepare_create_api_key").execute(draft)).isError).toBe(
			true,
		);
	});
	it("checks for a dialog opened during a read", async () => {
		listKeys.mockImplementation(async () => {
			context.busy = true;
			return { data: [key], pagination: { total: 1 } };
		});
		expect(
			(await tool("prepare_revoke_api_key").execute({ keyId })).isError,
		).toBe(true);
		expect(prepareAction).not.toHaveBeenCalled();
	});
	it("forwards cancellation and refuses late actions after cancellation", async () => {
		const controller = new AbortController();
		const options = { signal: controller.signal };
		listKeys.mockImplementation(async () => {
			controller.abort();
			return { data: [key], pagination: { total: 1 } };
		});
		expect(
			(await tool("prepare_rotate_api_key").execute({ keyId }, options))
				.isError,
		).toBe(true);
		expect(listKeys.mock.calls[0]?.[1]).toBe(options);
		expect(prepareAction).not.toHaveBeenCalled();
	});
	it("does not prepare an already cancelled create", async () => {
		expect(
			(
				await tool("prepare_create_api_key").execute(draft, {
					signal: AbortSignal.abort(),
				})
			).isError,
		).toBe(true);
		expect(prepareCreate).not.toHaveBeenCalled();
	});
	it.each(["organizationId", "offset"] as const)(
		"rejects stale %s after a read",
		async (field) => {
			listKeys.mockImplementation(async () => {
				context = { ...context, [field]: field === "offset" ? 50 : keyId };
				return { data: [key], pagination: { total: 1 } };
			});
			expect(
				(await tool("prepare_rotate_api_key").execute({ keyId })).isError,
			).toBe(true);
			expect(prepareAction).not.toHaveBeenCalled();
		},
	);
	it("maps API authorization failure without throwing", async () => {
		listKeys.mockRejectedValue({ code: "FORBIDDEN", message: "Unavailable" });
		const result = await tool("list_api_keys").execute({});
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result)).toContain("context_unavailable");
	});
	it("derives create bounds and the exact delegable vocabulary", () => {
		const schema = tool("prepare_create_api_key").inputSchema;
		expect(schema.additionalProperties).toBe(false);
		expect(schema.required).toEqual(
			expect.arrayContaining(["name", "environment", "scopes"]),
		);
		const properties = schema.properties as Record<
			string,
			Record<string, unknown>
		>;
		expect(properties.name).toMatchObject({ minLength: 1, maxLength: 100 });
		expect(properties.scopes).toMatchObject({ minItems: 1 });
		expect(JSON.stringify(properties.scopes)).not.toContain('"*"');
	});
});
