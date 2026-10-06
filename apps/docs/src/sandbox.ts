import type { AppBindings } from "./types";
import type { DocsBuildSandbox } from "./container/docs-build-sandbox";

export function docsSourceAuthPath(buildId: string): string {
	return `/tmp/tedix-docs-source-auth-${buildId}`;
}

export function getDocsSandbox(
	env: Pick<AppBindings, "DOCS_BUILD_SANDBOX">,
	buildId: string,
) {
	return env.DOCS_BUILD_SANDBOX.getByName(
		buildId,
	) as unknown as DocsBuildSandbox;
}
