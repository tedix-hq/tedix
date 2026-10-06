import "@orpc/openapi/extensions/route";
/**
 * Widget Test Runs Contract
 * List and retrieve persisted widget test runs (static + interactive)
 *
 * Auth: User JWT or API key — org-scoped
 * Tagged "internal" — excluded from public OpenAPI spec
 */

import { oc } from "@orpc/contract";
import {
	WidgetTestRunGetInputSchema,
	WidgetTestRunListInputSchema,
	WidgetTestRunListOutputSchema,
	WidgetTestRunSchema,
} from "../schemas/widget-test-runs";

export const widgetTestRunsContract = oc
	.route({ tags: ["internal", "widget-test-runs"], prefix: "/widgetTestRuns" })
	.router({
		/**
		 * GET /widgetTestRuns/list — List recent test runs (org-scoped, optional app filter)
		 */
		list: oc
			.route({
				method: "GET",
				path: "/list",
				summary: "List widget test runs",
				description:
					"List recent widget test runs for the current org, optionally filtered by app slug",
			})
			.input(WidgetTestRunListInputSchema)
			.output(WidgetTestRunListOutputSchema),

		/**
		 * GET /widgetTestRuns/get — Get a single test run by ID
		 */
		get: oc
			.route({
				method: "GET",
				path: "/get",
				summary: "Get widget test run by ID",
				description:
					"Retrieve full details of a widget test run including steps, screenshots, and analysis",
			})
			.input(WidgetTestRunGetInputSchema)
			.output(WidgetTestRunSchema),
	});

export type WidgetTestRunsContract = typeof widgetTestRunsContract;
