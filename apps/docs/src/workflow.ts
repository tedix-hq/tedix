import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";
import { indexPublicDocsBuild } from "./ai-search";
import {
	completeBuild,
	getBuild,
	getSiteById,
	updateBuildProgress,
} from "./registry";
import { docsSourceAuthPath, getDocsSandbox } from "./sandbox";
import {
	assertArtifactsRepositoryUrl,
	docsContentFindExclusions,
	shellQuote,
} from "./source";
import type { AppBindings, DocsSite } from "./types";
import { errorMessage } from "@tedix/worker-kit/error-message";
import { logDocsFailure } from "./log";

const TEMPLATE = "/opt/tedix-docs-template";
const MAX_BUILD_FILES = 10_000;
const MAX_BUILD_BYTES = 100 * 1024 * 1024;
const MAX_BUILD_FILE_BYTES = 10 * 1024 * 1024;
const STAGING_CONCURRENCY = 4;

interface DocsManifest {
	buildId: string;
	siteId: string;
	sourceRevision: string;
	entryPath: "/index" | "/readme";
	files: string[];
	builtAt: string;
}

type DocsEntryPath = DocsManifest["entryPath"];

const CONTENT_TYPES: Record<string, string> = {
	".css": "text/css; charset=utf-8",
	".gif": "image/gif",
	".html": "text/html; charset=utf-8",
	".ico": "image/x-icon",
	".jpeg": "image/jpeg",
	".jpg": "image/jpeg",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".md": "text/markdown; charset=utf-8",
	".mdx": "text/markdown; charset=utf-8",
	".png": "image/png",
	".svg": "image/svg+xml",
	".txt": "text/plain; charset=utf-8",
	".webmanifest": "application/manifest+json",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".xml": "application/xml; charset=utf-8",
};

function contentTypeFor(path: string): string {
	if (path.endsWith("/rss.xml")) return "application/rss+xml; charset=utf-8";
	const index = path.lastIndexOf(".");
	const extension = index === -1 ? "" : path.slice(index).toLowerCase();
	return CONTENT_TYPES[extension] ?? "application/octet-stream";
}

export interface DocsBuildWorkflowParams {
	// Already queued build executions have no operation.
	operation?: "build" | "index";
	siteId: string;
	buildId: string;
}

interface SourceCheckout {
	remote: string;
	authorization?: string;
	requiresSeededAuthorization?: boolean;
}

/** Stage one immutable build file with explicit per-file and total bounds. */
export async function stageDocsBuildFile(
	sandbox: Pick<ReturnType<typeof getDocsSandbox>, "readFile">,
	bucket: R2Bucket,
	path: string,
	key: string,
	remainingBytes: number,
): Promise<number> {
	const file = await sandbox.readFile(path, { encoding: "none" });
	if (
		!Number.isSafeInteger(file.size) ||
		file.size < 0 ||
		file.size > MAX_BUILD_FILE_BYTES ||
		file.size > remainingBytes
	) {
		throw new Error(
			`Documentation output file exceeds build byte limits: ${path}`,
		);
	}
	await bucket.put(key, file.content, {
		httpMetadata: { contentType: contentTypeFor(path) },
	});

	return file.size;
}

export async function stageDocsBuildFiles(
	sandbox: Pick<ReturnType<typeof getDocsSandbox>, "readFile">,
	bucket: R2Bucket,
	workspace: string,
	buildPrefix: string,
	files: Array<{ relativePath: string; size: number }>,
): Promise<void> {
	if (files.length === 0)
		throw new Error("Documentation build produced no files");
	if (files.length > MAX_BUILD_FILES)
		throw new Error(`Documentation build exceeded ${MAX_BUILD_FILES} files`);
	let totalBytes = 0;
	for (const file of files) {
		if (
			!Number.isSafeInteger(file.size) ||
			file.size < 0 ||
			file.size > MAX_BUILD_FILE_BYTES
		) {
			throw new Error(
				`Documentation output file exceeds build byte limits: ${file.relativePath}`,
			);
		}
		totalBytes += file.size;
		if (totalBytes > MAX_BUILD_BYTES) {
			throw new Error(`Documentation build exceeded ${MAX_BUILD_BYTES} bytes`);
		}
	}

	for (let start = 0; start < files.length; start += STAGING_CONCURRENCY) {
		const batch = files.slice(start, start + STAGING_CONCURRENCY);
		const results = await Promise.allSettled(
			batch.map((file) =>
				stageDocsBuildFile(
					sandbox,
					bucket,
					`${workspace}/dist/${file.relativePath}`,
					`${buildPrefix}/${file.relativePath}`,
					file.size,
				),
			),
		);
		const failure = results.find((result) => result.status === "rejected");
		if (failure?.status === "rejected") throw failure.reason;
	}
}

