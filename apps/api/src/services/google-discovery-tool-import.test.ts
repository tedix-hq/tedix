import { describe, expect, it } from "vite-plus/test";
import { googleDiscoveryToolImportTestInternals as internals } from "./google-discovery-tool-import";

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
});
