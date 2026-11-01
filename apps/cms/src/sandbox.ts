import type { AppBindings } from "./types";
import type {
	NativeProcess,
	SandboxCommand,
	SandboxExecOptions,
} from "@tedix/container-runtime/sandbox";

/** Container labels are limited to 64 bytes, unlike the full Durable Object name. */
export function siteBuilderSandboxTenantLabel(name: string): string {
	let label = name;
	if (name.startsWith("cms-job:")) {
		const identity: unknown = JSON.parse(name.slice("cms-job:".length));
		if (
			!Array.isArray(identity) ||
			identity.length !== 3 ||
			typeof identity[0] !== "string"
		)
			throw new Error("Invalid CMS execution job identity");
		label = identity[0];
	}
	if (
		new TextEncoder().encode(label).length > 64 ||
		/[\u0000-\u001f\u007f]/.test(label)
	)
		throw new Error("Invalid CMS tenant label");
	return label;
}

export function getSiteBuilderSandbox(
	env: Pick<AppBindings, "SITE_BUILDER_SANDBOX">,
	orgSlug: string,
	job?: { kind: "artifact-commit" | "deploy"; jobId: string },
) {
	if (
		job &&
		(!/^[a-zA-Z0-9._-]{1,150}$/.test(job.jobId) ||
			!["artifact-commit", "deploy"].includes(job.kind))
	)
		throw new Error("Invalid CMS execution job identity");
	// A server-generated job identity must never address the author's draft disk.
	const name = job
		? `cms-job:${JSON.stringify([orgSlug, job.kind, job.jobId])}`
		: orgSlug;
	return env.SITE_BUILDER_SANDBOX.getByName(
		name,
	) as unknown as SiteBuilderSandboxRuntime;
}

import type { SiteBuilderSandboxRuntime } from "./container/site-builder-sandbox";

export type CmsSandbox = ReturnType<typeof getSiteBuilderSandbox>;
export interface CmsJobClient {
	launchCmsJob(
		key: string,
		command: SandboxCommand,
		options: SandboxExecOptions,
		replaceExited?: boolean,
	): Promise<string>;
	getCmsJobId(key: string): Promise<string | null>;
	getProcess(id: string): Promise<NativeProcess | null>;
}
