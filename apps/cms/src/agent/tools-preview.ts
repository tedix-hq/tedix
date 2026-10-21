import type { McpServer } from "@tedix/mcp-shared/server";
import * as z from "zod";
import {
	cancelCmsPreviewExec,
	readCmsPreviewExecStatus,
	startCmsPreviewExec,
} from "./preview-exec-runner";
import {
	CMS_PREVIEW_EXPOSURES,
	readCmsPreviewStatus,
	startCmsPreview,
	stopCmsPreview,
} from "./preview-runner";
import {
	schema,
	SANDBOX_LAUNCH_TIMEOUT_MS,
	withSandboxTimeout,
	previewStatusOutput,
	previewExecOutput,
	type PreviewExecOutput,
	cmsPreviewExecStatusKey,
	updateStoredJobReceipt,
	type SiteBuilderToolContext,
} from "./tools-shared";

export function registerPreviewTools(
	server: McpServer,
	ctx: SiteBuilderToolContext,
): void {
	const previewExposureSchema = z
		.enum(CMS_PREVIEW_EXPOSURES)
		.optional()
		.describe(
			"Preview URL exposure through the authenticated CMS preview route.",
		);
	const previewOutputSchema = schema(
		z.object({
			status: z.enum(["starting", "running", "stopped", "failed", "not_found"]),
			processStatus: z.string().nullable(),
			running: z.boolean(),
			processId: z.string(),
			port: z.number().int(),
			previewUrl: z.string().nullable(),
			previewUrlMode: z.enum(CMS_PREVIEW_EXPOSURES).nullable(),
			previewUrlEphemeral: z.boolean(),
			startedAt: z.string().nullable(),
			durationMs: z.number().int().nullable(),
			exitCode: z.number().int().nullable(),
			logTail: z.string(),
			message: z.string(),
		}),
	);

	server.registerTool(
		"theme_preview_start",
		{
			title: "Start Theme Preview",
			description:
				"Start or reuse the Astro dev server behind the authenticated CMS preview route. " +
				"The preview shows the theme with the org's real CMS content and reloads when theme files change.",
			inputSchema: schema(z.object({ exposure: previewExposureSchema })),
			outputSchema: previewOutputSchema,
		},
		async (args: { exposure?: (typeof CMS_PREVIEW_EXPOSURES)[number] }) => {
			const snapshot = await withSandboxTimeout(
				ctx,
				"theme_preview_start",
				startCmsPreview(ctx.sandbox, {
					previewHostname: ctx.previewHostname,
					exposure: args.exposure,
				}),
				95_000,
			);
			const output = previewStatusOutput(snapshot);

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(output, null, 2),
					},
				],
				structuredContent: output,
				isError: output.status === "failed" ? (true as const) : undefined,
			};
		},
	);

	server.registerTool(
		"theme_preview_status",
		{
			title: "Check Theme Preview Status",
			description:
				"Check the Astro dev preview process and authenticated preview URL without starting a new process.",
			inputSchema: schema(z.object({ exposure: previewExposureSchema })),
			outputSchema: previewOutputSchema,
			annotations: { readOnlyHint: true },
		},
		async (args: { exposure?: (typeof CMS_PREVIEW_EXPOSURES)[number] }) => {
			const snapshot = await withSandboxTimeout(
				ctx,
				"theme_preview_status",
				readCmsPreviewStatus(ctx.sandbox, {
					previewHostname: ctx.previewHostname,
					preferredExposure: args.exposure,
				}),
			);
			const output = previewStatusOutput(snapshot);

			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(output, null, 2) },
				],
				structuredContent: output,
				isError: output.status === "failed" ? (true as const) : undefined,
			};
		},
	);

	server.registerTool(
		"theme_preview_stop",
		{
			title: "Stop Theme Preview",
			description: "Stop the Astro dev preview process.",
			inputSchema: schema(z.object({})),
			outputSchema: previewOutputSchema,
			annotations: { destructiveHint: true },
		},
		async () => {
			const snapshot = await withSandboxTimeout(
				ctx,
				"theme_preview_stop",
				stopCmsPreview(ctx.sandbox, ctx.previewHostname),
			);
			const output = previewStatusOutput(snapshot);

			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(output, null, 2) },
				],
				structuredContent: output,
				isError: output.status === "failed" ? (true as const) : undefined,
			};
		},
	);

	server.registerTool(
		"theme_preview_exec",
		{
			title: "Run Command in Preview Container",
			description:
				"Start a command in an preview process without holding a long Sandbox control request open. " +
				"Useful for checking build errors, inspecting files, or running astro check. " +
				"Returns a jobId immediately; poll theme_preview_exec_status until complete or failed.",
			inputSchema: schema(
				z.object({
					command: z.string().describe("Shell command to execute"),
					waitMs: z
						.number()
						.int()
						.min(0)
						.max(45_000)
						.optional()
						.describe(
							"Optional initial wait before returning status. Default 3000ms, max 45000ms.",
						),
					timeoutMs: z
						.number()
						.int()
						.min(1000)
						.max(120_000)
						.optional()
						.describe("Maximum command runtime before status reports timeout."),
				}),
			),
			outputSchema: schema(
				z.object({
					jobId: z.string(),
					status: z.enum([
						"running",
						"complete",
						"failed",
						"timeout",
						"cancelled",
					]),
					exitCode: z.number().int().nullable(),
					running: z.boolean(),
					command: z.string(),
					startedAt: z.string().nullable(),
					durationMs: z.number().int().nullable(),
					stdoutTail: z.string(),
					stderrTail: z.string(),
					logTail: z.string(),
					message: z.string(),
				}),
			),
		},
		async (args: { command: string; waitMs?: number; timeoutMs?: number }) => {
			const launch = await withSandboxTimeout(
				ctx,
				`theme_preview_exec ${String(args.command).slice(0, 120)}`,
				startCmsPreviewExec(ctx.sandbox, {
					command: args.command,
					timeoutMs: args.timeoutMs,
				}),
				SANDBOX_LAUNCH_TIMEOUT_MS,
			);
			let snapshot = await readCmsPreviewExecStatus(ctx.sandbox, launch.jobId, {
				command: args.command,
				timeoutMs: args.timeoutMs,
			});
			const waitMs = args.waitMs ?? 3000;
			const deadline = Date.now() + waitMs;
			while (snapshot.status === "running" && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 1000));
				snapshot = await readCmsPreviewExecStatus(ctx.sandbox, launch.jobId, {
					command: args.command,
					timeoutMs: args.timeoutMs,
				});
			}
			const output = await updateStoredJobReceipt(
				ctx.storage,
				cmsPreviewExecStatusKey(ctx.orgSlug, snapshot.jobId),
				async () => previewExecOutput(snapshot),
			);

			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(output, null, 2) },
				],
				structuredContent: output,
				isError:
					output.status === "failed" || output.status === "timeout"
						? (true as const)
						: undefined,
			};
		},
	);

	server.registerTool(
		"theme_preview_exec_status",
		{
			title: "Check Preview Command Status",
			description:
				"Check a command job started by theme_preview_exec. Uses short Sandbox process probes and returns stdout/stderr tails.",
			inputSchema: schema(
				z.object({
					jobId: z
						.string()
						.regex(/^[a-zA-Z0-9._-]{1,96}$/)
						.describe("Job ID returned by theme_preview_exec."),
					timeoutMs: z
						.number()
						.int()
						.min(1000)
						.max(120_000)
						.optional()
						.describe("Maximum command runtime before status reports timeout."),
				}),
			),
			outputSchema: schema(
				z.object({
					jobId: z.string(),
					status: z.enum([
						"running",
						"complete",
						"failed",
						"timeout",
						"cancelled",
					]),
					exitCode: z.number().int().nullable(),
					running: z.boolean(),
					command: z.string(),
					startedAt: z.string().nullable(),
					durationMs: z.number().int().nullable(),
					stdoutTail: z.string(),
					stderrTail: z.string(),
					logTail: z.string(),
					message: z.string(),
				}),
			),
			annotations: { readOnlyHint: true },
		},
		async (args: { jobId: string; timeoutMs?: number }) => {
			const output = await updateStoredJobReceipt<PreviewExecOutput>(
				ctx.storage,
				cmsPreviewExecStatusKey(ctx.orgSlug, args.jobId),
				async (previous) =>
					previewExecOutput(
						await readCmsPreviewExecStatus(ctx.sandbox, args.jobId, {
							command: previous?.command,
							timeoutMs: args.timeoutMs,
						}),
					),
			);
			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(output, null, 2) },
				],
				structuredContent: output,
				isError:
					output.status === "failed" || output.status === "timeout"
						? (true as const)
						: undefined,
			};
		},
	);

	server.registerTool(
		"theme_preview_exec_cancel",
		{
			title: "Cancel Preview Command",
			description:
				"Cancel a running preview command job started by theme_preview_exec.",
			inputSchema: schema(
				z.object({
					jobId: z
						.string()
						.regex(/^[a-zA-Z0-9._-]{1,96}$/)
						.describe("Job ID returned by theme_preview_exec."),
				}),
			),
			outputSchema: schema(
				z.object({
					jobId: z.string(),
					status: z.enum([
						"running",
						"complete",
						"failed",
						"timeout",
						"cancelled",
					]),
					exitCode: z.number().int().nullable(),
					running: z.boolean(),
					command: z.string(),
					startedAt: z.string().nullable(),
					durationMs: z.number().int().nullable(),
					stdoutTail: z.string(),
					stderrTail: z.string(),
					logTail: z.string(),
					message: z.string(),
					cancelled: z.boolean(),
					previousStatus: z.string().nullable(),
				}),
			),
			annotations: { destructiveHint: true },
		},
		async (args: { jobId: string }) => {
			let cancellation:
				| { cancelled: boolean; previousStatus: string | null }
				| undefined;
			const receipt = await updateStoredJobReceipt<PreviewExecOutput>(
				ctx.storage,
				cmsPreviewExecStatusKey(ctx.orgSlug, args.jobId),
				async () => {
					const snapshot = await cancelCmsPreviewExec(ctx.sandbox, args.jobId);
					cancellation = snapshot;
					return previewExecOutput(snapshot);
				},
			);
			const output = {
				...receipt,
				cancelled:
					receipt.status === "cancelled" && (cancellation?.cancelled ?? false),
				previousStatus: cancellation?.previousStatus ?? receipt.status,
			};
			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(output, null, 2) },
				],
				structuredContent: output,
				isError:
					output.status === "failed" || output.status === "timeout"
						? (true as const)
						: undefined,
			};
		},
	);
}
