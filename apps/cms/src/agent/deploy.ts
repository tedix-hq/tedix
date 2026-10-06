import type { CmsSandbox } from "../sandbox";
import {
	activateTenantBundleVersion,
	type CmsHumanAuthorityCarry,
	listTenantBundleVersions,
} from "@tedix/provisioning/cms";
import {
	buildSurfaceUrl,
	platformDomainForEnvironment,
} from "@tedix/tenant-directory";
import { withCmsSiteRestorePermit } from "./cms-restore-permit";

function cmsTenantUrl(orgSlug: string, environment: string): string {
	const url = buildSurfaceUrl("cms", orgSlug, {
		platformDomain: platformDomainForEnvironment(environment),
	});
	if (!url) throw new Error("CMS organization slug is required");
	return url;
}

export interface DeployConfig {
	environment: "production" | "staging" | "development";
}

export interface DeployContext {
	config: DeployConfig;
	sandbox: CmsSandbox;
	bundlesBucket: R2Bucket;
	platformDb: D1Database;
}

export async function rollback(
	ctx: DeployContext,
	orgSlug: string,
	version: number,
): Promise<{ url: string; humanAuthority: CmsHumanAuthorityCarry }> {
	return withCmsSiteRestorePermit(ctx.platformDb, orgSlug, async () => {
		const result = await activateTenantBundleVersion(
			{ bundlesBucket: ctx.bundlesBucket, platformDb: ctx.platformDb },
			orgSlug,
			version,
		);
		if (!result.success) {
			throw new Error(`Rollback failed: ${result.error}`);
		}

		return {
			url: cmsTenantUrl(orgSlug, ctx.config.environment),
			humanAuthority: result.humanAuthority ?? "unchanged",
		};
	});
}

export async function listVersions(
	bundlesBucket: R2Bucket,
	platformDb: D1Database,
	orgSlug: string,
): Promise<
	Array<{
		version: number;
		active: boolean;
		deployedAt: string | null;
		promptSummary: string | null;
		sourceRevision:
			| import("@tedix/provisioning/cms").TenantBundleSourceRevision
			| null;
	}>
> {
	const versions = await listTenantBundleVersions(
		{ bundlesBucket, platformDb },
		orgSlug,
	);
	return versions.map((v) => ({
		version: v.version,
		active: v.isActive,
		deployedAt: v.deployedAt,
		promptSummary: v.summary,
		sourceRevision: v.sourceRevision,
	}));
}