async function resolveCheckout(
	env: AppBindings,
	site: DocsSite,
): Promise<SourceCheckout> {
	if (site.sourceProvider !== "artifacts") {
		if (!site.repositoryUrl) throw new Error("Repository URL is missing");
		return {
			remote: site.repositoryUrl,
			requiresSeededAuthorization: site.sourceAuthMode === "connection",
		};
	}
	if (!env.ARTIFACTS) {
		throw new Error("Cloudflare Artifacts binding is unavailable");
	}
	if (!site.artifactsRepository) {
		throw new Error("Artifacts repository name is missing");
	}
	const repository = await env.ARTIFACTS.get(site.artifactsRepository);
	const token = await repository.createToken("read", 15 * 60);
	// Artifacts repo/result fields cross an RPC boundary. Generated types expose
	// scalar properties, while the live binding returns thenable JsRpc values.
	const remote = site.repositoryUrl
		? assertArtifactsRepositoryUrl(site.repositoryUrl, site.artifactsRepository)
		: await repository.remote;
	const plaintext = await token.plaintext;
	return { remote, authorization: `Bearer ${plaintext}` };
}

export async function checkoutAndBuild(
	env: AppBindings,
	site: DocsSite,
	buildId: string,
): Promise<{ revision: string; fileCount: number; manifestKey: string }> {
	// A build gets an immutable Sandbox identity. Reusing a site's Durable
	// Object can retain the previous container generation after an image
	// rollout, and concurrent builds would also share a filesystem.
	const sandbox = getDocsSandbox(env, buildId);
	const checkout = await resolveCheckout(env, site);
	const sourceDir = `/tmp/tedix-docs-source-${buildId}`;
	const workspace = `/tmp/tedix-docs-workspace-${buildId}`;
	const tokenFile = docsSourceAuthPath(buildId);

	if (checkout.authorization) {
		await sandbox.writeFile(tokenFile, checkout.authorization);
	}
	const usesAuthorization = Boolean(
		checkout.authorization || checkout.requiresSeededAuthorization,
	);
	const authSetup = usesAuthorization
		? `export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0=http.extraHeader
test -s ${shellQuote(tokenFile)}
export GIT_CONFIG_VALUE_0="Authorization: $(cat ${shellQuote(tokenFile)})"`
		: "";
	const cloneScript = `set -eu
cd /tmp
rm -rf ${shellQuote(sourceDir)}
${authSetup}
git clone --depth 1 --single-branch --branch ${shellQuote(site.branch)} ${shellQuote(checkout.remote)} ${shellQuote(sourceDir)}
git -C ${shellQuote(sourceDir)} rev-parse HEAD`;
	const cloned = await (
		await sandbox.exec(["bash", "-lc", cloneScript])
	).output({ encoding: "utf8", maxBytes: 16 * 1024 * 1024 });
	if (
		cloned.exitCode !== 0 ||
		cloned.timedOut ||
		cloned.signal !== undefined ||
		cloned.truncated
	) {
		throw new Error(`Git checkout failed: ${cloned.stderr.slice(-1200)}`);
	}
	const revision = cloned.stdout
		.split("\n")
		.find((line) => /^[a-f0-9]{40,64}$/i.test(line.trim()))
		?.trim();
	if (!revision || !/^[a-f0-9]{40,64}$/i.test(revision)) {
		throw new Error("Git checkout did not return a valid revision");
	}

	const contentDir =
		site.contentRoot === "." ? sourceDir : `${sourceDir}/${site.contentRoot}`;
	const contentExclusions = docsContentFindExclusions();
	const prepareScript = `set -eu
cd /tmp
test -d ${shellQuote(contentDir)}
if ! find ${shellQuote(contentDir)} -type f \\( -name '*.md' -o -name '*.mdx' \\) ${contentExclusions} -print -quit | grep -q .; then
	echo "No Markdown or MDX files found under ${site.contentRoot}" >&2
	exit 3
fi
rm -rf ${shellQuote(workspace)}
mkdir -p ${shellQuote(workspace)}
cd ${shellQuote(TEMPLATE)}
tar --exclude='./node_modules' -cf - . | tar -xf - -C ${shellQuote(workspace)}
ln -s ${shellQuote(`${TEMPLATE}/node_modules`)} ${shellQuote(`${workspace}/node_modules`)}
rm -rf ${shellQuote(`${workspace}/src/content/docs`)}
mkdir -p ${shellQuote(`${workspace}/src/content/docs`)}
if find ${shellQuote(contentDir)} -type l -print -quit | grep -q .; then
	echo "Symlinks are not allowed in docs content" >&2
	exit 2
fi
cd ${shellQuote(contentDir)}
find . -type f \\( \
	-name '*.md' -o -name '*.mdx' -o \
	-name '*.png' -o -name '*.jpg' -o -name '*.jpeg' -o \
	-name '*.gif' -o -name '*.svg' -o -name '*.webp' -o \
	-name '*.json' -o -name '*.yaml' -o -name '*.yml' \
\\) ${contentExclusions} ! -path './.tedix/*' -print0 | tar --null -T - -cf - | tar -xf - -C ${shellQuote(`${workspace}/src/content/docs`)}
rm -rf ${shellQuote(`${workspace}/.tedix`)}
if [ -f .tedix/docs-provenance.json ]; then
	mkdir -p ${shellQuote(`${workspace}/.tedix`)}
	cp .tedix/docs-provenance.json ${shellQuote(`${workspace}/.tedix/docs-provenance.json`)}
fi
if [ -f ${shellQuote(`${workspace}/src/content/docs/index.md`)} ] || [ -f ${shellQuote(`${workspace}/src/content/docs/index.mdx`)} ]; then
    echo /index
elif [ -f ${shellQuote(`${workspace}/src/content/docs/README.md`)} ] || [ -f ${shellQuote(`${workspace}/src/content/docs/README.mdx`)} ]; then
    echo /readme
else
    cp ${shellQuote(`${TEMPLATE}/src/content/docs/index.mdx`)} ${shellQuote(`${workspace}/src/content/docs/index.mdx`)}
    echo /generated-index
fi`;
	const prepared = await (
		await sandbox.exec(["bash", "-lc", prepareScript])
	).output({ encoding: "utf8", maxBytes: 16 * 1024 * 1024 });
	if (
		prepared.exitCode !== 0 ||
		prepared.timedOut ||
		prepared.signal !== undefined ||
		prepared.truncated
	) {
		throw new Error(
			`Content preparation failed: ${prepared.stderr.slice(-1200)}`,
		);
	}

	const entryPath: DocsEntryPath =
		prepared.stdout.trim() === "/readme" ? "/readme" : "/index";
	const syntheticEntry = prepared.stdout.trim() === "/generated-index";
	const buildEnv = {
		TEDIX_DOCS_SITE_SLUG: site.slug,
		TEDIX_DOCS_SITE_URL: site.canonicalUrl,
		TEDIX_DOCS_ENTRY_PATH: entryPath,
		TEDIX_DOCS_TITLE: site.title,
		TEDIX_DOCS_DESCRIPTION: site.description,
		TEDIX_DOCS_LOCALE: site.locale,
		...(syntheticEntry ? { TEDIX_DOCS_SYNTHETIC_ENTRY: "true" } : {}),
		// The documentation renderer labels this field as a public GitHub link. Artifacts remotes
		// are authenticated Git endpoints, so exposing one in the header is
		// both misleading and unusable to site visitors.
		TEDIX_DOCS_REPOSITORY_URL:
			site.sourceProvider === "github" && site.sourceAuthMode === "public"
				? (site.repositoryUrl ?? "")
				: "",
	};
	const completed = await (
		await sandbox.exec(["bun", "run", "build"], {
			cwd: workspace,
			timeout: 10 * 60 * 1000,
			env: buildEnv,
		})
	).output({ encoding: "utf8", maxBytes: 16 * 1024 * 1024 });
	if (
		completed.exitCode !== 0 ||
		completed.timedOut ||
		completed.signal !== undefined ||
		completed.truncated
	) {
		throw new Error(
			`Documentation build failed: ${[completed.stdout, completed.stderr]
				.join("\n")
				.slice(-3000)}`,
		);
	}

	const listed = await sandbox.listFiles(`${workspace}/dist`, {
		recursive: true,
		includeHidden: true,
	});
	const files = listed
		.filter((file) => file.type === "file")
		.map((file) => ({ relativePath: file.relativePath, size: file.size ?? 0 }))
		.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
	await stageDocsBuildFiles(
		sandbox,
		env.DOCS_BUILDS,
		workspace,
		`sites/${site.id}/builds/${buildId}`,
		files,
	);

	const manifestKey = `sites/${site.id}/builds/${buildId}/manifest.json`;
	const manifest: DocsManifest = {
		buildId,
		siteId: site.id,
		sourceRevision: revision,
		entryPath,
		files: files.map((file) => file.relativePath),
		builtAt: new Date().toISOString(),
	};
	await env.DOCS_BUILDS.put(manifestKey, JSON.stringify(manifest), {
		httpMetadata: { contentType: "application/json" },
	});
	return { revision, fileCount: files.length, manifestKey };
}

