import { CMS_TEMPLATE_SLUGS } from "@tedix/api-contract/schemas/cms-template";
import {
	CmsTemplateUpstreamReportSchema,
	type CmsTemplateUpstreamReport,
} from "@tedix/api-contract/schemas/cms-template-upstream";
import type { DbClient } from "@tedix/db/client";
import {
	addWorkItemComment,
	getLatestWorkItemCommentByAuthor,
} from "@tedix/db/queries/work-items/comments";
import {
	findOpenCmsTemplateUpstreamWork,
	listCmsTemplateUpstreamProjects,
	saveCmsTemplateUpstreamReport,
} from "@tedix/db/queries/cms-template-upstream";
import {
	createWorkItem,
	getWorkItemById,
	getWorkItemBySourceIntentId,
} from "@tedix/db/queries/work-items/crud";
import {
	resolveWorkItemPurpose,
	WORK_ITEM_PURPOSE_EXCEPTION_MAX_MS,
} from "@tedix/db/queries/work-items/purpose";

const UPSTREAM_REPOSITORY = "emdash-cms/emdash";
const UPSTREAM_REF = "main";
const CHECK_AUTHOR = "cms-template-upstream-check";

export interface CmsTemplateSource {
	slug: string;
	folder: string;
	commit: string;
}

/** Parses the `commit <sha>, `templates/<folder>`` line in a starter's UPSTREAM.md. */
export function parseTemplateUpstreamMarkdown(
	slug: string,
	text: string,
): CmsTemplateSource | null {
	const match = text.match(
		/commit\s+([0-9a-f]{40})[\s\S]*?`templates\/([^`\s]+)`/,
	);
	if (!match) return null;
	return { slug, folder: match[2]!, commit: match[1]! };
}

interface UpstreamTemplateEntry {
	name: string;
	type: string;
	sha: string;
}

async function githubFetch(path: string): Promise<unknown> {
	const response = await fetch(
		`https://api.github.com/repos/${UPSTREAM_REPOSITORY}${path}`,
		{
			headers: {
				Accept: "application/vnd.github+json",
				"User-Agent": "tedix-cms-template-upstream-check",
			},
			signal: AbortSignal.timeout(15000),
		},
	);
	if (!response.ok)
		throw new Error(`Upstream template read failed (${response.status})`);
	return response.json();
}

/** Deployable upstream starters: the Cloudflare variants plus `blank`. */
function isDeployableTemplate(name: string) {
	return name === "blank" || name.endsWith("-cloudflare");
}

async function listUpstreamTemplates(ref: string) {
	const entries = (await githubFetch(
		`/contents/templates?ref=${encodeURIComponent(ref)}`,
	)) as UpstreamTemplateEntry[];
	return new Map(
		entries
			.filter((entry) => entry.type === "dir")
			.map((entry) => [entry.name, entry.sha] as const),
	);
}

export interface CmsTemplateUpstreamFinding {
	source: CmsTemplateSource;
	behind: boolean;
	recordedTree: string | null;
	upstreamTree: string | null;
}

export interface CmsTemplateUpstreamState {
	upstreamRevision: string;
	upstreamTemplates: Map<string, string>;
	findings: CmsTemplateUpstreamFinding[];
	/** Deployable upstream folders no native starter tracks. */
	missing: string[];
}

/**
 * Compares every native starter's recorded upstream commit with upstream main.
 * `readUpstreamFile` supplies UPSTREAM.md contents; `null` means the starter is
 * Tedix-native and has no upstream source.
 */
