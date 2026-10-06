import { describe, expect, it } from "vite-plus/test";
import { normalizeOpenApiStructuredContent } from "./openapi-output";

describe("normalizeOpenApiStructuredContent", () => {
	it("coerces OpenAPI boolean string drift where the output schema requires booleans", () => {
		const structuredContent = normalizeOpenApiStructuredContent(
			{
				objects: [
					{
						id: "1",
						smallSettlement: "0",
						showNet: "1",
						sumGross: "3000.00",
					},
				],
			},
			{
				type: "object",
				properties: {
					objects: {
						type: "array",
						items: {
							type: "object",
							properties: {
								id: { type: ["string", "null"] },
								smallSettlement: { type: ["boolean", "null"] },
								showNet: {
									anyOf: [{ type: "boolean" }, { type: "null" }],
								},
								sumGross: { type: ["string", "null"] },
							},
							additionalProperties: true,
						},
					},
				},
				additionalProperties: true,
			},
		);

		expect(structuredContent).toEqual({
			objects: [
				{
					id: "1",
					smallSettlement: false,
					showNet: true,
					sumGross: "3000.00",
				},
			],
		});
	});

	it("leaves string fields and invalid boolean strings untouched", () => {
		const original = {
			showNet: "sometimes",
			status: "1",
		};

		const structuredContent = normalizeOpenApiStructuredContent(original, {
			type: "object",
			properties: {
				showNet: { type: ["boolean", "null"] },
				status: { type: ["string", "null"] },
			},
		});

		expect(structuredContent).toEqual(original);
	});

	it("coerces boolean strings even when output schemas also tolerate strings", () => {
		const structuredContent = normalizeOpenApiStructuredContent(
			{ showNet: "true" },
			{
				type: "object",
				properties: {
					showNet: { type: ["boolean", "string", "null"] },
				},
			},
		);

		expect(structuredContent).toEqual({ showNet: true });
	});

	it("wraps raw object responses when generated output schemas expect data", () => {
		const structuredContent = normalizeOpenApiStructuredContent(
			{
				id: "profile_1",
				type: "BUSINESS",
				visible: "true",
			},
			{
				type: "object",
				properties: {
					data: {
						type: "object",
						properties: {
							id: { type: ["string", "null"] },
							type: { type: ["string", "null"] },
							visible: { type: ["boolean", "null"] },
						},
						additionalProperties: true,
					},
				},
				required: ["data"],
				additionalProperties: true,
			},
		);

		expect(structuredContent).toEqual({
			data: {
				id: "profile_1",
				type: "BUSINESS",
				visible: true,
			},
		});
	});

	it("unwraps handler data envelopes for root-array output schemas", () => {
		const structuredContent = normalizeOpenApiStructuredContent(
			{
				data: [
					{ id: "deployment_1", active: "1" },
					{ id: "deployment_2", active: "0" },
				],
			},
			{
				type: "array",
				items: {
					type: "object",
					properties: {
						id: { type: "string" },
						active: { type: ["boolean", "null"] },
					},
				},
			},
		);

		expect(structuredContent).toEqual([
			{ id: "deployment_1", active: true },
			{ id: "deployment_2", active: false },
		]);
	});
});
