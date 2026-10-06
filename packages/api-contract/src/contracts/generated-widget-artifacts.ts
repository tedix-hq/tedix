import "@orpc/openapi/extensions/route";
/**
 * Generated widget artifacts contract.
 *
 * Tedis use this surface to turn MCP tool output into durable GenUI records:
 * draft json-render specs, Browser QA progress, and published widget resources.
 */

import { oc } from "@orpc/contract";
import {
	AttachGeneratedWidgetQaRunInputSchema,
	CreateGeneratedWidgetArtifactInputSchema,
	CreateGeneratedWidgetArtifactOutputSchema,
	GeneratedWidgetArtifactMutationOutputSchema,
	GetGeneratedWidgetArtifactInputSchema,
	GetGeneratedWidgetArtifactOutputSchema,
	ListGeneratedWidgetArtifactsInputSchema,
	ListGeneratedWidgetArtifactsOutputSchema,
	PublishGeneratedWidgetArtifactInputSchema,
	RecordGeneratedWidgetArtifactProgressInputSchema,
} from "../schemas/generated-widget-artifacts";

export const generatedWidgetArtifactsContract = oc
	.route({
		tags: ["generated-widget-artifacts", "internal"],
		prefix: "/generatedWidgetArtifacts",
	})
	.router({
		create: oc
			.route({
				method: "POST",
				path: "/create",
				summary: "Create generated widget artifact",
				description:
					"Persist a generated MCP widget surface as a durable artifact for QA and publication.",
			})
			.input(CreateGeneratedWidgetArtifactInputSchema)
			.output(CreateGeneratedWidgetArtifactOutputSchema),

		list: oc
			.route({
				method: "GET",
				path: "/list",
				summary: "List generated widget artifacts",
				description:
					"List generated widget artifacts for the authenticated organization.",
			})
			.input(ListGeneratedWidgetArtifactsInputSchema)
			.output(ListGeneratedWidgetArtifactsOutputSchema),

		get: oc
			.route({
				method: "GET",
				path: "/get",
				summary: "Get generated widget artifact",
				description:
					"Retrieve one generated widget artifact with layout, QA, and publication metadata.",
			})
			.input(GetGeneratedWidgetArtifactInputSchema)
			.output(GetGeneratedWidgetArtifactOutputSchema),

		recordProgress: oc
			.route({
				method: "POST",
				path: "/record-progress",
				summary: "Record generated widget progress",
				description:
					"Update QA or publication progress for a generated widget artifact.",
			})
			.input(RecordGeneratedWidgetArtifactProgressInputSchema)
			.output(GeneratedWidgetArtifactMutationOutputSchema),

		attachQaRun: oc
			.route({
				method: "POST",
				path: "/attach-qa-run",
				summary: "Attach Browser QA run to generated widget",
				description:
					"Attach an existing widgetTest Browser QA run and copy its pass/fail, screenshot, preview, and summary onto the generated widget artifact.",
			})
			.input(AttachGeneratedWidgetQaRunInputSchema)
			.output(GeneratedWidgetArtifactMutationOutputSchema),

		publish: oc
			.route({
				method: "POST",
				path: "/publish",
				summary: "Publish generated widget artifact",
				description:
					"Mark a generated widget artifact as published and bind its renderable MCP UI resource metadata.",
			})
			.input(PublishGeneratedWidgetArtifactInputSchema)
			.output(GeneratedWidgetArtifactMutationOutputSchema),
	});

export type GeneratedWidgetArtifactsContract =
	typeof generatedWidgetArtifactsContract;
