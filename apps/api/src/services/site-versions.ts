import {
	ActiveThemeVersionSchema,
	SiteVersionCheckConfigSchema,
	SiteVersionReportSchema,
	type SiteVersionReport,
} from "@tedix/api-contract/schemas/site-versions";
import type { DbClient } from "@tedix/db/client";
import {
	addWorkItemComment,
	getLatestWorkItemCommentByAuthor,
} from "@tedix/db/queries/work-items/comments";
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
					const response = await input.env.CMS.fetch(
						new Request(
							`https://cms.internal/api/internal/deployments/${encodeURIComponent(site.slug)}/theme-version`,
							{
								headers: {
									Authorization: `Bearer ${input.env.PLATFORM_SERVICE_TOKEN}`,
									"X-Tedix-Connection-Label": site.slug,
								},
							},
						),
					);
					if (!response.ok) throw new Error("Theme build unavailable");
					const { active } = ActiveThemeVersionSchema.parse(
						await response.json(),
					);
					if (!active.release.packages.emdash)
						throw new Error("Theme package evidence unavailable");
					entry.themeRevision = active.sourceRevision?.value;
					await add(active.release.packages, "theme");
				} catch {
					entry.errors.push("Active theme build versions are unavailable");
				}
			}
			report.sites.push(entry);
		}
		const siteGroups = report.sites.flatMap((site) =>
			(["runtime", "theme", "docs image"] as const).flatMap((source) => {
				const packages = site.packages.filter(
					(pkg) => pkg.source === source && pkg.behind && pkg.latest,
				);
				if (!packages.length) return [];
				const primary =
					source === "docs image" ? "@cloudflare/nimbus-docs" : "emdash";
				const version = site.packages.find(
					(pkg) => pkg.source === source && pkg.package === primary,
				)?.latest;
				const target = version
					? `${source === "docs image" ? "Nimbus" : "EmDash"} ${version}`
					: "the latest package releases";
				return [{ site, source, packages, target }];
			}),
		);
		// Docs sites share one image, so a single release files one shared item.
		const docsImage = siteGroups.filter(
			(group) => group.source === "docs image",
		);
		const groups = [
			...siteGroups
				.filter((group) => group.source !== "docs image")
				.map((group) => ({
					sites: [group.site],
					source: group.source,
					packages: group.packages,
					target: group.target,
				})),
			...(docsImage.length
				? [
						{
							sites: docsImage.map((group) => group.site),
							source: "docs image" as const,
							packages: docsImage.flatMap((group) => group.packages),
							target: docsImage[0]!.target,
						},
					]
				: []),
		];
		const alerts = new Map<string, SiteVersionReport["alerts"][number]>();
		for (const group of groups) {
			const { sites, source, packages, target } = group;
			const shared = source === "docs image";
			const site = sites[0]!;
			const key = shared ? source : `${site.siteId}:${source}`;
			const targets = [
				...new Set(packages.map((pkg) => `${pkg.package}@${pkg.latest}`)),
			].sort();
			const sourceIntentId = `site-upgrade:${project.id}:${key}:${targets.join(",")}`;
			const existingId = config.upgradeWorkItems?.[key];
			const title = shared
				? `Upgrade the ${source} to ${target}`
				: `Upgrade the ${site.slug} ${source} to ${target}`;
			const description = `${title}\n\n${JSON.stringify(
				shared
					? {
							source,
							sites: sites.map((entry) => ({
								siteId: entry.siteId,
								slug: entry.slug,
								packages: entry.packages.filter(
									(pkg) => pkg.source === source && pkg.behind && pkg.latest,
								),
							})),
						}
					: {
							siteId: site.siteId,
							slug: site.slug,
							source,
							themeRevision: site.themeRevision,
							packages,
						},
				null,
				2,
			)}`;
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
						description,
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
			const last = await getLatestWorkItemCommentByAuthor(input.db, {
				orgId: project.orgId,
				workItemId: item.id,
				authorType: "system",
				authorId: "site-version-check",
			});
			if (last?.body !== description)
				await addWorkItemComment(input.db, {
					id: crypto.randomUUID(),
					orgId: project.orgId,
					workItemId: item.id,
					authorType: "system",
					authorId: "site-version-check",
					createdAt: report.checkedAt,
					body: description,
				});
			const message = `${source} to ${target}`;
			for (const entry of sites) {
				const alert = alerts.get(entry.siteId);
				if (alert) alert.message += `; ${message}`;
				else
					alerts.set(entry.siteId, {
						message: `Upgrade ${entry.slug}: ${message}`,
						workItemId: item.id,
					});
			}
		}
		report.alerts = [...alerts.values()];
		await saveSiteVersionReport(input.db, project.id, project.orgId, report);
		reports.push(report);
	}
	return reports;
}