export async function checkCmsTemplateUpstreamState(input: {
	readUpstreamFile: (slug: string) => Promise<string | null>;
	listTemplates?: (ref: string) => Promise<Map<string, string>>;
	headRevision?: () => Promise<string>;
}): Promise<CmsTemplateUpstreamState> {
	const listTemplates = input.listTemplates ?? listUpstreamTemplates;
	const headRevision =
		input.headRevision ??
		(async () => {
			const head = (await githubFetch(`/commits/${UPSTREAM_REF}`)) as {
				sha: string;
			};
			return head.sha;
		});
	const sources: CmsTemplateSource[] = [];
	for (const slug of CMS_TEMPLATE_SLUGS) {
		const text = await input.readUpstreamFile(slug);
		if (text === null) continue;
		const source = parseTemplateUpstreamMarkdown(slug, text);
		if (!source)
			throw new Error(`Unparseable UPSTREAM.md for CMS template ${slug}`);
		sources.push(source);
	}
	const [upstreamRevision, upstreamTemplates] = await Promise.all([
		headRevision(),
		listTemplates(UPSTREAM_REF),
	]);
	const treesAtCommit = new Map<string, Map<string, string>>();
	async function templatesAt(ref: string) {
		let trees = treesAtCommit.get(ref);
		if (!trees) {
			trees = await listTemplates(ref);
			treesAtCommit.set(ref, trees);
		}
		return trees;
	}
	const findings: CmsTemplateUpstreamFinding[] = [];
	const covered = new Set<string>();
	for (const source of sources) {
		const [recorded, upstream] = await Promise.all([
			templatesAt(source.commit),
			upstreamTemplates,
		]);
		const recordedTree = recorded.get(source.folder) ?? null;
		const upstreamTree = upstream.get(source.folder) ?? null;
		covered.add(source.folder);
		findings.push({
			source,
			behind: recordedTree !== upstreamTree,
			recordedTree,
			upstreamTree,
		});
	}
	const missing = [...upstreamTemplates.keys()].filter(
		(name) => isDeployableTemplate(name) && !covered.has(name),
	);
	return { upstreamRevision, upstreamTemplates, findings, missing };
}

async function fileUpstreamWork(input: {
	db: DbClient;
	project: {
		id: string;
		orgId: string;
		key: string;
		objectiveId: string | null;
	};
	checkedAt: string;
	kind: "behind" | "missing";
	key: string;
	title: string;
	description: string;
	sourceIntentId: string;
}) {
	const { db, project } = input;
	let item = await getWorkItemBySourceIntentId(db, {
		orgId: project.orgId,
		sourceIntentId: input.sourceIntentId,
	});
	item ??= await findOpenCmsTemplateUpstreamWork(
		db,
		project.orgId,
		project.id,
		input.title,
	).then(async (id) => (id ? getWorkItemById(db, id, project.orgId) : null));
	const reused = item !== null;
	if (!item) {
		const purpose = await resolveWorkItemPurpose(db, {
			orgId: project.orgId,
			now: input.checkedAt,
			project: { key: project.key, objectiveId: project.objectiveId },
			workClass: "maintenance",
			purposeExceptionExpiresAt: new Date(
				Date.parse(input.checkedAt) + WORK_ITEM_PURPOSE_EXCEPTION_MAX_MS,
			).toISOString(),
		});
		try {
			await createWorkItem(db, {
				id: crypto.randomUUID(),
				orgId: project.orgId,
				projectId: project.id,
				createdBy: { type: "system", id: CHECK_AUTHOR },
				title: input.title,
				description: input.description,
				workKind: "coding",
				sourceIntentId: input.sourceIntentId,
				objectiveId: purpose.objectiveId ?? undefined,
				workClass: purpose.workClass,
				purposeExceptionExpiresAt:
					purpose.purposeExceptionExpiresAt ?? undefined,
				createdAt: input.checkedAt,
			});
		} catch (error) {
			// The source-intent unique index arbitrates overlapping checks.
			if (
				!(await getWorkItemBySourceIntentId(db, {
					orgId: project.orgId,
					sourceIntentId: input.sourceIntentId,
				}))
			)
				throw error;
		}
		item = await getWorkItemBySourceIntentId(db, {
			orgId: project.orgId,
			sourceIntentId: input.sourceIntentId,
		});
	}
	if (!item) throw new Error("Upstream template Work could not be read back");
	const last = await getLatestWorkItemCommentByAuthor(db, {
		orgId: project.orgId,
		workItemId: item.id,
		authorType: "system",
		authorId: CHECK_AUTHOR,
	});
	if (last?.body !== input.description)
		await addWorkItemComment(db, {
			id: crypto.randomUUID(),
			orgId: project.orgId,
			workItemId: item.id,
			authorType: "system",
			authorId: CHECK_AUTHOR,
			createdAt: input.checkedAt,
			body: input.description,
		});
	return {
		kind: input.kind,
		key: input.key,
		workItemId: item.id,
		reused,
	};
}

