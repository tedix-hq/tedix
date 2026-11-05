import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
	upsertTool: vi.fn(async () => ({})),
}));
vi.mock("@tedix/db/queries/app-records", () => ({
	getAppById: vi.fn(async (_db: unknown, id: string) => ({
		id,
		slug: "google",
		metadata: {},
	})),
	updateApp: vi.fn(async () => null),
}));
vi.mock("@tedix/db/queries/tools", () => ({
	getToolsByAppId: vi.fn(async () => []),
	upsertTool: mocks.upsertTool,
	deleteTool: vi.fn(async () => undefined),
}));

import {
	googleDiscoveryToolImportTestInternals as internals,
	runGoogleDiscoveryToolImport,
} from "./google-discovery-tool-import";

describe("google discovery tool import", () => {
	it("normalizes Discovery method ids and path templates for external tools", () => {
		expect(internals.normalizeToolId("gmail.users.messages.get")).toBe(
			"gmail_users_messages_get",
		);
		expect(
			internals.endpointFromDiscoveryPath(
				"gmail/v1/users/{userId}/messages/{id}",
			),
		).toBe("gmail/v1/users/:userId/messages/:id");
	});

	it("requires an explicit split Google connection provider", () => {
		expect(() =>
			internals.requireGoogleConnectionProviderId(undefined),
		).toThrow(/product-scoped Google connectionProviderId/i);
		expect(internals.requireGoogleConnectionProviderId("google-gmail")).toBe(
			"google-gmail",
		);
	});

	it("builds object input with static Gmail userId and JSON body param", () => {
		const doc = {
			schemas: {
				Message: {
					type: "object",
					properties: {
						raw: { type: "string" },
						threadId: { type: "string" },
					},
				},
			},
		};
		const schema = internals.inputSchemaForOperation({
			service: "gmail",
			version: "v1",
			methodId: "gmail.users.messages.send",
			httpMethod: "POST",
			path: "gmail/v1/users/{userId}/messages/send",
			doc,
			method: {
				id: "gmail.users.messages.send",
				httpMethod: "POST",
				path: "gmail/v1/users/{userId}/messages/send",
				parameters: {
					userId: { type: "string", required: true, location: "path" },
				},
				request: { $ref: "Message" },
			},
		});

		expect(schema).toMatchObject({
			type: "object",
			properties: {
				body: {
					type: "object",
					properties: {
						raw: { type: "string" },
						threadId: { type: "string" },
					},
				},
			},
			required: ["body"],
			additionalProperties: false,
		});
		expect(schema.properties).not.toHaveProperty("userId");
	});

	it("declares writeCapability from the HTTP method on every imported tool", async () => {
		const doc = {
			rootUrl: "https://acme.googleapis.com/",
			methods: Object.fromEntries(
				(
					[
						["acme.things.list", "GET"],
						["acme.things.create", "POST"],
						["acme.things.replace", "PUT"],
						["acme.things.patch", "PATCH"],
						["acme.things.delete", "DELETE"],
					] as const
				).map(([id, httpMethod]) => [
					id.split(".").at(-1)!,
					{
						id,
						httpMethod,
						path: `v1/things${httpMethod === "GET" ? "" : "/mutate"}`,
					},
				]),
			),
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify(doc))),
		);

		await runGoogleDiscoveryToolImport({} as never, {
			appId: "app-google",
			services: [{ name: "acme", version: "v1" }],
			connectionProviderId: "google-acme",
			dryRun: false,
		});

		const byMethod = new Map(
			mocks.upsertTool.mock.calls.map((call) => [
				(call[1] as { config: { method: string } }).config.method,
				(call[1] as { writeCapability: string }).writeCapability,
			]),
		);
		expect(byMethod).toEqual(
			new Map([
				["GET", "read"],
				["POST", "write"],
				["PUT", "write"],
				["PATCH", "write"],
				["DELETE", "destructive"],
			]),
		);
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	mocks.upsertTool.mockClear();
});
