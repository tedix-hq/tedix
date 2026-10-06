import type { NativeProcess } from "@tedix/container-runtime/sandbox";
import { type CmsJobClient } from "../sandbox";
import {
	startCmsJob,
	getCmsJob,
	readCmsProcessLogs,
	cmsProcessStartedAt,
	cmsProcessExitCode,
} from "./preview-exec-runner";

const WORKSPACE = "/workspace";
const PREVIEW_PORT = 4321;
const PREVIEW_COMMAND = [
	"bunx",
	"astro",
	"dev",
	"--port",
	"4321",
	"--host",
	"0.0.0.0",
] as const;

type SandboxPreviewClient = CmsJobClient;
export const CMS_PREVIEW_EXPOSURES = ["preview_url"] as const;
export type CmsPreviewExposure = (typeof CMS_PREVIEW_EXPOSURES)[number];
export type CmsPreviewStatus =
	| "starting"
	| "running"
	| "stopped"
	| "failed"
	| "not_found";

export interface CmsPreviewSnapshot {
	status: CmsPreviewStatus;
	processStatus: string | null;
	running: boolean;
	processId: string;
	port: number;
	previewUrl: string | null;
	previewUrlMode: CmsPreviewExposure | null;
	previewUrlEphemeral: boolean;
	startedAt: number | null;
	durationMs: number | null;
	exitCode: number | null;
	logTail: string;
	message: string;
}

export interface CmsPreviewStartOptions {
	previewHostname: string;
	exposure?: CmsPreviewExposure;
	waitForPortMs?: number;
}

export interface CmsPreviewReadOptions {
	previewHostname: string;
	preferredExposure?: CmsPreviewExposure;
}

function previewUrl(hostname: string): string {
	const protocol = hostname.startsWith("localhost") ? "http" : "https";
	return `${protocol}://${hostname}`;
}

function tailLines(output: string, limit = 80): string {
	const lines = output.split("\n");
	return lines.slice(Math.max(0, lines.length - limit)).join("\n");
}

function mapProcessStatus(status: string | null): CmsPreviewStatus {
	if (status === "running" || status === "starting") return status;
	if (status === "exited") return "stopped";
	if (status === "failed" || status === "error") return "failed";
	return "not_found";
}

async function snapshotFromProcess(
	process: NativeProcess | null,
	options: CmsPreviewReadOptions,
	message?: string,
): Promise<CmsPreviewSnapshot> {
	if (!process) {
		return {
			status: "not_found",
			processStatus: null,
			running: false,
			processId: "",
			port: PREVIEW_PORT,
			previewUrl: null,
			previewUrlMode: null,
			previewUrlEphemeral: false,
			startedAt: null,
			durationMs: null,
			exitCode: null,
			logTail: "",
			message: message ?? "CMS theme preview process was not found",
		};
	}
	const state = await process.status();
	const startedAt = cmsProcessStartedAt(state);
	const durationMs = startedAt === null ? null : Date.now() - startedAt;
	const logs = await readCmsProcessLogs(process);
	const combinedLogs = [logs.stdout, logs.stderr].filter(Boolean).join("\n");
	const mappedStatus = mapProcessStatus(state.state);
	return {
		status: mappedStatus,
		processStatus: state.state,
		running: mappedStatus === "starting" || mappedStatus === "running",
		processId: process.id,
		port: PREVIEW_PORT,
		previewUrl:
			mappedStatus === "running" ? previewUrl(options.previewHostname) : null,
		previewUrlMode: mappedStatus === "running" ? "preview_url" : null,
		previewUrlEphemeral: false,
		startedAt,
		durationMs,
		exitCode: cmsProcessExitCode(state),
		logTail: tailLines(combinedLogs),
		message:
			message ??
			(mappedStatus === "running" || mappedStatus === "starting"
				? "CMS theme preview is running"
				: `CMS theme preview is ${mappedStatus}`),
	};
}

export async function readCmsPreviewStatus(
	sandbox: SandboxPreviewClient,
	options: CmsPreviewReadOptions,
): Promise<CmsPreviewSnapshot> {
	return snapshotFromProcess(await getCmsJob(sandbox, "preview"), options);
}

export async function startCmsPreview(
	sandbox: SandboxPreviewClient,
	options: CmsPreviewStartOptions,
): Promise<CmsPreviewSnapshot> {
	const existing = await getCmsJob(sandbox, "preview");
	const existingStatus = existing ? (await existing.status()).state : null;
	const process =
		existing && existingStatus === "running"
			? existing
			: await startCmsJob(
					sandbox,
					"preview",
					PREVIEW_COMMAND,
					{ cwd: WORKSPACE },
					true,
				);
	await process.waitForPort(PREVIEW_PORT, {
		timeout: options.waitForPortMs ?? 90_000,
	});
	return snapshotFromProcess(
		process,
		{ previewHostname: options.previewHostname },
		"CMS theme preview is running",
	);
}

export async function stopCmsPreview(
	sandbox: SandboxPreviewClient,
	previewHostname: string,
): Promise<CmsPreviewSnapshot> {
	const process = await getCmsJob(sandbox, "preview");
	if (!process) {
		return snapshotFromProcess(
			null,
			{ previewHostname },
			"CMS theme preview process was not found",
		);
	}
	const state = await process.status();
	if (state.state === "running" || state.state === "starting") {
		await process.kill();
		await process.waitForExit({ timeout: 10_000 });
	}
	return {
		...(await snapshotFromProcess(
			process,
			{ previewHostname },
			"CMS theme preview stopped",
		)),
		status: "stopped",
		processStatus: "exited",
		running: false,
		previewUrl: null,
		previewUrlMode: null,
		previewUrlEphemeral: false,
	};
}