export async function checkCmsTemplateUpstream(input: {
	db: DbClient;
	env: CloudflareEnv;
	organizationId?: string;
}) {
	const projects = await listCmsTemplateUpstreamProjects(
		input.db,
		input.organizationId,
	);
	if (!projects.length) return [];
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
		if (response.status === 404) return null;
		if (!response.ok)
			throw new Error(`Product source read failed (${response.status})`);
		return response.text();
	}
	const state = await checkCmsTemplateUpstreamState({
		readUpstreamFile: (slug) =>
			productFile(`apps/cms/templates/${slug}/UPSTREAM.md`),
	});
	const checkedAt = new Date().toISOString();
	const reports: CmsTemplateUpstreamReport[] = [];
	for (const project of projects) {
		const report = CmsTemplateUpstreamReportSchema.parse({
			checkedAt,
			upstreamRevision: state.upstreamRevision,
			projects: [
				{
					projectId: project.id,
					starters: state.findings.map((finding) => ({
						slug: finding.source.slug,
						folder: finding.source.folder,
						recordedCommit: finding.source.commit,
						behind: finding.behind,
						recordedTree: finding.recordedTree,
						upstreamTree: finding.upstreamTree,
					})),
					missing: state.missing,
					filed: [],
				},
			],
		});
		const filed: CmsTemplateUpstreamReport["projects"][number]["filed"] = [];
		for (const finding of state.findings.filter((entry) => entry.behind)) {
			const { source } = finding;
			const title = `Sync the ${source.slug} CMS starter with upstream EmDash ${source.folder}`;
			const description = `${title}\n\n${JSON.stringify(
				{
					slug: source.slug,
					folder: source.folder,
					recordedCommit: source.commit,
					upstreamRevision: state.upstreamRevision,
					recordedTree: finding.recordedTree,
					upstreamTree: finding.upstreamTree,
				},
				null,
				2,
			)}`;
			const sourceIntentId = `cms-template-upstream:${project.id}:${source.slug}:${finding.upstreamTree}`;
			const result = await fileUpstreamWork({
				db: input.db,
				project,
				checkedAt,
				kind: "behind",
				key: source.slug,
				title,
				description,
				sourceIntentId,
			});
			filed.push(result);
		}
		for (const folder of state.missing) {
			const title = `Capture the upstream EmDash ${folder} template as a native CMS starter`;
			const description = `${title}\n\n${JSON.stringify(
				{
					folder,
					upstreamRevision: state.upstreamRevision,
					upstreamTree: state.upstreamTemplates.get(folder) ?? null,
				},
				null,
				2,
			)}`;
			const sourceIntentId = `cms-template-upstream:${project.id}:missing:${folder}`;
			const result = await fileUpstreamWork({
				db: input.db,
				project,
				checkedAt,
				kind: "missing",
				key: folder,
				title,
				description,
				sourceIntentId,
			});
			filed.push(result);
		}
		report.projects[0]!.filed = filed;
		await saveCmsTemplateUpstreamReport(
			input.db,
			project.id,
			project.orgId,
			report,
		);
		reports.push(report);
	}
	return reports;
}