export class DocsBuildWorkflow extends WorkflowEntrypoint<
	AppBindings,
	DocsBuildWorkflowParams
> {
	async run(
		event: WorkflowEvent<DocsBuildWorkflowParams>,
		step: WorkflowStep,
	): Promise<{ buildId: string; sourceRevision: string }> {
		const { siteId, buildId } = event.payload;
		const site = await getSiteById(this.env.DB, siteId);
		if (!site) throw new Error(`Docs site ${siteId} not found`);
		const build = await getBuild(this.env.DB, buildId);
		if (!build || build.siteId !== siteId) {
			throw new Error(`Docs build ${buildId} not found`);
		}
		if (event.payload.operation === "index") {
			if (site.accessMode !== "public" || build.status !== "complete") {
				throw new Error("Search indexing requires a completed public build");
			}
			// Keep indexing outside build failure/cleanup: this build is already published.
			return step.do(
				"index-public-build",
				{ retries: { limit: 0, delay: "1 second" }, timeout: "15 minutes" },
				() => indexPublicDocsBuild(this.env, site, build),
			);
		}
		const sourceSite = {
			...site,
			branch: build.sourceBranch ?? site.branch,
		};

		try {
			await updateBuildProgress(this.env.DB, buildId, {
				status: "running",
				phase: "building",
			});
			const snapshot = await step.do(
				"checkout-build-and-stage",
				{
					retries: { limit: 2, delay: "10 seconds" },
					timeout: "15 minutes",
				},
				() => checkoutAndBuild(this.env, sourceSite, buildId),
			);

			await step.do("record-preview", async () => {
				await completeBuild(this.env.DB, {
					buildId,
					siteId,
					sourceRevision: snapshot.revision,
					manifestKey: snapshot.manifestKey,
				});
			});
			return { buildId, sourceRevision: snapshot.revision };
		} catch (error) {
			const message = errorMessage(error).slice(0, 4000);
			await updateBuildProgress(this.env.DB, buildId, {
				status: "failed",
				phase: "failed",
				error: message,
			});
			logDocsFailure("docs.build_failed", error);
			throw error;
		} finally {
			const sandbox = getDocsSandbox(this.env, buildId);
			await sandbox
				.deleteFile(docsSourceAuthPath(buildId))
				.catch(() => undefined);
		}
	}
}
