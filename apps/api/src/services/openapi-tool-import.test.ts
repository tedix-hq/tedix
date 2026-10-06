import { describe, expect, it } from "vite-plus/test";
import {
	buildOpenApiSyncMetadata,
	openApiToolImportTestInternals,
} from "./openapi-tool-import";

const baseResult = {
	appId: "7a2f8b3c-d4e5-4f6a-b1c2-3d4e5f6a7b8c",
	dryRun: false,
	totalOperations: 1,
	planned: 1,
	created: 0,
	updated: 1,
	inSync: 0,
	deleted: 0,
	skipped: 0,
	failed: 0,
};

describe("OpenAPI tool import", () => {
	it("projects official Graph form/explode:false metadata into array query formats", () => {
		const operation = {
			parameters: [
				{
					name: "$select",
					in: "query",
					style: "form",
					explode: false,
					schema: { type: "array", items: { type: "string" } },
				},
				{
					name: "$expand",
					in: "query",
					explode: false,
					schema: { type: "array" },
				},
				{ name: "ids", in: "query", schema: { type: "array" } },
				{
					name: "repeated",
					in: "query",
					style: "form",
					explode: true,
					schema: { type: "array" },
				},
				{
					name: "spaces",
					in: "query",
					style: "spaceDelimited",
					schema: { type: "array" },
				},
				{
					name: "pipes",
					in: "query",
					style: "pipeDelimited",
					schema: { type: "array" },
				},
				{
					name: "scalar",
					in: "query",
					explode: false,
					schema: { type: "string" },
				},
				{
					name: "header",
					in: "header",
					explode: false,
					schema: { type: "array" },
				},
			],
		};
		expect(
			openApiToolImportTestInternals.queryArrayFormats({}, {}, operation),
		).toEqual({
			$select: "comma",
			$expand: "comma",
			spaces: "space",
			pipes: "pipe",
		});
	});
	it("accepts Graph extension data on inherited resources while retaining declared and map types", () => {
		const schema = openApiToolImportTestInternals.structuredOutputSchema({
			type: "object",
			properties: {
				value: {
					type: "array",
					items: {
						allOf: [
							{
								type: "object",
								properties: { id: { type: "string" } },
								additionalProperties: { type: "object" },
							},
							{
								type: "object",
								properties: {
									name: { type: "string" },
									canEdit: { type: "boolean" },
								},
								additionalProperties: { type: "object" },
							},
						],
					},
				},
			},
			additionalProperties: { type: "object" },
		});
		expect(schema?.additionalProperties).toBe(true);
		const value = schema?.properties?.value as {
			items: { allOf: Array<Record<string, unknown>> };
		};
		expect(
			value.items.allOf.every((branch) => branch.additionalProperties === true),
		).toBe(true);
		expect(value.items.allOf[0]?.properties).toEqual({
			id: { type: ["string", "null"] },
		});
		expect(value.items.allOf[1]?.properties).toMatchObject({
			name: { type: ["string", "null"] },
		});
		expect(
			openApiToolImportTestInternals.structuredOutputSchema({
				type: "object",
				additionalProperties: { type: "string" },
			})?.additionalProperties,
		).toEqual({ type: "string" });
	});
	it("adds Tedix-injected arguments to MCP input without making them transport parameters", () => {
		const operation = {
			parameters: [
				{
					name: "limit",
					in: "query",
					schema: { type: "integer", minimum: 1 },
				},
			],
			"x-tedix-injected-arguments": {
				companyId: {
					type: "string",
					pattern: "^[1-9][0-9]*$",
					description: "Injected from the signed host organization.",
				},
			},
		};

		expect(
			openApiToolImportTestInternals.inputSchemaForOperation({}, {}, operation),
		).toEqual({
			type: "object",
			properties: {
				limit: { type: "integer", minimum: 1 },
				companyId: {
					type: "string",
					pattern: "^[1-9][0-9]*$",
					description: "Injected from the signed host organization.",
				},
			},
			required: [],
			additionalProperties: false,
		});
		expect(
			openApiToolImportTestInternals.parameterNamesByLocation(
				{},
				{},
				operation,
				"query",
			),
		).toEqual(["limit"]);
		expect(
			openApiToolImportTestInternals.runtimeOnlyParameterNames(operation),
		).toEqual(["companyId"]);
	});

	it("rejects injected arguments that collide with upstream parameters", () => {
		expect(() =>
			openApiToolImportTestInternals.inputSchemaForOperation(
				{},
				{},
				{
					parameters: [
						{ name: "companyId", in: "query", schema: { type: "string" } },
					],
					"x-tedix-injected-arguments": {
						companyId: { type: "string" },
					},
				},
			),
		).toThrow("collides with transport parameter companyId");
	});

	it("omits path parameters removed with a stripped source prefix", () => {
		const sourcePath = "/users/{user-id}/messages/{message-id}";
		const generatedPath = openApiToolImportTestInternals.applyStripPathPrefixes(
			sourcePath,
			["/users/{user-id}"],
		);
		const removed = openApiToolImportTestInternals.removedPathParameterNames(
			sourcePath,
			generatedPath,
		);

		expect(generatedPath).toBe("/messages/{message-id}");
		expect([...removed]).toEqual(["user-id"]);
		expect(
			openApiToolImportTestInternals.inputSchemaForOperation(
				{},
				{},
				{
					parameters: [
						{
							name: "user-id",
							in: "path",
							required: true,
							schema: { type: "string" },
						},
						{
							name: "message-id",
							in: "path",
							required: true,
							schema: { type: "string" },
						},
					],
				},
				{ omitParameterNames: removed },
			),
		).toMatchObject({
			required: ["message-id"],
			properties: { "message-id": { type: "string" } },
		});
	});

	it("supports exact provider path aliases before prefix stripping", () => {
		expect(
			openApiToolImportTestInternals.generatedOpenApiPath(
				"/users/{user-id}/microsoft.graph.sendMail",
				["/users/{user-id}"],
				{
					"/users/{user-id}/microsoft.graph.sendMail": "/sendMail",
				},
			),
		).toBe("/sendMail");
	});

	it("rejects oversized specs before parsing them", async () => {
		const response = new Response("{}", {
			headers: {
				"content-length": String(
					openApiToolImportTestInternals.MAX_OPENAPI_SPEC_BYTES + 1,
				),
			},
		});

		await expect(
			openApiToolImportTestInternals.parseOpenApiSpecResponse(response),
		).rejects.toThrow("Publish a service-specific or pre-filtered spec");
	});

	it("persists inline specs so scheduled sync can replay them", () => {
		const spec = {
			openapi: "3.1.0",
			info: { title: "Private compatibility API", version: "1.0.0" },
			paths: {
				"/trpc/example.update": {
					post: { operationId: "update_example", responses: {} },
				},
			},
		};
		const metadata = buildOpenApiSyncMetadata(
			{},
			{
				appId: "7a2f8b3c-d4e5-4f6a-b1c2-3d4e5f6a7b8c",
				spec,
				baseUrl: "https://example.com",
				replaceExisting: true,
			},
			baseResult,
			"2026-05-09T18:33:32.499Z",
		);

		expect(metadata.mcpConfig?.openApiSync?.spec).toEqual(spec);
		expect(metadata.mcpConfig?.openApiSync?.specUrl).toBeUndefined();

		const replayInput =
			openApiToolImportTestInternals.mergeStoredOpenApiImportInput(
				{
					appId: "7a2f8b3c-d4e5-4f6a-b1c2-3d4e5f6a7b8c",
					dryRun: false,
				},
				metadata.mcpConfig?.openApiSync ?? {},
			);
		expect(replayInput.spec).toEqual(spec);
		expect(replayInput.baseUrl).toBe("https://example.com");
		expect(replayInput.dryRun).toBe(false);

		const urlReplacement =
			openApiToolImportTestInternals.mergeStoredOpenApiImportInput(
				{
					appId: "7a2f8b3c-d4e5-4f6a-b1c2-3d4e5f6a7b8c",
					specUrl: "https://example.com/openapi.json",
				},
				metadata.mcpConfig?.openApiSync ?? {},
			);
		expect(urlReplacement.spec).toBeUndefined();
		expect(urlReplacement.specUrl).toBe("https://example.com/openapi.json");

		const inlineReplacement =
			openApiToolImportTestInternals.mergeStoredOpenApiImportInput(
				{
					appId: "7a2f8b3c-d4e5-4f6a-b1c2-3d4e5f6a7b8c",
					spec,
				},
				{
					specUrl: "https://example.com/stale.json",
				},
			);
		expect(inlineReplacement.spec).toEqual(spec);
		expect(inlineReplacement.specUrl).toBeUndefined();
	});

	it("merges bounded service-specific OpenAPI documents", () => {
		const merged = openApiToolImportTestInternals.mergeOpenApiSpecs([
			{
				openapi: "3.0.1",
				paths: { "/messages": { get: { operationId: "listMessages" } } },
				components: { schemas: { Message: { type: "object" } } },
			},
			{
				paths: { "/sendMail": { post: { operationId: "sendMail" } } },
				components: {
					requestBodies: { SendMail: { required: true } },
				},
			},
		]);

		expect(merged).toMatchObject({
			openapi: "3.0.1",
			paths: {
				"/messages": { get: { operationId: "listMessages" } },
				"/sendMail": { post: { operationId: "sendMail" } },
			},
			components: {
				schemas: { Message: { type: "object" } },
				requestBodies: { SendMail: { required: true } },
			},
		});
	});

	it("scrubs stale connectionLabel when provider-backed sync owns credentials", () => {
		const metadata = buildOpenApiSyncMetadata(
			{
				mcpConfig: {
					authMode: "authenticated",
					connectionLabel: "globex",
				},
			},
			{
				appId: "7a2f8b3c-d4e5-4f6a-b1c2-3d4e5f6a7b8c",
				specUrl: "https://api.globex.example/openapi.yaml",
				baseUrl: "https://my.globex.example/api/v1",
				namespace: "globex",
				connectionProviderId: "globex-api-key",
				connectionScope: "tenant",
				authHeader: "Authorization",
				authTemplate: "{token}",
				includePathPrefixes: ["/v1/mgmt", "/v2/mgmt"],
				excludePathPrefixes: ["/v1/mgmt/internal"],
				replaceExisting: true,
			},
			baseResult,
			"2026-05-09T18:33:32.499Z",
		);

		expect(metadata.mcpConfig?.connectionLabel).toBeUndefined();
		expect(metadata.mcpConfig?.openApiSync).toMatchObject({
			enabled: true,
			connectionProviderId: "globex-api-key",
			includePathPrefixes: ["/v1/mgmt", "/v2/mgmt"],
			excludePathPrefixes: ["/v1/mgmt/internal"],
			lastSyncedAt: "2026-05-09T18:33:32.499Z",
		});
	});

	it("preserves auth encoding for generated Basic-auth REST tools", () => {
		const metadata = buildOpenApiSyncMetadata(
			{},
			{
				appId: "7a2f8b3c-d4e5-4f6a-b1c2-3d4e5f6a7b8c",
				specUrl: "https://example.com/openapi.yaml",
				baseUrl: "https://example.com",
				namespace: "example-db",
				connectionProviderId: "example-db-api-key",
				connectionScope: "tenant",
				authHeader: "Authorization",
				authTemplate: "Basic {token}",
				authEncoding: "base64",
				replaceExisting: true,
			},
			baseResult,
			"2026-05-09T18:33:32.499Z",
		);

		expect(metadata.mcpConfig?.openApiSync).toMatchObject({
			enabled: true,
			connectionProviderId: "example-db-api-key",
			authHeader: "Authorization",
			authTemplate: "Basic {token}",
			authEncoding: "base64",
		});
	});

	it("scrubs legacy connectionLabel even when no provider id is set", () => {
		const metadata = buildOpenApiSyncMetadata(
			{
				mcpConfig: {
					authMode: "authenticated",
					connectionLabel: "project-a",
				},
			},
			{
				appId: "7a2f8b3c-d4e5-4f6a-b1c2-3d4e5f6a7b8c",
				specUrl: "https://example.com/openapi.json",
				baseUrl: "https://api.example.com",
				replaceExisting: true,
			},
			baseResult,
			"2026-05-09T18:33:32.499Z",
		);

		expect(metadata.mcpConfig?.connectionLabel).toBeUndefined();
		expect(metadata.mcpConfig?.openApiSync).toMatchObject({
			enabled: true,
			connectionScope: "tenant",
		});
	});

	it("persists OpenAPI widget defaults in app metadata", () => {
		const metadata = buildOpenApiSyncMetadata(
			{
				mcpConfig: {},
			},
			{
				appId: "7a2f8b3c-d4e5-4f6a-b1c2-3d4e5f6a7b8c",
				specUrl: "https://api.example.com/openapi.json",
				baseUrl: "https://api.example.com",
				widgetDefaults: {
					layoutId: "records",
					pageSize: 20,
					columns: [{ field: "id", header: "ID" }],
				},
				widgetOverrides: {
					get_records: {
						title: "Records",
					},
				},
				replaceExisting: true,
			},
			baseResult,
			"2026-05-09T18:33:32.499Z",
		);

		expect(metadata.mcpConfig?.openApiSync?.widgetDefaults).toEqual({
			layoutId: "records",
			pageSize: 20,
			columns: [{ field: "id", header: "ID" }],
		});
		expect(metadata.mcpConfig?.openApiSync?.widgetOverrides).toEqual({
			get_records: {
				title: "Records",
			},
		});
	});

	it("allows null for optional response fields that vendors omit from nullable annotations", () => {
		const schema = openApiToolImportTestInternals.structuredOutputSchema({
			type: "object",
			properties: {
				objects: {
					type: "array",
					items: {
						type: "object",
						required: ["id"],
						properties: {
							id: { type: "string" },
							iban: { type: "string" },
							balance: {
								type: "object",
								properties: {
									bankServer: { type: "string" },
									lastSync: { type: "string", format: "date-time" },
								},
							},
						},
					},
				},
			},
		});

		const objects = schema?.properties?.objects as Record<string, unknown>;
		const items = objects.items as Record<string, unknown>;
		const properties = items.properties as Record<string, unknown>;
		const balance = properties.balance as Record<string, unknown>;
		const balanceProperties = balance.properties as Record<string, unknown>;

		expect((properties.id as Record<string, unknown>).type).toBe("string");
		expect((properties.iban as Record<string, unknown>).type).toEqual([
			"string",
			"null",
		]);
		expect(balance.type).toEqual(["object", "null"]);
		expect(
			(balanceProperties.bankServer as Record<string, unknown>).type,
		).toEqual(["string", "null"]);
		expect(
			(balanceProperties.lastSync as Record<string, unknown>).type,
		).toEqual(["string", "null"]);
	});

	it("keeps external output schemas shape-focused instead of vendor-constraint-strict", () => {
		const schema = openApiToolImportTestInternals.structuredOutputSchema({
			type: "object",
			required: ["deployments"],
			properties: {
				deployments: {
					type: "array",
					minItems: 1,
					items: {
						type: "object",
						required: ["market"],
						properties: {
							market: {
								type: "string",
								minLength: 43,
								maxLength: 44,
								pattern: "^[A-Za-z0-9]+$",
							},
						},
					},
				},
			},
		});

		const deployments = schema?.properties?.deployments as Record<
			string,
			unknown
		>;
		const items = deployments.items as Record<string, unknown>;
		const itemProperties = items.properties as Record<string, unknown>;
		const market = itemProperties.market as Record<string, unknown>;

		expect(schema?.required).toBeUndefined();
		expect(deployments.minItems).toBeUndefined();
		expect(items.required).toBeUndefined();
		expect(market.type).toBe("string");
		expect(market.minLength).toBeUndefined();
		expect(market.maxLength).toBeUndefined();
		expect(market.pattern).toBeUndefined();
	});

	it("loosens drift-prone external output enums and scalar types", () => {
		const schema = openApiToolImportTestInternals.structuredOutputSchema({
			type: "object",
			properties: {
				objects: {
					type: "array",
					items: {
						type: "object",
						properties: {
							taxRule: {
								type: "object",
								properties: {
									id: {
										type: "string",
										enum: ["1", "2", "3", "4", "5", "11"],
									},
								},
							},
							accountDatev: {
								type: "object",
								properties: {
									id: { type: "integer" },
								},
							},
							showNet: { type: "boolean" },
						},
					},
				},
			},
		});

		const objects = schema?.properties?.objects as Record<string, unknown>;
		const items = objects.items as Record<string, unknown>;
		const properties = items.properties as Record<string, unknown>;
		const taxRule = properties.taxRule as Record<string, unknown>;
		const taxRuleProperties = taxRule.properties as Record<string, unknown>;
		const taxRuleId = taxRuleProperties.id as Record<string, unknown>;
		const accountDatev = properties.accountDatev as Record<string, unknown>;
		const accountDatevProperties = accountDatev.properties as Record<
			string,
			unknown
		>;
		const accountDatevId = accountDatevProperties.id as Record<string, unknown>;
		const showNet = properties.showNet as Record<string, unknown>;

		expect(taxRuleId.enum).toBeUndefined();
		expect(new Set(taxRuleId.type as string[])).toEqual(
			new Set(["string", "null"]),
		);
		expect(new Set(accountDatevId.type as string[])).toEqual(
			new Set(["integer", "string", "null"]),
		);
		expect(new Set(showNet.type as string[])).toEqual(
			new Set(["boolean", "string", "null"]),
		);
	});

	it("loosens ambiguous external output oneOf branches to anyOf", () => {
		const schema = openApiToolImportTestInternals.structuredOutputSchema({
			type: "array",
			items: {
				oneOf: [
					{
						type: "object",
						properties: {
							id: { type: "integer" },
						},
					},
					{
						type: "object",
						properties: {
							id: { type: "integer" },
							extra: { type: "string" },
						},
					},
				],
			},
		});

		const itemSchema = schema?.items as Record<string, unknown>;
		expect(itemSchema.oneOf).toBeUndefined();
		expect(itemSchema.anyOf).toHaveLength(2);
	});

	it("keeps external input schemas from enforcing stale vendor enums", () => {
		const spec = {};
		const operation = {
			requestBody: {
				content: {
					"application/json": {
						schema: {
							type: "object",
							properties: {
								voucher: {
									type: "object",
									properties: {
										taxRule: {
											type: "object",
											properties: {
												id: {
													type: "string",
													enum: ["1", "2", "3", "4", "5", "11"],
												},
												objectName: {
													type: "string",
													const: "TaxRule",
												},
											},
										},
									},
								},
							},
						},
					},
				},
			},
		};

		const inputSchema = openApiToolImportTestInternals.inputSchemaForOperation(
			spec,
			{},
			operation,
		);
		const voucher = inputSchema.properties?.voucher as Record<string, unknown>;
		const taxRule = (voucher.properties as Record<string, unknown>)
			.taxRule as Record<string, unknown>;
		const taxRuleProperties = taxRule.properties as Record<string, unknown>;
		const taxRuleId = taxRuleProperties.id as Record<string, unknown>;
		const taxRuleObjectName = taxRuleProperties.objectName as Record<
			string,
			unknown
		>;

		expect(taxRuleId.enum).toBeUndefined();
		expect(taxRuleId.type).toBe("string");
		expect(taxRuleObjectName.const).toBeUndefined();
		expect(taxRuleObjectName.type).toBe("string");
	});

	it("drops impossible required fields that are absent from generated properties", () => {
		const spec = {};
		const operation = {
			requestBody: {
				content: {
					"application/json": {
						schema: {
							type: "object",
							required: ["voucher", "voucherPos"],
							properties: {
								voucher: { type: "object" },
								voucherPosSave: { type: "array" },
							},
						},
					},
				},
			},
		};

		const inputSchema = openApiToolImportTestInternals.inputSchemaForOperation(
			spec,
			{},
			operation,
		);

		expect(inputSchema.required).toEqual(["voucher"]);
		expect(inputSchema.properties?.voucherPosSave).toBeDefined();
	});

	it("preserves OpenAPI multipart uploads as file-aware MCP inputs", () => {
		const spec = {};
		const operation = {
			requestBody: {
				required: true,
				content: {
					"form-data": {
						schema: {
							type: "object",
							required: ["file"],
							properties: {
								file: {
									description: "The file to upload",
									type: "string",
									format: "binary",
								},
							},
						},
					},
				},
			},
		};

		const inputSchema = openApiToolImportTestInternals.inputSchemaForOperation(
			spec,
			{},
			operation,
		);
		const bodyInfo = openApiToolImportTestInternals.requestBodyInfo(
			spec,
			operation,
		);
		const fileParams = openApiToolImportTestInternals.collectTopLevelFileParams(
			bodyInfo?.schema,
		);
		const file = inputSchema.properties?.file as Record<string, unknown>;

		expect(bodyInfo?.contentType).toBe("multipart/form-data");
		expect(fileParams).toEqual(["file"]);
		expect(inputSchema.required).toEqual(["file"]);
		expect(Array.isArray(file.anyOf)).toBe(true);
		expect(JSON.stringify(file)).toContain("base64");
	});

	it("does not treat JSON request fields with binary format as upload params", () => {
		const spec = {};
		const operation = {
			requestBody: {
				content: {
					"application/json": {
						schema: {
							type: "object",
							properties: {
								filename: {
									description: "Previously uploaded globex filename",
									type: "string",
									format: "binary",
								},
							},
						},
					},
				},
			},
		};

		const inputSchema = openApiToolImportTestInternals.inputSchemaForOperation(
			spec,
			{},
			operation,
		);
		const bodyInfo = openApiToolImportTestInternals.requestBodyInfo(
			spec,
			operation,
		);
		const filename = inputSchema.properties?.filename as Record<
			string,
			unknown
		>;

		expect(bodyInfo?.contentType).toBe("application/json");
		expect(filename.type).toBe("string");
		expect(filename.format).toBeUndefined();
		expect(filename.anyOf).toBeUndefined();
	});

	it("preserves text markdown request bodies for generated external tools", () => {
		const spec = {};
		const operation = {
			requestBody: {
				required: true,
				content: {
					"text/markdown": {
						schema: {
							type: "string",
						},
					},
				},
			},
		};

		const inputSchema = openApiToolImportTestInternals.inputSchemaForOperation(
			spec,
			{},
			operation,
		);
		const bodyInfo = openApiToolImportTestInternals.requestBodyInfo(
			spec,
			operation,
		);

		expect(bodyInfo?.contentType).toBe("text/markdown");
		expect(inputSchema.properties?.body).toEqual({ type: "string" });
		expect(inputSchema.required).toEqual(["body"]);
	});

	it("marks synthetic request body params for non-object OpenAPI bodies", () => {
		const { requestBodyParamForSchema } = openApiToolImportTestInternals;

		expect(requestBodyParamForSchema({ type: "string" })).toBe("body");
		expect(requestBodyParamForSchema({})).toBe("body");
		expect(
			requestBodyParamForSchema({
				type: "object",
				properties: { query: { type: "string" } },
			}),
		).toBeNull();
	});

	it("preserves vendor JSON request content types", () => {
		const { toolRequestContentType } = openApiToolImportTestInternals;

		expect(toolRequestContentType("application/json")).toBe("application/json");
		expect(
			toolRequestContentType("application/vnd.olrapi.jsonlogic+json"),
		).toBe("application/vnd.olrapi.jsonlogic+json");
	});

	it("tracks OpenAPI header and query parameter locations for external tools", () => {
		const { parameterNamesByLocation } = openApiToolImportTestInternals;
		const operation = {
			parameters: [
				{
					name: "Target-Type",
					in: "header",
					required: true,
					schema: { type: "string" },
				},
				{
					name: "Target",
					in: "header",
					required: true,
					schema: { type: "string" },
				},
				{
					name: "query",
					in: "query",
					required: true,
					schema: { type: "string" },
				},
			],
		};

		expect(parameterNamesByLocation({}, {}, operation, "header")).toEqual([
			"Target-Type",
			"Target",
		]);
		expect(parameterNamesByLocation({}, {}, operation, "query")).toEqual([
			"query",
		]);
	});

	it("derives a default json-render table widget from array output schemas", () => {
		const schema = openApiToolImportTestInternals.structuredOutputSchema({
			type: "object",
			properties: {
				deployments: {
					type: "array",
					items: {
						type: "object",
						properties: {
							id: { type: "string" },
							status: { type: "string" },
							market: { type: "string" },
							createdAt: { type: "string", format: "date-time" },
							replicas: { type: "integer" },
							logs: { type: "object" },
						},
					},
				},
				pagination: { type: "object" },
			},
		});

		const widget = openApiToolImportTestInternals.defaultOpenApiWidgetForOutput(
			"get_deployments",
			schema,
		);
		const layoutSpec = widget?.config.layoutSpec as Record<string, unknown>;
		const elements = layoutSpec.elements as Record<
			string,
			Record<string, unknown>
		>;
		const table = elements.table as Record<string, unknown>;
		const tableProps = table.props as Record<string, unknown>;
		const columns = tableProps.columns as Array<Record<string, unknown>>;

		expect(widget?.widgetKey).toBe("render");
		expect(widget?.config.layoutId).toBe("deployments");
		expect(tableProps.data).toEqual({ $state: "/deployments" });
		expect(columns.map((column) => column.field)).toEqual([
			"id",
			"status",
			"market",
			"createdAt",
			"replicas",
		]);
		expect(columns.find((column) => column.field === "status")?.format).toBe(
			"badge",
		);
		expect(columns.find((column) => column.field === "createdAt")?.format).toBe(
			"date",
		);
		expect(columns.find((column) => column.field === "replicas")?.format).toBe(
			"number",
		);
	});

	it("applies OpenAPI widget defaults without app-specific widget code", () => {
		const schema = openApiToolImportTestInternals.structuredOutputSchema({
			type: "object",
			properties: {
				deployments: {
					type: "array",
					items: {
						type: "object",
						properties: {
							id: { type: "string" },
							status: { type: "string" },
							market: { type: "string" },
						},
					},
				},
			},
		});

		const widget = openApiToolImportTestInternals.defaultOpenApiWidgetForOutput(
			"get_deployments",
			schema,
			{
				layoutId: "deployment-list",
				title: "GPU jobs",
				dataPath: "deployments",
				pageSize: 20,
				compact: false,
				striped: false,
				columns: [
					{ field: "id", header: "Deployment", width: "16rem" },
					{ field: "status", format: "badge" },
				],
			},
		);
		const layoutSpec = widget?.config.layoutSpec as Record<string, unknown>;
		const elements = layoutSpec.elements as Record<
			string,
			Record<string, unknown>
		>;
		const title = elements.title as Record<string, unknown>;
		const titleProps = title.props as Record<string, unknown>;
		const table = elements.table as Record<string, unknown>;
		const tableProps = table.props as Record<string, unknown>;
		const columns = tableProps.columns as Array<Record<string, unknown>>;

		expect(widget?.widgetKey).toBe("render");
		expect(widget?.config.layoutId).toBe("deployment-list");
		expect(titleProps.text).toBe("GPU jobs");
		expect(tableProps.data).toEqual({ $state: "/deployments" });
		expect(tableProps.pageSize).toBe(20);
		expect(tableProps.compact).toBe(false);
		expect(tableProps.striped).toBe(false);
		expect(columns).toEqual([
			{
				field: "id",
				header: "Deployment",
				format: "text",
				sortable: true,
				width: "16rem",
			},
			{
				field: "status",
				header: "Status",
				format: "badge",
				sortable: true,
			},
		]);
	});

	it("resolves per-tool widget overrides before global widget defaults", () => {
		const { widgetDefaultsForTool } = openApiToolImportTestInternals;
		const input = {
			appId: "7a2f8b3c-d4e5-4f6a-b1c2-3d4e5f6a7b8c",
			baseUrl: "https://api.example.com",
			specUrl: "https://api.example.com/openapi.json",
			widgetDefaults: {
				pageSize: 10,
				compact: true,
			},
			widgetOverrides: {
				get_deployments: {
					title: "Deployments",
					pageSize: 20,
				},
				listMarkets: {
					title: "Markets",
				},
			},
		};

		expect(
			widgetDefaultsForTool(input, "get_deployments", "listDeployments"),
		).toEqual({
			title: "Deployments",
			pageSize: 20,
		});
		expect(widgetDefaultsForTool(input, "get_markets", "listMarkets")).toEqual({
			title: "Markets",
		});
		expect(widgetDefaultsForTool(input, "get_vaults", null)).toEqual({
			pageSize: 10,
			compact: true,
		});
	});

	it("derives default table columns from composed OpenAPI item schemas", () => {
		const schema = openApiToolImportTestInternals.structuredOutputSchema({
			type: "object",
			properties: {
				deployments: {
					type: "array",
					items: {
						allOf: [
							{
								type: "object",
								properties: {
									id: { type: "string" },
									name: { type: "string" },
									status: {
										anyOf: [
											{ type: "string", enum: ["RUNNING"] },
											{ type: "string", enum: ["STOPPED"] },
										],
									},
									market: { type: "string" },
									replicas: { type: "number" },
									created_at: { type: "string" },
								},
							},
							{
								anyOf: [
									{
										type: "object",
										properties: {
											strategy: { type: "string" },
										},
									},
								],
							},
						],
					},
				},
			},
		});

		const widget = openApiToolImportTestInternals.defaultOpenApiWidgetForOutput(
			"get_deployments",
			schema,
		);
		const layoutSpec = widget?.config.layoutSpec as Record<string, unknown>;
		const elements = layoutSpec.elements as Record<
			string,
			Record<string, unknown>
		>;
		const table = elements.table as Record<string, unknown>;
		const tableProps = table.props as Record<string, unknown>;
		const columns = tableProps.columns as Array<Record<string, unknown>>;

		expect(widget?.widgetKey).toBe("render");
		expect(columns.map((column) => column.field)).toEqual([
			"id",
			"name",
			"status",
			"market",
			"created_at",
			"replicas",
			"strategy",
		]);
		expect(columns.find((column) => column.field === "status")?.format).toBe(
			"badge",
		);
	});

	it("matches OpenAPI operation path prefixes on segment boundaries", () => {
		const { matchesPathPrefix } = openApiToolImportTestInternals;

		expect(matchesPathPrefix("/v1/mgmt/user", "/v1/mgmt")).toBe(true);
		expect(matchesPathPrefix("/v1/mgmt", "v1/mgmt")).toBe(true);
		expect(matchesPathPrefix("/v1/mgmt-user", "/v1/mgmt")).toBe(false);
		expect(matchesPathPrefix("/oauth2/v1/apps/token", "/v1/mgmt")).toBe(false);
	});

	it("strips OpenAPI path prefixes before generating external endpoints", () => {
		const { applyStripPathPrefixes } = openApiToolImportTestInternals;

		expect(applyStripPathPrefixes("/api/markets/{id}/", ["/api"])).toBe(
			"/markets/{id}/",
		);
		expect(applyStripPathPrefixes("/api", ["/api"])).toBe("/");
		expect(applyStripPathPrefixes("/apiary/markets", ["/api"])).toBe(
			"/apiary/markets",
		);
		expect(applyStripPathPrefixes("/api/v2/markets", ["/api", "/api/v2"])).toBe(
			"/markets",
		);
	});

	it("derives tool auth from OpenAPI operation security", () => {
		const { operationRequiresAuth } = openApiToolImportTestInternals;
		const rootAuthedSpec = { security: [{ Authorization: [] }] };

		expect(operationRequiresAuth({}, {})).toBe(false);
		expect(operationRequiresAuth({}, {}, true)).toBe(true);
		expect(operationRequiresAuth(rootAuthedSpec, {})).toBe(true);
		expect(operationRequiresAuth(rootAuthedSpec, { security: [] })).toBe(false);
		expect(operationRequiresAuth(rootAuthedSpec, { security: [] }, true)).toBe(
			false,
		);
		expect(operationRequiresAuth(rootAuthedSpec, { security: [{}] })).toBe(
			false,
		);
		expect(
			operationRequiresAuth({}, { security: [{ Authorization: [] }] }),
		).toBe(true);
	});

	it("derives MCP annotations from HTTP method semantics", () => {
		const { annotationsForMethod, writeCapabilityForMethod } =
			openApiToolImportTestInternals;

		expect(annotationsForMethod("GET")).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		});
		expect(annotationsForMethod("POST")).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		});
		expect(annotationsForMethod("DELETE")).toEqual({
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: true,
		});
		expect(writeCapabilityForMethod("GET")).toBe("read");
		expect(writeCapabilityForMethod("POST")).toBe("write");
		expect(writeCapabilityForMethod("PUT")).toBe("write");
		expect(writeCapabilityForMethod("PATCH")).toBe("write");
		expect(writeCapabilityForMethod("DELETE")).toBe("destructive");
	});

	it("omits provider-injected credential headers from generated input schemas", () => {
		const { inputSchemaForOperation, providerManagedCredentialHeaderNames } =
			openApiToolImportTestInternals;
		const operation = {
			parameters: [
				{
					name: "authorization",
					in: "header",
					required: true,
					description:
						"Authentication token, either an API key or wallet-signed message.",
					schema: { type: "string" },
				},
				{
					name: "x-nosana-api",
					in: "header",
					required: false,
					description: "Nosana API key",
					schema: { type: "string" },
				},
				{
					name: "x-user-id",
					in: "header",
					required: true,
					description:
						"Required when using Wallet Authentication. The public key used to sign authentication header.",
					schema: { type: "string" },
				},
				{
					name: "x-request-id",
					in: "header",
					required: false,
					description: "Caller trace identifier",
					schema: { type: "string" },
				},
				{
					name: "deployment",
					in: "path",
					required: true,
					schema: { type: "string" },
				},
			],
		};
		const omitParameterNames = providerManagedCredentialHeaderNames(
			{},
			{},
			operation,
			"Authorization",
		);
		const schema = inputSchemaForOperation({}, {}, operation, {
			omitParameterNames,
		});

		expect(schema.properties?.authorization).toBeUndefined();
		expect(schema.properties?.["x-nosana-api"]).toBeUndefined();
		expect(schema.properties?.["x-user-id"]).toBeUndefined();
		expect(schema.properties?.["x-request-id"]).toEqual({ type: "string" });
		expect(schema.properties?.deployment).toEqual({ type: "string" });
		expect(schema.required).toEqual(["deployment"]);
	});

	it("matches existing endpoint keys regardless of leading slash style", () => {
		const { endpointKey } = openApiToolImportTestInternals;

		expect(endpointKey("GET", "/v1/mgmt/accesskey")).toBe(
			endpointKey("get", "v1/mgmt/accesskey"),
		);
	});

	it("preserves D1 widget projection overlays across OpenAPI resync", () => {
		const { mergeOpenApiConfigOverlay } = openApiToolImportTestInternals;

		expect(
			mergeOpenApiConfigOverlay(
				{
					transport: "external",
					method: "GET",
					baseUrl: "https://dashboard.k8s.prd.nos.ci/api",
					endpoint: "deployments",
				},
				{
					transport: "external",
					method: "GET",
					baseUrl: "https://old.example.com",
					endpoint: "old",
					layoutId: "nosana-deployments",
					layoutSpec: {
						root: "root",
						elements: {
							root: { type: "Heading", props: { text: "Nosana" } },
						},
					},
				},
			),
		).toMatchObject({
			baseUrl: "https://dashboard.k8s.prd.nos.ci/api",
			endpoint: "deployments",
			layoutId: "nosana-deployments",
			layoutSpec: {
				root: "root",
			},
		});
	});

	it("lets explicit widget defaults replace stale D1 widget projection overlays", () => {
		const { mergeOpenApiConfigOverlay } = openApiToolImportTestInternals;

		expect(
			mergeOpenApiConfigOverlay(
				{
					transport: "external",
					method: "GET",
					baseUrl: "https://dashboard.k8s.prd.nos.ci/api",
					endpoint: "deployments",
					layoutId: "deployments",
					layoutSpec: {
						root: "shell",
						elements: {
							shell: {
								type: "Stack",
								props: { gap: 4 },
								children: ["table"],
							},
						},
					},
				},
				{
					layoutId: "stale-nosana-deployments",
					layoutSpec: {
						root: "legacy",
						elements: {
							legacy: { type: "Heading", props: { text: "Old" } },
						},
					},
				},
				{ preserveWidgetProjection: false },
			),
		).toMatchObject({
			layoutId: "deployments",
			layoutSpec: {
				root: "shell",
			},
		});
	});

	it("keeps recursive OpenAPI refs finite for MCP tool schemas", () => {
		const { inputSchemaForOperation } = openApiToolImportTestInternals;
		const spec = {
			components: {
				schemas: {
					TreeNode: {
						type: "object",
						required: ["id"],
						properties: {
							id: { type: "string" },
							children: {
								type: "array",
								items: { $ref: "#/components/schemas/TreeNode" },
							},
						},
					},
				},
			},
		};

		const schema = inputSchemaForOperation(
			spec,
			{},
			{
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: { $ref: "#/components/schemas/TreeNode" },
						},
					},
				},
			},
		);

		const children = schema.properties?.children as Record<string, unknown>;
		const childItems = children.items as Record<string, unknown>;
		const idProperty = schema.properties?.id as
			| Record<string, unknown>
			| undefined;

		expect(schema.required).toEqual(["id"]);
		expect(idProperty?.type).toBe("string");
		expect(children.type).toBe("array");
		expect(childItems.type).toBe("object");
		expect(childItems.additionalProperties).toBe(true);
		expect(String(childItems.description)).toContain(
			"#/components/schemas/TreeNode",
		);
	});
});

