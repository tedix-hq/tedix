import { createHash } from "node:crypto";

/**
 * Content key for the docs build Sandbox image. Ship deploys reuse the image
 * already pushed to the account registry whenever these inputs are unchanged,
 * instead of rebuilding the pinned Nimbus image on every release.
 */

const COPY_INSTRUCTION = /^\s*COPY\s+(\S[^\n]*)$/gm;
const SANDBOX_IMAGE = /sandbox:\s*\{\s*dockerfile:\s*"[^"]+"\s*\}/;
const REGISTRY_HOST = "registry.cloudflare.com";
export const DOCS_BUILD_IMAGE_REPOSITORY = "public-installation-docs-build";

/**
 * Build-context paths a Dockerfile's COPY instructions read. `COPY --from=`
 * lines stage from earlier images, so only their Dockerfile text is an input.
 */
export function dockerCopySources(dockerfileSource: string): string[] {
	const sources: string[] = [];
	for (const match of dockerfileSource.matchAll(COPY_INSTRUCTION)) {
		const args = (match[1] ?? "").split("#", 1)[0] ?? "";
		if (/--from(?:=|\s)/.test(args)) continue;
		const paths = args
			.split(/\s+/)
			.filter((token) => token !== "" && !token.startsWith("--"));
		// The last path is the destination; the rest are context sources.
		sources.push(...paths.slice(0, -1));
	}
	return sources;
}

/** A short registry tag keyed on every file the image build reads. */
export function imageInputTag(
	files: ReadonlyArray<{ path: string; contents: Buffer }>,
): string {
	const hash = createHash("sha256");
	for (const { path, contents } of [...files].sort((a, b) =>
		a.path.localeCompare(b.path),
	)) {
		hash.update(path);
		hash.update("\0");
		hash.update(contents);
		hash.update("\0");
	}
	return `inputs-${hash.digest("hex").slice(0, 16)}`;
}

export function imageReference(accountId: string, tag: string): string {
	return `${REGISTRY_HOST}/${accountId}/${DOCS_BUILD_IMAGE_REPOSITORY}:${tag}`;
}

/**
 * Swap the build Sandbox's `dockerfile` image for a prebuilt registry
 * `reference`. `vp build` docker-builds every dockerfile image it evaluates;
 * a reference deploys the pushed image as-is. The substitution happens only in
 * the deploy script's transient write, never in the tracked config.
 */
export function configWithImageReference(
	configSource: string,
	reference: string,
): string {
	const matches = configSource.match(new RegExp(SANDBOX_IMAGE.source, "g"));
	if (matches?.length !== 1) {
		throw new Error(
			`expected exactly one Sandbox dockerfile image in cloudflare.config.ts, found ${matches?.length ?? 0}`,
		);
	}
	return configSource.replace(
		SANDBOX_IMAGE,
		`sandbox: { reference: "${reference}" }`,
	);
}
