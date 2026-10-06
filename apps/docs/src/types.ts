import type { DocsBuildSandbox } from "./container/docs-build-sandbox";
import type { DocsBuildWorkflowParams } from "./workflow";

export type SourceProvider = "artifacts" | "github" | "gitlab" | "generic";
export type SourceAuthMode = "public" | "connection";
export type DocsSiteStatus = "active" | "paused";
export type DocsSiteAccessMode = "public" | "organization";
export type DocsBuildStatus = "queued" | "running" | "complete" | "failed";
export type DocsActorType =
	| "user"
	| "service"
	| "tedi"
	| "m2m"
	| "external_agent"
	| "kernel";

export interface DocsActor {
	type: DocsActorType;
	id: string;
	sessionId: string | null;
}

export interface DocsSite {
	id: string;
	orgSlug: string;
	slug: string;
	title: string;
	description: string;
	locale: string;
	canonicalUrl: string;
	sourceProvider: SourceProvider;
	sourceAuthMode: SourceAuthMode;
	repositoryUrl: string | null;
	artifactsRepository: string | null;
	branch: string;
	contentRoot: string;
	accessMode: DocsSiteAccessMode;
	status: DocsSiteStatus;
	activeBuildId: string | null;
	latestBuildId: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface DocsBuild {
	id: string;
	siteId: string;
	status: DocsBuildStatus;
	phase: string;
	sourceBranch: string | null;
	sourceRevision: string | null;
	proposalId: string | null;
	manifestKey: string | null;
	error: string | null;
	requestedBy: DocsActor | null;
	createdAt: string;
	startedAt: string | null;
	finishedAt: string | null;
}

export type DocsChangeStatus =
	| "proposed"
	| "validating"
	| "validated"
	| "committed"
	| "rejected";

export interface DocsChange {
	id: string;
	siteId: string;
	status: DocsChangeStatus;
	path: string;
	message: string;
	baseRevision: string;
	proposalBranch: string;
	proposalRevision: string;
	contentSha256: string;
	previewBuildId: string | null;
	committedRevision: string | null;
	proposedBy: DocsActor;
	committedBy: DocsActor | null;
	createdAt: string;
	updatedAt: string;
	committedAt: string | null;
}

export interface DocsRelease {
	id: string;
	siteId: string;
	buildId: string;
	previousBuildId: string | null;
	action: "publish" | "rollback";
	actor: DocsActor;
	createdAt: string;
}

export interface ArtifactsRepoToken {
	plaintext: string;
	expiresAt?: string | number;
}

export interface ArtifactsRepoHandle {
	name: string;
	remote: string;
	defaultBranch?: string;
	createToken(
		scope?: "read" | "write",
		ttlSeconds?: number,
	): Promise<ArtifactsRepoToken>;
}

export interface ArtifactsBinding {
	get(name: string): Promise<ArtifactsRepoHandle>;
	import(options: {
		source: { url: string; branch?: string; depth?: number };
		target: {
			name: string;
			description?: string;
			setDefaultBranch?: string;
		};
	}): Promise<ArtifactsRepoHandle>;
}

export interface AppBindings {
	DOCS_BUILD_SANDBOX: DurableObjectNamespace<DocsBuildSandbox>;
	DOCS_BUILD_WORKFLOW: Workflow<DocsBuildWorkflowParams>;
	DB: D1Database;
	DOCS_BUILDS: R2Bucket;
	DOCS_AI_SEARCH?: AiSearchNamespace;
	ARTIFACTS?: ArtifactsBinding;
	ENVIRONMENT: string;
	/** Release SHA, set at deploy time via `--var GIT_SHA`. Reported by /health. */
	GIT_SHA?: string;
	DOCS_BASE_DOMAIN: string;
	DOCS_ADMIN_URL: string;
	DESCOPE_PROJECT_ID: string;
	DESCOPE_BASE_URL: string;
	DESCOPE_MANAGEMENT_KEY: string;
	PLATFORM_SERVICE_TOKEN?: string;
}

export type AppEnv = { Bindings: AppBindings };
