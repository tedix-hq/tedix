import { z } from "zod";
import { ThemePackageVersionsSchema } from "@tedix/api-contract/schemas/site-versions";
import { themePackageVersions } from "./theme-dependencies";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import { isPathLocked } from "./constraints";
import { snapshotForTemplate } from "./template-sync";
import { CmsDeployFailure } from "./deploy-failure";

export const themeReleaseDeclarationSchema = z.object({
	upstreamStarterRevision: z.string().regex(/^[a-f0-9]{40}$/),
	supportedBlocks: z.record(
		z.string(),
		z.array(z.number().int().positive()).min(1),
	),
});
export const themeReleaseSchema = themeReleaseDeclarationSchema.extend({
	version: z.literal(1),
	templateSlug: z.string().min(1),
	lockedTemplateSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
	dependencyLockHash: z.string().regex(/^[a-f0-9]{64}$/),
	packages: ThemePackageVersionsSchema.optional(),
});
export type ThemeRelease = z.infer<typeof themeReleaseSchema>;

export async function identifyThemeRelease(
	sandbox: { readFile(path: string): Promise<{ content: string }> },
	templateSlug: string,
	workspace: string,
): Promise<ThemeRelease> {
	let declaration: z.infer<typeof themeReleaseDeclarationSchema>;
	try {
		declaration = themeReleaseDeclarationSchema.parse(
			JSON.parse(
				(await sandbox.readFile(`${workspace}/src/theme-release.json`)).content,
			),
		);
	} catch {
		throw new CmsDeployFailure(
			"THEME_RELEASE_INVALID",
			"Add src/theme-release.json with the upstream starter commit and supported block versions before deploying",
		);
	}
	const { snapshot, paths } = snapshotForTemplate(templateSlug);
	const locked: string[] = [];
	for (const path of paths
		.filter((path) => isPathLocked(path, templateSlug))
		.toSorted()) {
		locked.push(`${path}:${await sha256Hex(snapshot[path]!)}`);
	}
	const lock = (await sandbox.readFile(`${workspace}/bun.lock`)).content;
	return {
		version: 1,
		templateSlug,
		...declaration,
		lockedTemplateSnapshotHash: await sha256Hex(locked.join("\n")),
		dependencyLockHash: await sha256Hex(lock),
		packages: themePackageVersions(lock),
	};
}

/** Native versioned blocks are distinct from Portable Text's unversioned nodes. */
export function requireSupportedBlocks(
	value: unknown,
	release: ThemeRelease,
): void {
	if (Array.isArray(value)) {
		for (const item of value) requireSupportedBlocks(item, release);
	} else if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		if ("_version" in record && typeof record._type === "string") {
			const versions = Object.hasOwn(release.supportedBlocks, record._type)
				? release.supportedBlocks[record._type]
				: undefined;
			if (
				typeof record._version !== "number" ||
				!versions?.includes(record._version)
			) {
				throw new CmsDeployFailure(
					"THEME_BLOCK_UNSUPPORTED",
					`Theme cannot render block ${record._type}@${String(record._version)}; add a renderer for this version before deploying`,
					false,
					typeof record._version === "number"
						? { blockType: record._type, blockVersion: record._version }
						: undefined,
				);
			}
		}
		for (const child of Object.values(record))
			requireSupportedBlocks(child, release);
	}
}
