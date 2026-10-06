import type { NativeProcess } from "@tedix/container-runtime/sandbox";
import { type CmsJobClient } from "../sandbox";
import {
	startCmsJob,
	getCmsJob,
	readCmsProcessLogs,
	cmsProcessStartedAt,
	cmsProcessDurationMs,
	cmsProcessExitCode,
	cmsProcessOutcome,
} from "./preview-exec-runner";
import { getCmsPrivacyBannerSetting } from "./storage";
import { CmsUnknownProcessOutcomeError } from "./cms-restore-permit";
const WORKSPACE = "/workspace";
export const CMS_BUILD_TIMEOUT_MS = 8 * 60 * 1000;
export const CMS_BUILD_OBSERVATION_GRACE_MS = 10_000;
export const CMS_BUILD_CONTROL_RPC_TIMEOUT_MS = 90_000;
export const CMS_BUILD_POLL_MS = 5000;
export const CMS_BUILD_SUCCESS_MARKERS = [
	"[build] Complete!",
	"[emdash] Build complete",
];
export type CmsBuildStatus =
	| "running"
	| "complete"
	| "failed"
	| "timeout"
	| "cancelled";

export interface CmsBuildSnapshot {
	jobId: string;
	status: CmsBuildStatus;
	exitCode: number | null;
	running: boolean;
	logTail: string;
	launchLog: string;
	startedAt: number | null;
	durationMs: number | null;
	successMarkerDetected: boolean;
	message: string;
}

export interface CmsBuildLaunch {
	jobId: string;
	process: NativeProcess;
	processId: string;
	startedAt: number;
}

export interface CmsBuildCancelSnapshot extends CmsBuildSnapshot {
	cancelled: boolean;
	previousStatus: string | null;
}

export interface CmsBuildOptions {
	jobId?: string;
	orgSlug?: string;
	publicSiteUrl?: string;
	publicPathPrefix?: string | null;
	privacyBannerEnabled?: boolean;
	workspace?: string;
	buildTimeoutMs?: number;
}

function publicBuildRoute(options: CmsBuildOptions): {
	publicSiteUrl: string;
	publicPathPrefix: string;
} {
	const slug = options.orgSlug ?? "preview";
	const rawSiteUrl =
		options.publicSiteUrl ??
		(slug === "preview" ? "https://preview.cms.tedix.dev" : null);
	if (!rawSiteUrl) throw new Error(`CMS site ${slug} has no public build URL`);
	let url: URL;
	try {
		url = new URL(rawSiteUrl);
	} catch {
		throw new Error(`CMS site ${slug} has an invalid public build URL`);
	}
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== "/"
	)
		throw new Error(`CMS site ${slug} must use a public HTTPS origin`);
	const prefix = options.publicPathPrefix ?? "";
	if (prefix && !/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(prefix))
		throw new Error(`CMS site ${slug} has an invalid public path prefix`);
	return { publicSiteUrl: url.origin, publicPathPrefix: prefix };
}

