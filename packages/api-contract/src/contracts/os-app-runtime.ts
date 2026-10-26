import "@orpc/openapi/extensions/route";
import { oc } from "@orpc/contract";
import { z } from "zod";
import { baseErrors } from "../errors";
import { JsonValueSchema } from "../schemas/common";
import {
	OsGadgetResourceGrantSchema,
	OsOutputContentSchema,
} from "../schemas/os-workspaces";
import {
	AppRuntimeScopeSchema,
	AppRuntimeMethodSchema,
	AppRuntimeArgumentsSchema,
	AppRuntimeSessionResultSchema,
	AppRuntimeOperationSchema,
} from "../schemas/os-app-runtime";

export const osAppRuntimeContract = oc
	.route({ tags: ["os-app-runtime"], prefix: "/os-app-runtime" })
	.errors(baseErrors)
	.router({
		client: oc
			.route({
				method: "POST",
				path: "/client",
				summary: "Read the opened app's browser client",
			})
			.input(AppRuntimeScopeSchema.strict())
			.output(
				AppRuntimeSessionResultSchema.extend({
					client: z.string(),
					revision: z.number().int().positive(),
					settings: z.record(z.string(), JsonValueSchema),
					grants: z.array(OsGadgetResourceGrantSchema),
				}),
			),
		readOutput: oc
			.route({
				method: "POST",
				path: "/read-output",
				summary: "Read an Output through an opened app slot",
			})
			.input(
				AppRuntimeScopeSchema.extend({
					session: z.string().min(1).max(16000),
					slot: z.string().min(1).max(160),
				}).strict(),
			)
			.output(OsOutputContentSchema),
		open: oc
			.route({
				method: "POST",
				path: "/open",
				summary: "Open the deployed workspace app",
			})
			.input(AppRuntimeScopeSchema.strict())
			.output(AppRuntimeSessionResultSchema),
		call: oc
			.route({
				method: "POST",
				path: "/call",
				summary: "Call a workspace app with a scoped session",
			})
			.input(
				AppRuntimeScopeSchema.extend({
					session: z.string().min(1).max(16000),
					method: AppRuntimeMethodSchema,
					args: AppRuntimeArgumentsSchema.default([]),
				}).strict(),
			)
			.output(z.object({ result: JsonValueSchema })),
		preview: oc
			.route({
				method: "POST",
				path: "/preview",
				summary: "Open an isolated preview of an app revision",
			})
			.input(
				AppRuntimeScopeSchema.extend({
					revisionId: z.uuid(),
					previewId: z.uuid(),
				}).strict(),
			)
			.output(AppRuntimeSessionResultSchema),
		capability: oc
			.route({
				method: "POST",
				path: "/capability",
				tags: ["internal"],
				summary: "Invoke a signed app resource capability",
			})
			.input(
				z
					.object({
						session: z.string().max(16000),
						operation: AppRuntimeOperationSchema,
						slot: z.string().min(1).max(160),
						args: JsonValueSchema,
					})
					.strict(),
			)
			.output(JsonValueSchema),
		recordTail: oc
			.route({
				method: "POST",
				path: "/tail",
				tags: ["internal"],
				summary: "Record an app trace in the gadget execution ledger",
			})
			.input(
				AppRuntimeScopeSchema.extend({
					organizationId: z.string().min(1),
					tailId: z.uuid(),
					revisionId: z.uuid(),
					events: z.array(JsonValueSchema).max(10),
				}).strict(),
			)
			.output(z.object({ recorded: z.boolean() })),
	});
