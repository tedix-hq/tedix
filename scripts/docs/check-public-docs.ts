import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import {
	checkPublicSurface,
	privateWorkspaceRoots,
	publicWorkspaceRoots,
} from "../oss/public-surface";

const repoRoot = resolve(import.meta.dir, "../..");
const docsRoot = resolve(repoRoot, "docs");
const publicRoot = resolve(repoRoot, "docs/public");
const markdownGlob = new Bun.Glob("**/*.{md,mdx}");
const allDocsGlob = new Bun.Glob("**/*.{md,mdx}");
const assetGlob = new Bun.Glob("**/*");
const workspaceReadmeGlob = new Bun.Glob("{apps,packages}/*/README.md");
const workspaceAgentGlob = new Bun.Glob("{apps,packages}/*/AGENTS.md");

// Public installation and local-development docs legitimately name loopback
// hosts. They are not private infrastructure, so rejecting localhost or
// 127.0.0.1 makes the safety check block the documentation it is meant to ship.
const forbiddenPatterns: Array<[RegExp, string]> = [
	[/pass:\/\//i, "Proton Pass reference"],
	[/\.tedi\.studio\b/i, "local development domain"],
	[/\/Users\/|\/home\/runner\/|\/private\/tmp\//i, "local filesystem path"],
	[/\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9_-]+/, "credential-like token"],
];

const forbiddenWorkspaceReadmePatterns: Array<[RegExp, string]> = [
	[/pass:\/\//i, "Proton Pass reference"],
	[/\bpass-cli\b/i, "private secret-injection command"],
	[/\bProton Pass\b/i, "private secret provider"],
	[/\bproduction data\b/i, "production-data development instruction"],
	[
		/\bdev(?:elopment)? server connects to production\b/i,
		"production-connected development instruction",
	],
	[
		/\bproduction D1 binding in local development\b/i,
		"production-connected development instruction",
	],
];
const allowedPublicAssetExtensions = new Set([
	".gif",
	".jpeg",
	".jpg",
	".json",
	".md",
	".mdx",
	".png",
	".svg",
	".webp",
	".yaml",
	".yml",
]);
const textAssetExtensions = new Set([".json", ".svg", ".yaml", ".yml"]);

// Public text must only instruct commands and cite files the public tree
// ships. In the private source repository the export manifest cuts root
// scripts to `rootScripts` and root `scripts/` files to its include list, so a
// reference that works in this checkout can still be dead for outside readers.
// The public tree has no manifest: what is on disk is what ships.
const exportManifestPath = resolve(repoRoot, "scripts/oss/public-files.json");
const exportPolicy = existsSync(exportManifestPath)
	? (JSON.parse(await readFile(exportManifestPath, "utf8")) as {
			include: { exactPaths: string[]; roots: string[] };
			rootScripts: string[];
		})
	: null;
const exportedRootScripts = new Set(
	exportPolicy?.rootScripts ??
		Object.keys(
			(
				JSON.parse(
					await readFile(resolve(repoRoot, "package.json"), "utf8"),
				) as { scripts?: Record<string, string> }
			).scripts ?? {},
		),
);
const exportedScriptPath = (path: string) =>
	exportPolicy
		? exportPolicy.include.exactPaths.some(
				(entry) => entry === path || entry.startsWith(`${path}/`),
			) ||
			exportPolicy.include.roots.some(
				(root) => path === root || path.startsWith(`${root}/`),
			)
		: existsSync(resolve(repoRoot, path));

// A source-tree link can resolve to a file the export withholds, so exported
// text must link only to the export's selected file set.
const exportedFiles: Set<string> | null = exportPolicy
	? await (async () => {
			// The exporter is private tooling; a computed specifier keeps the
			// public tree free of a static import it does not ship.
			const exporterPath = "../oss/export";
			const { selectPublicFiles } = (await import(exporterPath)) as {
				selectPublicFiles: (
					tracked: string[],
					workspaceRoots: string[],
					policy: unknown,
					privateRoots: string[],
				) => string[];
			};
			const surface = checkPublicSurface(repoRoot);
			const tracked = spawnSync("git", ["ls-files", "-z"], { cwd: repoRoot })
				.stdout.toString("utf8")
				.split("\0")
				.filter(Boolean);
			return new Set(
				selectPublicFiles(
					tracked,
					publicWorkspaceRoots(surface),
					exportPolicy,
					privateWorkspaceRoots(surface),
				),
			);
		})()
	: null;
// docs/public/AGENTS.md is also written to the export root as AGENTS.md.
const isExported = (path: string) =>
	!exportedFiles || path === "AGENTS.md" || exportedFiles.has(path);

async function workspaceScripts(workspace: string): Promise<Set<string>> {
	try {
		const manifest = JSON.parse(
			await readFile(resolve(repoRoot, workspace, "package.json"), "utf8"),
		) as { scripts?: Record<string, string> };
		return new Set(Object.keys(manifest.scripts ?? {}));
	} catch {
		return new Set();
	}
}

async function validateExportReferences(
	text: string,
	path: string,
): Promise<void> {
	const workspace = /^((?:apps|packages)\/[^/]+)\//.exec(path)?.[1];
	for (const match of text.matchAll(
		/(?:\bcd ([\w./-]+)(?: &&|\n)[ \t]*)?\bbun run (?:--cwd ([\w./-]+) )?(\w[\w:.-]*)/g,
	)) {
		const [command, cdDir, cwdFlag, name] = match;
		const cwd = cwdFlag ?? cdDir;
		const scripts = cwd
			? await workspaceScripts(cwd)
			: new Set([
					...exportedRootScripts,
					...(workspace ? await workspaceScripts(workspace) : []),
				]);
		if (!scripts.has(name!)) {
			throw new Error(`${path}: script the export lacks: ${command}`);
		}
	}
	for (const match of text.matchAll(/(?<![\w./-])scripts\/[\w./-]*\w/g)) {
		const target = match[0];
		// A stored skill's own workflow file, not a repository path.
		if (/^scripts\/workflow\.(?:ts|js|mjs|cjs)$/.test(target)) continue;
		const local =
			workspace &&
			(await lstat(resolve(repoRoot, workspace, target)).catch(() => null));
		if (!local && !exportedScriptPath(target)) {
			throw new Error(`${path}: path the export lacks: ${target}`);
		}
	}
	const commit = /\bcommit\s+`?[0-9a-f]{7,40}\b/i.exec(text);
	if (commit) {
		throw new Error(`${path}: cites a private commit: ${commit[0]}`);
	}
}

function frontmatter(text: string, path: string): string {
	if (!text.startsWith("---\n")) {
		throw new Error(`${path}: missing YAML frontmatter`);
	}
	const end = text.indexOf("\n---\n", 4);
	if (end === -1) throw new Error(`${path}: unterminated YAML frontmatter`);
	return text.slice(4, end);
}

function requireField(meta: string, field: string, path: string): void {
	if (!new RegExp(`^${field}:\\s*.+$`, "m").test(meta)) {
		throw new Error(`${path}: missing ${field} frontmatter`);
	}
}

function requireListField(meta: string, field: string, path: string): void {
	const match = new RegExp(
		`^${field}:\\s*\\n((?:[ \\t]+-[ \\t]+\\S.*(?:\\n|$))+)`,
		"m",
	).exec(meta);
	if (!match?.[1]) throw new Error(`${path}: missing non-empty ${field} list`);
}

function fieldValue(meta: string, field: string): string | null {
	const value = new RegExp(`^${field}:\\s*(.+)$`, "m").exec(meta)?.[1]?.trim();
	return value?.replace(/^['"]|['"]$/g, "") ?? null;
}

function validateLocalLinks(text: string, path: string): void {
	for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
		const target = match[1]?.trim();
		if (
			!target ||
			target.startsWith("#") ||
			target.startsWith("/") ||
			/^[a-z][a-z0-9+.-]*:/i.test(target)
		) {
			continue;
		}
		const withoutAnchor = target.split("#", 1)[0] ?? "";
		const resolved = resolve(dirname(path), withoutAnchor);
		const fromPublicRoot = relative(publicRoot, resolved);
		if (fromPublicRoot === ".." || fromPublicRoot.startsWith("../")) {
			throw new Error(
				`${relative(repoRoot, path)}: local link leaves docs/public: ${target}`,
			);
		}
	}
}

async function requireRepositoryTarget(
	path: string,
	rawTarget: string,
	target: string,
): Promise<void> {
	const resolved = resolve(repoRoot, target);
	const fromRepoRoot = relative(repoRoot, resolved);
	if (fromRepoRoot === ".." || fromRepoRoot.startsWith("../")) {
		throw new Error(`${path}: local link leaves repository: ${rawTarget}`);
	}
	if (exportedFiles && isExported(path)) {
		const readme = fromRepoRoot ? `${fromRepoRoot}/README.md` : "README.md";
		if (!isExported(fromRepoRoot) && !exportedFiles.has(readme)) {
			throw new Error(
				`${path}: local link target is not exported: ${rawTarget}`,
			);
		}
		return;
	}
	let stat;
	try {
		stat = await lstat(resolved);
	} catch {
		throw new Error(`${path}: local link target is missing: ${rawTarget}`);
	}
	if (stat.isDirectory()) {
		try {
			await lstat(resolve(resolved, "README.md"));
		} catch {
			throw new Error(
				`${path}: linked directory has no README.md: ${rawTarget}`,
			);
		}
	}
}

async function validateReadmeLinks(text: string, path: string): Promise<void> {
	for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
		const rawTarget = match[1]?.trim().replace(/^<|>$/g, "");
		if (!rawTarget || rawTarget.startsWith("#")) {
			continue;
		}
		const repositoryUrl = rawTarget.match(
			/^https:\/\/github\.com\/tedix-hq\/tedix\/(?:blob|tree)\/(?:main|[0-9a-f]{40})\/([^?#]+)(?:[?#].*)?$/i,
		);
		if (repositoryUrl?.[1]) {
			await requireRepositoryTarget(
				path,
				rawTarget,
				decodeURIComponent(repositoryUrl[1]),
			);
			continue;
		}
		if (/^[a-z][a-z0-9+.-]*:/i.test(rawTarget)) continue;
		if (rawTarget.startsWith("/")) {
			throw new Error(`${path}: local link is absolute: ${rawTarget}`);
		}
		const target = decodeURIComponent(rawTarget.split("#", 1)[0] ?? "");
		const repositoryTarget = relative(
			repoRoot,
			resolve(dirname(resolve(repoRoot, path)), target),
		);
		await requireRepositoryTarget(path, rawTarget, repositoryTarget);
	}
}

async function validateWorkspaceReadme(path: string): Promise<void> {
	const absolutePath = resolve(repoRoot, path);
	const stat = await lstat(absolutePath);
	if (stat.isSymbolicLink()) throw new Error(`${path}: symlinks are forbidden`);
	const text = await readFile(absolutePath, "utf8");
	for (const [pattern, label] of forbiddenWorkspaceReadmePatterns) {
		if (pattern.test(text)) throw new Error(`${path}: contains ${label}`);
	}
	await validateReadmeLinks(text, path);
	await validateExportReferences(text, path);
	for (const match of text.matchAll(
		/\b((?:apps\/[A-Za-z0-9_.-]+\/)?docs\/[A-Za-z0-9_./-]+\.md)\b/g,
	)) {
		const target = match[1];
		if (target) await requireRepositoryTarget(path, target, target);
	}
}

let markdownCount = 0;
const publicMarkdownPaths = new Set<string>();
const titleOwners = new Map<string, string>();
for await (const relativePath of markdownGlob.scan({
	cwd: publicRoot,
	onlyFiles: true,
})) {
	const path = resolve(publicRoot, relativePath);
	const stat = await lstat(path);
	if (stat.isSymbolicLink()) {
		throw new Error(`${relative(repoRoot, path)}: symlinks are forbidden`);
	}
	const text = await readFile(path, "utf8");
	const meta = frontmatter(text, relative(repoRoot, path));
	requireField(meta, "title", relative(repoRoot, path));
	requireField(meta, "description", relative(repoRoot, path));
	requireField(meta, "summary", relative(repoRoot, path));
	requireListField(meta, "read_when", relative(repoRoot, path));
	const title = fieldValue(meta, "title");
	if (!title) throw new Error(`${relative(repoRoot, path)}: empty title`);
	const priorTitleOwner = titleOwners.get(title);
	if (priorTitleOwner) {
		throw new Error(
			`${relative(repoRoot, path)}: duplicate title "${title}" also used by ${priorTitleOwner}`,
		);
	}
	titleOwners.set(title, relative(repoRoot, path));
	if (!/^visibility:\s*public\s*$/m.test(meta)) {
		throw new Error(
			`${relative(repoRoot, path)}: visibility must be exactly public`,
		);
	}
	if (/^(?:draft|noindex):\s*true\s*$/m.test(meta)) {
		throw new Error(
			`${relative(repoRoot, path)}: public source cannot be draft or noindex`,
		);
	}
	for (const [pattern, label] of forbiddenPatterns) {
		if (pattern.test(text)) {
			throw new Error(`${relative(repoRoot, path)}: contains ${label}`);
		}
	}
	validateLocalLinks(text, path);
	await validateExportReferences(text, relative(repoRoot, path));
	publicMarkdownPaths.add(relativePath);
	markdownCount += 1;
}

const publicIndexPath = resolve(publicRoot, "index.md");
const publicIndex = await readFile(publicIndexPath, "utf8");
const indexedMarkdownPaths = new Set<string>();
for (const match of publicIndex.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
	const target = match[1]?.trim().replace(/^<|>$/g, "");
	if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
	const withoutAnchor = decodeURIComponent(target.split("#", 1)[0] ?? "");
	if (!/\.mdx?$/i.test(withoutAnchor)) continue;
	indexedMarkdownPaths.add(
		relative(publicRoot, resolve(publicRoot, withoutAnchor)),
	);
}
for (const relativePath of publicMarkdownPaths) {
	if (relativePath === "index.md") continue;
	if (!indexedMarkdownPaths.has(relativePath)) {
		throw new Error(
			`docs/public/index.md: public page is not indexed: ${relativePath}`,
		);
	}
}

let internalMarkdownCount = 0;
for await (const relativePath of allDocsGlob.scan({
	cwd: docsRoot,
	onlyFiles: true,
})) {
	if (relativePath === "public" || relativePath.startsWith("public/")) continue;
	const path = resolve(docsRoot, relativePath);
	const text = await readFile(path, "utf8");
	if (!text.startsWith("---\n")) continue;
	const meta = frontmatter(text, relative(repoRoot, path));
	if (/^visibility:\s*public\s*$/m.test(meta)) {
		throw new Error(
			`${relative(repoRoot, path)}: public visibility is forbidden outside docs/public`,
		);
	}
	internalMarkdownCount += 1;
}

for await (const relativePath of assetGlob.scan({
	cwd: publicRoot,
	onlyFiles: false,
})) {
	const path = resolve(publicRoot, relativePath);
	const stat = await lstat(path);
	if (stat.isSymbolicLink()) {
		throw new Error(`${relative(repoRoot, path)}: symlinks are forbidden`);
	}
	if (!stat.isFile()) continue;
	const extension = extname(relativePath).toLowerCase();
	if (!allowedPublicAssetExtensions.has(extension)) {
		throw new Error(
			`${relative(repoRoot, path)}: unsupported public asset extension`,
		);
	}
	if (textAssetExtensions.has(extension)) {
		const text = await readFile(path, "utf8");
		for (const [pattern, label] of forbiddenPatterns) {
			if (pattern.test(text)) {
				throw new Error(`${relative(repoRoot, path)}: contains ${label}`);
			}
		}
	}
}

if (markdownCount === 0) throw new Error("docs/public contains no Markdown");
await validateReadmeLinks(
	await readFile(resolve(repoRoot, "README.md"), "utf8"),
	"README.md",
);
for (const path of [
	"CODE_OF_CONDUCT.md",
	"CONTRIBUTING.md",
	"GOVERNANCE.md",
	"LICENSES/README.md",
	"README.md",
	"RELEASING.md",
	"SECURITY.md",
	"SUPPORT.md",
	"TRADEMARKS.md",
]) {
	await validateExportReferences(
		await readFile(resolve(repoRoot, path), "utf8"),
		path,
	);
}
let workspaceReadmeCount = 0;
for await (const path of workspaceReadmeGlob.scan({
	cwd: repoRoot,
	onlyFiles: true,
})) {
	await validateWorkspaceReadme(path);
	workspaceReadmeCount += 1;
}
// Scoped instructions ship beside workspace code. Check their references too;
// README-only validation missed links to private engineering docs.
for await (const path of workspaceAgentGlob.scan({
	cwd: repoRoot,
	onlyFiles: true,
})) {
	const text = await readFile(resolve(repoRoot, path), "utf8");
	await validateReadmeLinks(text, path);
	await validateExportReferences(text, path);
	for (const match of text.matchAll(/\b(docs\/[A-Za-z0-9_./-]+\.md)\b/g)) {
		await requireRepositoryTarget(path, match[1]!, match[1]!);
	}
}
// The engineering reference set publishes at its source paths outside
// docs/public. Its links may reach only each other, docs/public, exported
// source files, or external URLs. In the public tree every doc on disk ships.
const engineeringDocs: string[] = [];
for await (const relativePath of allDocsGlob.scan({
	cwd: docsRoot,
	onlyFiles: true,
})) {
	if (relativePath.startsWith("public/")) continue;
	const path = `docs/${relativePath}`;
	if (!exportedFiles || exportedFiles.has(path)) engineeringDocs.push(path);
}
const engineeringDocSet = new Set(engineeringDocs);
for (const path of engineeringDocs) {
	const text = await readFile(resolve(repoRoot, path), "utf8");
	for (const [pattern, label] of forbiddenPatterns) {
		if (pattern.test(text)) throw new Error(`${path}: contains ${label}`);
	}
	for (const match of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
		const rawTarget = match[1]?.trim().replace(/^<|>$/g, "");
		if (!rawTarget || rawTarget.startsWith("#")) continue;
		if (/^[a-z][a-z0-9+.-]*:/i.test(rawTarget)) continue;
		if (rawTarget.startsWith("/")) {
			throw new Error(`${path}: local link is absolute: ${rawTarget}`);
		}
		const target = relative(
			repoRoot,
			resolve(
				dirname(resolve(repoRoot, path)),
				decodeURIComponent(rawTarget.split("#", 1)[0] ?? ""),
			),
		);
		if (
			/^docs\/.*\.mdx?$/.test(target) &&
			!target.startsWith("docs/public/") &&
			!engineeringDocSet.has(target)
		) {
			throw new Error(`${path}: links an unpublished doc: ${rawTarget}`);
		}
		await requireRepositoryTarget(path, rawTarget, target);
	}
	await validateExportReferences(text, path);
}
// This public manual is also copied to the export root, where relative links
// resolve differently. Check both locations without reading private root rules.
await validateReadmeLinks(
	await readFile(resolve(publicRoot, "AGENTS.md"), "utf8"),
	"AGENTS.md",
);
console.log(
	`public docs boundary ok: ${markdownCount} indexed public Markdown files, ${internalMarkdownCount} internal frontmatter files, ${engineeringDocs.length} engineering docs, ${workspaceReadmeCount} workspace READMEs`,
);
