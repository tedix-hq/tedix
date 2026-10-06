import * as z from "zod";
const PortableWebMcpScalarSchema = z.union([
	z.string(),
	z.number(),
	z.boolean(),
	z.null(),
]);
const PortableWebMcpFieldSchema = z.object({
	type: z.enum(["string", "number", "integer", "boolean"]),
	description: z
		.string()
		.max(500)
		.optional()
		.describe("Optional agent-facing field guidance."),
	enum: z
		.array(PortableWebMcpScalarSchema)
		.max(100)
		.optional()
		.describe("Optional bounded scalar choices."),
	default: PortableWebMcpScalarSchema.optional().describe(
		"Optional browser-agent default value.",
	),
	minLength: z
		.number()
		.int()
		.nonnegative()
		.optional()
		.describe("Optional string lower bound."),
	maxLength: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("Optional string upper bound."),
	minimum: z.number().optional().describe("Optional numeric lower bound."),
	maximum: z.number().optional().describe("Optional numeric upper bound."),
	pattern: z
		.string()
		.max(300)
		.optional()
		.describe("Optional string validation pattern."),
});
const PortableWebMcpJsonSchema = z.object({
	type: z.literal("object"),
	properties: z
		.record(z.string(), PortableWebMcpFieldSchema)
		.optional()
		.describe("Optional public tool input fields."),
	required: z
		.array(z.string())
		.max(50)
		.optional()
		.describe("Optional names of required public fields."),
	additionalProperties: z.literal(false),
});

export const PortableWebMcpBindingSourceSchema = z
	.string()
	.regex(/^\$(?:route|context)\.[A-Za-z][A-Za-z0-9_.-]{0,127}$/);

export const PortableWebMcpToolSchema = z
	.object({
		authority: z
			.enum(["host", "tedix_tenant"])
			.optional()
			.describe("Authority plane used to admit and execute this callable."),
		callable: z
			.string()
			.regex(/^[a-z][a-z0-9_]{1,127}\.[a-z][a-z0-9_]{1,127}$/),
		name: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/),
		description: z.string().trim().min(1).max(1_000),
		inputSchema: PortableWebMcpJsonSchema,
		bind: z
			.record(
				z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/),
				PortableWebMcpBindingSourceSchema,
			)
			.optional()
			.describe(
				"Optional argument bindings sourced from bounded route context.",
			),
		resultFields: z
			.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/))
			.max(40)
			.optional()
			.describe("Optional compact result field projection."),
		action: z
			.object({
				prepareCallable: z
					.string()
					.regex(/^[a-z][a-z0-9_]{1,127}\.[a-z][a-z0-9_]{1,127}$/),
				convergeCallable: z
					.string()
					.regex(/^[a-z][a-z0-9_]{1,127}\.[a-z][a-z0-9_]{1,127}$/),
				confirmationTitle: z.string().trim().min(1).max(160),
				confirmationLabel: z.string().trim().min(1).max(80),
				prepareFields: z
					.array(z.string())
					.max(50)
					.optional()
					.describe(
						"Optional write-argument projection for compatibility with the preparation tool.",
					),
				convergeFields: z
					.array(z.string())
					.max(50)
					.optional()
					.describe(
						"Optional write-argument projection for compatibility with the convergence tool.",
					),
			})
			.optional()
			.describe(
				"Required for a write tool: a read-only preparation call, explicit browser confirmation copy, and optional read-only convergence call.",
			),
		annotations: z.object({
			readOnlyHint: z.boolean(),
			untrustedContentHint: z
				.boolean()
				.optional()
				.describe("Optional browser hint for provider-authored results."),
		}),
	})
	.superRefine((tool, context) => {
		if (tool.annotations.readOnlyHint === false && !tool.action)
			context.addIssue({
				code: "custom",
				path: ["action"],
				message: "Portable write tools require an explicit action contract",
			});
		if (tool.annotations.readOnlyHint === true && tool.action)
			context.addIssue({
				code: "custom",
				path: ["action"],
				message: "Read-only portable tools cannot declare an action contract",
			});
	});

export const PortableWebMcpRouteSchema = z.object({
	id: z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/),
	match: z
		.object({
			pathname: z
				.string()
				.startsWith("/")
				.max(500)
				.optional()
				.describe("Optional host pathname pattern."),
			routeKey: z
				.string()
				.trim()
				.min(1)
				.max(120)
				.optional()
				.describe("Optional stable host route identifier."),
		})
		.refine((value) => Boolean(value.pathname || value.routeKey), {
			message: "A Portable WebMCP route needs pathname or routeKey",
		}),
	tools: z.array(PortableWebMcpToolSchema).min(1).max(20),
});

export const PortableWebMcpProfileSchema = z.object({
	version: z.literal(1),
	routes: z.array(PortableWebMcpRouteSchema).max(50),
});

export type PortableWebMcpProfile = z.infer<typeof PortableWebMcpProfileSchema>;
export type PortableWebMcpTool = z.infer<typeof PortableWebMcpToolSchema>;
