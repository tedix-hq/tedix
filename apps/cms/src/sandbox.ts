import type { AppBindings } from "./types";
import type {
	NativeProcess,
	SandboxCommand,
	SandboxExecOptions,
} from "@tedix/container-runtime/sandbox";

export function getSiteBuilderSandbox(
	env: Pick<AppBindings, "SITE_BUILDER_SANDBOX">,
	orgSlug: string,
) {
	return env.SITE_BUILDER_SANDBOX.getByName(
		orgSlug,
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