export function hasCmsBuildSuccessMarker(output: string): boolean {
	return CMS_BUILD_SUCCESS_MARKERS.some((marker) => output.includes(marker));
}
export async function resolveCmsPrivacyBannerEnabled(
	db: D1Database,
	orgSlug: string,
): Promise<boolean> {
	const value = await getCmsPrivacyBannerSetting(db, orgSlug);
	return value === 1 || value === true || value === "true";
}
function assertBuildJobId(jobId: string): void {
	if (!/^[a-zA-Z0-9._-]{1,128}$/.test(jobId))
		throw new Error(`Invalid CMS build jobId "${jobId}"`);
}
export async function startCmsSandboxBuild(
	sandbox: CmsJobClient,
	options: CmsBuildOptions = {},
): Promise<CmsBuildLaunch> {
	const jobId = options.jobId ?? `cms-${crypto.randomUUID()}`;
	assertBuildJobId(jobId);
	const route = publicBuildRoute(options);
	const process = await startCmsJob(
		sandbox,
		`build:${jobId}`,
		["bun", "run", "build"],
		{
			cwd: options.workspace ?? WORKSPACE,
			// Explicit public build inputs only: Astro statically inlines build-time secrets.
			env: {
				ORG_SLUG: options.orgSlug ?? "preview",
				PRIVACY_BANNER_ENABLED: options.privacyBannerEnabled ? "true" : "false",
				PUBLIC_SITE_URL: route.publicSiteUrl,
				PUBLIC_PATH_PREFIX: route.publicPathPrefix,
			},
			timeout: options.buildTimeoutMs ?? CMS_BUILD_TIMEOUT_MS,
		},
	);
	return {
		jobId,
		process,
		processId: process.id,
		startedAt: cmsProcessStartedAt(await process.status()) ?? Date.now(),
	};
}
async function snapshot(
	sandbox: CmsJobClient,
	jobId: string,
): Promise<CmsBuildSnapshot> {
	assertBuildJobId(jobId);
	const process = await getCmsJob(sandbox, `build:${jobId}`);
	if (!process)
		return {
			jobId,
			status: "failed",
			exitCode: null,
			running: false,
			logTail: "",
			launchLog: "",
			startedAt: null,
			durationMs: null,
			successMarkerDetected: false,
			message: "CMS theme build process was not found",
		};
	const logs = await readCmsProcessLogs(process);
	const state = await process.status();
	const startedAt = cmsProcessStartedAt(state);
	const combined = [logs.stdout, logs.stderr].filter(Boolean).join("\n");
	const successMarkerDetected = hasCmsBuildSuccessMarker(combined);
	// Reading status is observational. A completion log is diagnostic only;
	// cancellation and nonzero exits remain terminal failures even after it.
	const status: CmsBuildStatus = cmsProcessOutcome(state);
	const exitCode = cmsProcessExitCode(state);
	return {
		jobId,
		status,
		exitCode,
		running: status === "running",
		logTail: combined.split("\n").slice(-120).join("\n"),
		launchLog: "",
		startedAt,
		durationMs: cmsProcessDurationMs(state),
		successMarkerDetected,
		message: `CMS theme build ${status}`,
	};
}
export async function readCmsSandboxBuildStatus(
	sandbox: CmsJobClient,
	jobId: string,
	_options: CmsBuildOptions = {},
): Promise<CmsBuildSnapshot> {
	return snapshot(sandbox, jobId);
}
export async function cancelCmsSandboxBuild(
	sandbox: CmsJobClient,
	jobId: string,
): Promise<CmsBuildCancelSnapshot> {
	const before = await snapshot(sandbox, jobId);
	if (!before.running)
		return { ...before, cancelled: false, previousStatus: before.status };
	const process = await getCmsJob(sandbox, `build:${jobId}`);
	if (!process)
		throw new Error("CMS build process disappeared during cancellation");
	await process.kill();
	await process.waitForExit({ timeout: 10_000 });
	return {
		...(await snapshot(sandbox, jobId)),
		cancelled: true,
		previousStatus: before.status,
	};
}
export async function runCmsSandboxBuildToCompletion(
	sandbox: CmsJobClient,
	options: CmsBuildOptions & {
		onProgress?: (message: string) => void | Promise<void>;
		pollMs?: number;
	} = {},
): Promise<CmsBuildSnapshot> {
	// Reject deterministic caller mistakes before entering the ambiguous
	// launch window. Only Sandbox control failures need a retained permit.
	const jobId = options.jobId ?? `cms-${crypto.randomUUID()}`;
	assertBuildJobId(jobId);
	publicBuildRoute(options);
	// A lost launch response or process lookup does not prove Astro never
	// started. Retain the caller's workspace and restore permit for recovery.
	const observe = async <T>(label: string, operation: () => Promise<T>) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				operation(),
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() =>
							reject(
								new CmsUnknownProcessOutcomeError(
									`CMS build ${label} outcome is unknown after Sandbox control timeout`,
								),
							),
						CMS_BUILD_CONTROL_RPC_TIMEOUT_MS,
					);
				}),
			]);
		} catch {
			throw new CmsUnknownProcessOutcomeError(
				`CMS build ${label} outcome is unknown; native process may still be running`,
			);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	};
	const launch = await observe("launch", () =>
		startCmsSandboxBuild(sandbox, { ...options, jobId }),
	);
	if (options.onProgress) {
		await observe("progress record", async () =>
			options.onProgress?.("Astro build launched"),
		);
	}
	const deadline =
		Date.now() +
		(options.buildTimeoutMs ?? CMS_BUILD_TIMEOUT_MS) +
		CMS_BUILD_OBSERVATION_GRACE_MS;
	while (true) {
		const current = await observe("status observation", () =>
			snapshot(sandbox, launch.jobId),
		);
		if (current.message === "CMS theme build process was not found") {
			throw new CmsUnknownProcessOutcomeError(
				"CMS build process lookup is unknown; native process may still be running",
			);
		}
		if (!current.running) return current;
		if (Date.now() >= deadline)
			throw new CmsUnknownProcessOutcomeError(
				"CMS build completion observation expired; process outcome remains running",
			);
		await new Promise((resolve) =>
			setTimeout(resolve, options.pollMs ?? CMS_BUILD_POLL_MS),
		);
	}
}
