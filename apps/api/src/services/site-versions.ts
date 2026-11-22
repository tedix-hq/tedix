import {
	SiteVersionCheckConfigSchema,
	SiteVersionReportSchema,
	type SiteVersionReport,
} from "@tedix/api-contract/schemas/site-versions";
import type { DbClient } from "@tedix/db/client";
import { parse, type ParseError } from "jsonc-parser";
import { addWorkItemComment } from "@tedix/db/queries/work-items/comments";
import { listCmsSitesByOrganization } from "@tedix/db/queries/cms-sites";
import { listDocsSites } from "@tedix/db/queries/docs-sites/sites";
import { getOrganizationById } from "@tedix/db/queries/organizations";
import {
	findSiteUpgradeWork,
	listSiteVersionProjects,
	saveSiteVersionReport,
} from "@tedix/db/queries/site-versions";
import {
	createWorkItem,
	getWorkItemById,
	getWorkItemBySourceIntentId,
} from "@tedix/db/queries/work-items/crud";
import {
	resolveWorkItemPurpose,
	WORK_ITEM_PURPOSE_EXCEPTION_MAX_MS,
} from "@tedix/db/queries/work-items/purpose";

/** Read resolved package tuples, never the requested ranges in workspaces. */
export function themePackageVersions(lock: string): Record<string, string[]> {
	const versions: Record<string, string[]> = {};
	const errors: ParseError[] = [];
	const data = parse(lock, errors, { allowTrailingComma: true }) as {
		packages?: Record<string, unknown>;
	} | null;
	if (errors.length || !data?.packages)
		throw new Error("Invalid theme bun.lock");
	for (const tuple of Object.values(data.packages)) {
		if (!Array.isArray(tuple) || typeof tuple[0] !== "string") continue;
		const match = /^(emdash|@emdash-cms\/[^@]+)@(.+)$/.exec(tuple[0]);
		if (!match) continue;
		const values = (versions[match[1]!] ??= []);
		if (!values.includes(match[2]!)) values.push(match[2]!);
	}
	if (!versions.emdash)
		throw new Error("Theme bun.lock has no resolved EmDash package");
	return versions;
}

export function isVersionBehind(
	installed: string,
	latest: string,
): boolean | null {
	const pattern =
		/^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
	const current = pattern.exec(installed);
	const target = pattern.exec(latest);
	// npm's latest tag must point to a stable release before recommending it.
	if (!current || !target || target[4]) return null;
	for (const index of [1, 2, 3]) {
		const delta = Number(current[index]) - Number(target[index]);
		if (delta !== 0) return delta < 0;
	}
	return Boolean(current[4]);
}

export function productPackageVersions(manifest: string, dockerfile: string) {
	const catalog = JSON.parse(manifest).catalog as Record<string, string>;
	const runtime = Object.fromEntries(
		["emdash", "@emdash-cms/cloudflare"].map((name) => {
			if (!catalog[name]) throw new Error(`Missing runtime pin for ${name}`);
			return [name, catalog[name]];
		}),
	);
	const docs: Record<string, string> = {};
	for (const name of [
		"@cloudflare/create-nimbus-docs",
		"@cloudflare/nimbus-docs",
	]) {
		const version = dockerfile.match(
			new RegExp(`${name}@([0-9]+\\.[0-9]+\\.[0-9]+)`),
		)?.[1];
		if (!version) throw new Error(`Missing docs image pin for ${name}`);
		docs[name] = version;
	}
	return { runtime, docs };
}

export async function siteVersionAlerts(
	db: DbClient,
	orgId: string,
	platformAdmin: boolean,
) {
	if (!platformAdmin) return [];
	const alerts = [];
	for (const project of await listSiteVersionProjects(db, orgId)) {
		const report = SiteVersionReportSchema.safeParse(
			project.metadata?.siteVersionReport,
		);
		if (report.success) alerts.push(...report.data.alerts);
	}
	return alerts;
}