describe("allowlist clearing", () => {
	const appId = "7a2f8b3c-d4e5-4f6a-b1c2-3d4e5f6a7b8c";
	const stored = {
		includeOperationIds: ["orders.list", "orders.detail"],
		includePathPrefixes: ["/orders"],
	};

	it("keeps a stored allowlist when the caller omits it", () => {
		const merged = openApiToolImportTestInternals.mergeStoredOpenApiImportInput(
			{ appId, dryRun: false },
			stored,
		);
		expect(merged.includeOperationIds).toEqual([
			"orders.list",
			"orders.detail",
		]);
		expect(merged.includePathPrefixes).toEqual(["/orders"]);
	});

	it("clears a stored allowlist when the caller passes null", () => {
		// Without this, a filter supplied once was re-persisted on every later
		// sync and silently excluded every endpoint added afterwards.
		const merged = openApiToolImportTestInternals.mergeStoredOpenApiImportInput(
			{
				appId,
				dryRun: false,
				includeOperationIds: null,
				includePathPrefixes: null,
			},
			stored,
		);
		expect(merged.includeOperationIds).toBeUndefined();
		expect(merged.includePathPrefixes).toBeUndefined();
	});

	it("still replaces a stored allowlist with an explicit one", () => {
		const merged = openApiToolImportTestInternals.mergeStoredOpenApiImportInput(
			{ appId, dryRun: false, includeOperationIds: ["customers.detail"] },
			stored,
		);
		expect(merged.includeOperationIds).toEqual(["customers.detail"]);
	});
});