export async function checkSiteVersions(input: {
	db: DbClient;
	env: CloudflareEnv;
	organizationId?: string;
}) {
	const reports: SiteVersionReport[] = [];
	const projects = await listSiteVersionProjects(
		input.db,
		input.organizationId,
	);
	if (!projects.length) return reports;
	const revision = input.env.GIT_SHA;
	const repository = input.env.RELEASE_REPOSITORY;
	if (
		!/^[a-f0-9]{40}$/.test(revision) ||
		!/^[\w.-]+\/[\w.-]+$/.test(repository)
	)
		throw new Error("Product source revision is unavailable");
	async function productFile(path: string) {
		const response = await fetch(
			`https://raw.githubusercontent.com/${repository}/${revision}/${path}`,
			{ signal: AbortSignal.timeout(10000) },
		);
		if (!response.ok)
			throw new Error(`Product source read failed (${response.status})`);
		return response.text();
	}
	const [manifest, dockerfile] = await Promise.all([
		productFile("package.json"),
		productFile("apps/docs/Dockerfile"),
	]);
	const pins = productPackageVersions(manifest, dockerfile);
	const latest = new Map<string, Promise<string | null>>();
	function npmVersion(name: string) {
		let result = latest.get(name);
		if (!result) {
			result = (async () => {
				try {
					const response = await fetch(
						`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`,
						{ signal: AbortSignal.timeout(10000) },
					);
					if (!response.ok) return null;
					const data = (await response.json()) as { version?: string };
					return typeof data.version === "string" ? data.version : null;
				} catch {
					return null;
				}
			})();
			latest.set(name, result);
		}
		return result;
	}
	for (const project of projects) {
		const config = SiteVersionCheckConfigSchema.parse(
			project.metadata?.siteVersionCheck,
		);
		const organization = await getOrganizationById(input.db, project.orgId);
		if (!organization)
			throw new Error("Site version organization is unavailable");
		const [cms, docs] = await Promise.all([
			listCmsSitesByOrganization(input.db, project.orgId),
			listDocsSites(input.db, organization.slug),
		]);
		const report: SiteVersionReport = {
			checkedAt: new Date().toISOString(),
			productRevision: revision,
			sites: [],
			alerts: [],
		};
		for (const site of [...cms, ...docs]) {
			const entry: SiteVersionReport["sites"][number] = {
				siteId: site.id,
				slug: site.slug,
				packages: [],
				errors: [],
			};
			const isCms = "organizationId" in site;
			async function add(
				packages: Record<string, string | string[]>,
				source: "runtime" | "theme" | "docs image",
			) {
				for (const [name, versions] of Object.entries(packages)) {
					const target = await npmVersion(name);
					for (const installed of typeof versions === "string"
						? [versions]
						: versions)
						entry.packages.push({
							package: name,
							source,
							installed,
							latest: target,
							behind: target ? isVersionBehind(installed, target) : null,
						});
					if (!target)
						entry.errors.push(`Latest npm release unavailable for ${name}`);
				}
			}
			await add(
				isCms ? pins.runtime : pins.docs,
				isCms ? "runtime" : "docs image",
			);
			if (isCms) {
				try {
					using repo = await input.env.ARTIFACTS.get(`cms-theme-${site.slug}`);
					const [head] = await repo.log({ ref: "HEAD", limit: 1 });
					if (!head) throw new Error("Theme repository has no head");
					entry.themeRevision = head.hash;
					const lock = await repo.readFile({
						ref: head.hash,
						path: "bun.lock",
					});
					if (!lock || lock.size > 2_000_000)
						throw new Error("Theme bun.lock unavailable or too large");
					await add(themePackageVersions(await lock.text()), "theme");
				} catch {
					entry.errors.push("Theme bun.lock could not be checked");
				}
			}
			report.sites.push(entry);
		}
		const behind = new Map<string, { version: string; siteIds: Set<string> }>();
		for (const site of report.sites)
			for (const pkg of site.packages) {
				if (!pkg.behind || !pkg.latest) continue;
				const group = behind.get(pkg.package) ?? {
					version: pkg.latest,
					siteIds: new Set<string>(),
				};
				group.siteIds.add(site.siteId);
				behind.set(pkg.package, group);
			}
		for (const [name, group] of behind) {
			const sourceIntentId = `site-upgrade:${project.id}:${name}:${group.version}`;
			const existingId = config.upgradeWorkItems?.[name];
			let item = existingId
				? await getWorkItemById(input.db, existingId, project.orgId)
				: null;
			if (existingId && !item)
				throw new Error("Configured upgrade Work is unavailable");
			if (item && item.projectId !== project.id)
				throw new Error("Upgrade Work belongs to another project");
			item ??= await getWorkItemBySourceIntentId(input.db, {
				orgId: project.orgId,
				sourceIntentId,
			});
			const title = `Upgrade ${name} to ${group.version}`;
			if (!item) {
				const matching = await findSiteUpgradeWork(
					input.db,
					project.orgId,
					project.id,
					title,
				);
				if (matching)
					item = await getWorkItemById(input.db, matching, project.orgId);
			}
			if (!item) {
				const purpose = await resolveWorkItemPurpose(input.db, {
					orgId: project.orgId,
					now: report.checkedAt,
					project: { key: project.key, objectiveId: project.objectiveId },
					workClass: "maintenance",
					purposeExceptionExpiresAt: new Date(
						Date.parse(report.checkedAt) + WORK_ITEM_PURPOSE_EXCEPTION_MAX_MS,
					).toISOString(),
				});
				try {
					await createWorkItem(input.db, {
						id: crypto.randomUUID(),
						orgId: project.orgId,
						projectId: project.id,
						createdBy: { type: "system", id: "site-version-check" },
						title,
						description: JSON.stringify(
							report.sites.filter((site) => group.siteIds.has(site.siteId)),
							null,
							2,
						),
						workKind: "coding",
						sourceIntentId,
						objectiveId: purpose.objectiveId ?? undefined,
						workClass: purpose.workClass,
						purposeExceptionExpiresAt:
							purpose.purposeExceptionExpiresAt ?? undefined,
						createdAt: report.checkedAt,
					});
				} catch (error) {
					// The source-intent unique index arbitrates overlapping daily/manual checks.
					if (
						!(await getWorkItemBySourceIntentId(input.db, {
							orgId: project.orgId,
							sourceIntentId,
						}))
					)
						throw error;
				}
				item = await getWorkItemBySourceIntentId(input.db, {
					orgId: project.orgId,
					sourceIntentId,
				});
			}
			if (!item) throw new Error("Upgrade Work could not be read back");
			const count = group.siteIds.size;
			await addWorkItemComment(input.db, {
				id: crypto.randomUUID(),
				orgId: project.orgId,
				workItemId: item.id,
				authorType: "system",
				authorId: "site-version-check",
				createdAt: report.checkedAt,
				body: `Upgrade ${name} to ${group.version}: ${count} ${count === 1 ? "site is" : "sites are"} behind.\n\n${JSON.stringify(
					report.sites.filter((site) => group.siteIds.has(site.siteId)),
					null,
					2,
				)}`,
			});
			const label =
				name === "emdash"
					? "EmDash"
					: name === "@cloudflare/nimbus-docs"
						? "Nimbus"
						: name;
			report.alerts.push({
				message: `${count} ${count === 1 ? "site is" : "sites are"} behind ${label} ${group.version}`,
				workItemId: item.id,
			});
		}
		await saveSiteVersionReport(input.db, project.id, project.orgId, report);
		reports.push(report);
	}
	return reports;
}
