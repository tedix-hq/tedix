import {
	ProtocolError,
	ProtocolErrorCode,
	ResourceTemplate,
} from "@modelcontextprotocol/server";
import {
	GetSkillParamsSchema,
	GetSkillResultSchema,
	ListSkillsParamsSchema,
	ListSkillsResultSchema,
	type McpSkillEntry,
} from "@tedix/mcp-shared/skills";
import {
	MCP_RESULT_CACHE_HINT_META_KEY,
	type McpCompletionRequest,
	type McpCompletionResult,
	type McpDirectoryReadHandler,
} from "@tedix/mcp-shared/transport";
import * as z from "zod";
import { buildSkillCompletionHandler } from "./completions";
import {
	type ToolCallback,
	wrapToolCallTelemetry,
} from "./middleware/telemetry";
import { resourceNotFound } from "./registration/resource-templates";
import type { ServerContext } from "./server-context";
import {
	computeSkillPath,
	renderSkillIndexEntry,
	renderSkillMarkdown,
	SkillResourceLimitError,
	skillToolNames,
	type SkillDocumentEntry,
} from "./skill-document";
import { mapWithConcurrency, SKILL_INDEX_CACHE_HINT } from "./skill-cache";
import {
	readRenderedSkills,
	releaseRenderedSkillsRevalidate,
	renderedSkillsCacheKey,
	reserveRenderedSkillsRevalidate,
	writeRenderedSkills,
} from "./skill-snapshot-cache";
import {
	paginateSortedSkillsList,
	sortSkillEntriesDeterministically,
} from "./skills-list-pagination";
import { toMcpDateTime } from "./utils/datetime";
import { trackResourceRead } from "./resource-read-telemetry";
import {
	loadCachedSkillSnapshot,
	skillSnapshotFingerprint,
} from "./skill-registration-snapshot";

/**
 * Skill entry from D1 cognitive skill_entries table.
 */
type SkillIndexEntry = SkillDocumentEntry;

function skillFileMimeType(filePath: string): string {
	const lower = filePath.toLowerCase();
	if (lower.endsWith(".md")) return "text/markdown";
	if (lower.endsWith(".json")) return "application/json";
	if (lower.endsWith(".yaml") || lower.endsWith(".yml"))
		return "application/yaml";
	if (lower.endsWith(".sh")) return "text/x-shellscript";
	if (lower.endsWith(".py")) return "text/x-python";
	if (lower.endsWith(".js") || lower.endsWith(".ts")) return "text/javascript";
	return "text/plain";
}

function listSkillDirectoryResources(
	skill: SkillIndexEntry,
	agent: ServerContext,
	directoryPath: string,
): Array<Record<string, unknown>> | null {
	const normalized = directoryPath.replace(/^\/+|\/+$/g, "");
	const prefix = normalized ? `${normalized}/` : "";
	const paths = ["SKILL.md", ...Object.keys(skill.files ?? {})];
	const children = new Map<
		string,
		{ filePath: string; name: string; mimeType: string; directory: boolean }
	>();

	for (const filePath of paths) {
		if (prefix && !filePath.startsWith(prefix)) continue;
		const rest = prefix ? filePath.slice(prefix.length) : filePath;
		if (!rest) continue;
		const [first, ...tail] = rest.split("/");
		if (!first) continue;
		const childPath = prefix ? `${prefix}${first}` : first;
		if (tail.length > 0) {
			children.set(first, {
				filePath: childPath,
				name: first,
				mimeType: "inode/directory",
				directory: true,
			});
			continue;
		}
		if (!children.has(first)) {
			children.set(first, {
				filePath: childPath,
				name: first,
				mimeType: skillFileMimeType(childPath),
				directory: false,
			});
		}
	}
	if (normalized && children.size === 0) return null;
	const root = computeSkillPath(skill, agent.appSlug ?? null);
	return [...children.values()]
		.sort((a, b) => {
			if (a.directory !== b.directory) return a.directory ? 1 : -1;
			return a.name.localeCompare(b.name);
		})
		.map((child) => ({
			uri: `skill://${root}/${child.filePath}`,
			name: child.name,
			mimeType: child.mimeType,
		}));
}

/**
 * In-flight cap for the per-skill digest render (`renderSkillIndexEntry` runs a
 * SHA-256 over each skill body + every attached file). A serial loop over ~160
 * skills cost multiple seconds on every cache-MISS build — the residual behind
 * the slow `resources/list` that timed out delegated Code-Mode connects. Bounded
 * concurrency overlaps the Web Crypto work without the unbounded `Promise.all`
 * fan-out that "starves the isolate" (the reason the loop was serial).
 */
const SKILL_DIGEST_RENDER_CONCURRENCY = 8;

/**
 * Register app-scoped skills as MCP tools + resources.
 * Progressive disclosure: list_skills returns summaries, read_skill returns full content.
 * Also registers skill:// resources for direct resource access.
 */
export async function registerAppSkills(agent: ServerContext): Promise<void> {
	if (!agent.appId || !agent.apiClient) return;

	const skillIndex = await loadCachedSkillSnapshot(agent);

	// SEP-2640: candidates for skill:// resource-template variable
	// completion (`skill_name` / `app_slug`), derived from the registered skill
	// paths so hosts can autocomplete a skill before reading its resource.
	const skillNameCandidates = new Set<string>();
	const appSlugCandidates = new Set<string>();
	for (const skill of skillIndex.values()) {
		const segments = computeSkillPath(skill, agent.appSlug ?? null).split("/");
		const skillName = segments[segments.length - 1];
		if (skillName) skillNameCandidates.add(skillName);
		if (segments.length > 1 && segments[0]) appSlugCandidates.add(segments[0]);
	}

	// Build UUID → toolId reverse map for human-readable tool names in skill frontmatter
	const uuidToToolId = new Map<string, string>();
	const toolIdToUuid = new Map<string, string>();
	for (const [toolId, tool] of agent.loadedTools) {
		uuidToToolId.set(tool.id, toolId);
		toolIdToUuid.set(toolId, tool.id);
	}

	console.log(
		`[MCP] Registering ${skillIndex.size} app skill(s) (list_skills + read_skill + resources)`,
	);

	// Render the snapshot into McpSkillEntry[] (SHA-256 over each skill body +
	// file), fronted by the rendered-skills cache so a warm build skips the whole
	// digest render. The render is a pure function of the snapshot + appSlug +
	// uuid→toolId map + render code, all captured in the key below, so a hit only
	// serves digests consistent with this request's resource-reads.
	const renderProtocolSkills = async (): Promise<McpSkillEntry[]> => {
		const rendered = await mapWithConcurrency(
			[...skillIndex.values()],
			SKILL_DIGEST_RENDER_CONCURRENCY,
			async (skill) => {
				try {
					return await renderSkillIndexEntry(
						skill,
						agent.appSlug ?? null,
						uuidToToolId,
					);
				} catch (error) {
					if (!(error instanceof SkillResourceLimitError)) throw error;
					console.warn(
						`[MCP] Omitting non-conforming skill ${skill.slug ?? skill.id}: ${error instanceof Error ? error.message : String(error)}`,
					);
					return null;
				}
			},
		);
		return rendered.filter((entry): entry is McpSkillEntry => entry !== null);
	};
	const renderKey = renderedSkillsCacheKey({
		// Bump when the manifest wire shape or rendering rules change; older
		// cached entries may lack the final SEP-2640 `size` property.
		fingerprint: `skills-manifest-v2:${skillSnapshotFingerprint(agent.env)}`,
		appSlug: agent.appSlug ?? "",
		skillRevisions: [...skillIndex.values()].map(
			(skill) => [skill.id, skill.revision ?? null] as const,
		),
		toolIdMap: [...uuidToToolId.entries()],
	});
	let protocolSkillEntries: McpSkillEntry[];
	let renderedHit: Awaited<ReturnType<typeof readRenderedSkills>> = null;
	try {
		renderedHit = await readRenderedSkills(renderKey);
	} catch {
		renderedHit = null;
	}
	if (renderedHit) {
		protocolSkillEntries = renderedHit.entries;
		// SWR: serve the cached render now, refresh once in the background.
		if (renderedHit.stale && reserveRenderedSkillsRevalidate(renderKey)) {
			agent.ctx.waitUntil(
				(async () => {
					try {
						await writeRenderedSkills(renderKey, await renderProtocolSkills());
					} catch (error) {
						console.warn(
							`[MCP] rendered-skills revalidate failed: ${error instanceof Error ? error.message : String(error)}`,
						);
					} finally {
						releaseRenderedSkillsRevalidate(renderKey);
					}
				})(),
			);
		}
	} else {
		protocolSkillEntries = await renderProtocolSkills();
		await writeRenderedSkills(renderKey, protocolSkillEntries);
	}
	const protocolSkillsByUri = new Map(
		protocolSkillEntries.map((entry) => [entry.uri, entry as McpSkillEntry]),
	);
	const protocolSkillPaths = new Set(
		protocolSkillEntries.map((entry) =>
			entry.uri.slice("skill://".length, -"/SKILL.md".length),
		),
	);
	// Deterministic catalog order for cursor pagination: the skillIndex Map's
	// insertion order derives from D1 read order and is not stable across
	// isolates, so sort by uri once here — a cursor minted on one isolate must
	// anchor the same position on the next.
	const sortedProtocolSkills = sortSkillEntriesDeterministically([
		...protocolSkillsByUri.values(),
	]);
	agent.server.server.setRequestHandler(
		"skills/list",
		{ params: ListSkillsParamsSchema, result: ListSkillsResultSchema },
		async ({ cursor }) => {
			const page = paginateSortedSkillsList(sortedProtocolSkills, cursor);
			if (!page.ok) {
				// Spec (2026-07-28 pagination): invalid cursors SHOULD
				// result in -32602 Invalid params.
				throw new ProtocolError(
					ProtocolErrorCode.InvalidParams,
					"Invalid params: unrecognized skills/list cursor",
				);
			}
			return {
				skills: page.skills,
				...(page.nextCursor !== undefined
					? { nextCursor: page.nextCursor }
					: {}),
			};
		},
	);
	agent.server.server.setRequestHandler(
		"skills/get",
		{ params: GetSkillParamsSchema, result: GetSkillResultSchema },
		async ({ uri }) => {
			const skill = protocolSkillsByUri.get(uri);
			if (!skill) {
				throw new ProtocolError(
					ProtocolErrorCode.InvalidParams,
					`Unknown skill URI: ${uri}`,
				);
			}
			return { skill };
		},
	);
	// Declaring the extension commits the server to both methods even when the
	// enumerable catalog is empty. Tool/resource conveniences remain absent.
	if (skillIndex.size === 0) return;

	// Register list_skills tool
	const listSkillsCb: ToolCallback = async (args) => {
		const { toolId } = args as { toolId?: string };
		const entries = Array.from(skillIndex.values()).filter((skill) =>
			protocolSkillPaths.has(computeSkillPath(skill, agent.appSlug ?? null)),
		);
		const toolUuid = toolId ? (toolIdToUuid.get(toolId) ?? toolId) : null;
		const filtered = toolId
			? entries.filter((s) => s.toolIds?.includes(toolUuid ?? toolId))
			: entries;

		const items = filtered.map((s) => ({
			id: s.id,
			title: s.title,
			summary: s.summary ?? s.description ?? "No description",
			toolIds: s.toolIds,
			source: s.source,
		}));

		return {
			content: [
				{
					type: "text" as const,
					text:
						items.length > 0
							? items
									.map(
										(i) =>
											`- **${i.title}** (${i.id}): ${i.summary}${i.toolIds?.length ? ` [tools: ${i.toolIds.map((id: string) => uuidToToolId.get(id) ?? id).join(", ")}]` : ""}`,
									)
									.join("\n")
							: "No skills found.",
				},
			],
			structuredContent: { skills: items },
		};
	};

	const listSkillsTool = agent.server.registerTool(
		"list_skills",
		{
			title: "List Skills",
			description:
				"List available skills (proven procedures) for this app. Returns summaries — use read_skill to get the full procedure.",
			inputSchema: z.object({
				toolId: z
					.string()
					.optional()
					.describe("Optional: filter skills related to a specific tool"),
			}),
			annotations: {
				readOnlyHint: true,
				openWorldHint: false,
				destructiveHint: false,
			},
		},
		wrapToolCallTelemetry(
			"list_skills",
			agent,
			listSkillsCb,
		) as unknown as Parameters<typeof agent.server.registerTool>[2],
	);
	agent.registeredTools.set("list_skills", listSkillsTool);
	agent.appToolIds.add("list_skills");

	// Register read_skill tool
	const readSkillCb: ToolCallback = async (args) => {
		const { skillId } = args as { skillId: string };
		let skill = skillIndex.get(skillId);
		if (!skill) {
			// Fallback: match by slug
			for (const entry of skillIndex.values()) {
				if (entry.slug === skillId) {
					skill = entry;
					break;
				}
			}
		}
		if (!skill) {
			return {
				content: [
					{
						type: "text" as const,
						text: `Skill not found: ${skillId}. Use list_skills to see available skills.`,
					},
				],
				isError: true,
			};
		}
		if (
			!protocolSkillPaths.has(computeSkillPath(skill, agent.appSlug ?? null))
		) {
			return {
				content: [
					{
						type: "text" as const,
						text: `Skill ${skillId} exceeds the MCP Skills extension resource limits.`,
					},
				],
				isError: true,
			};
		}

		trackResourceRead(agent, {
			resourceType: "skill",
			skillId: skill.id,
			skillTitle: skill.title,
			source: skill.source,
		});

		return {
			content: [
				{
					type: "text" as const,
					text: renderSkillMarkdown(skill, agent.appSlug ?? null, uuidToToolId),
				},
			],
		};
	};

	const readSkillTool = agent.server.registerTool(
		"read_skill",
		{
			title: "Read Skill",
			description:
				"Read the full procedure content of a skill. Use list_skills first to discover available skills.",
			inputSchema: z.object({
				skillId: z.string().describe("The skill ID or slug from list_skills"),
			}),
			annotations: {
				readOnlyHint: true,
				openWorldHint: false,
				destructiveHint: false,
			},
		},
		wrapToolCallTelemetry(
			"read_skill",
			agent,
			readSkillCb,
		) as unknown as Parameters<typeof agent.server.registerTool>[2],
	);
	agent.registeredTools.set("read_skill", readSkillTool);
	agent.appToolIds.add("read_skill");

	// Register skill:// resources (MCP ext-skills WG convention)
	for (const [, skill] of skillIndex) {
		const skillSlug = skill.slug ?? skill.id;
		const skillPath = computeSkillPath(skill, agent.appSlug ?? null);
		if (!protocolSkillPaths.has(skillPath)) continue;
		const resourceId = `skill:${skillPath}`;
		const skillUri = `skill://${skillPath}/SKILL.md`;
		const skillAudience = skill.audience ?? ["assistant"];
		const resourceName = skill.appSlugOverride
			? `${skill.appSlugOverride}/${skillSlug}`
			: skillSlug;

		if (agent.registeredResources.has(resourceId)) continue;

		// SEP: name SHOULD be from frontmatter name (= slug), description from frontmatter description
		const registeredResource = agent.server.registerResource(
			resourceName,
			skillUri,
			{
				description: skill.description || skill.summary || skill.title,
				mimeType: "text/markdown",
				// MCP spec 2025-11-25: audience / priority / lastModified live at top-level.
				annotations: {
					audience: skillAudience.filter(
						(a): a is "user" | "assistant" => a === "user" || a === "assistant",
					),
					priority: 1.0,
					lastModified: toMcpDateTime(skill.updatedAt ?? skill.createdAt),
				},
				// Custom (non-spec) fields stay under _meta with the
				// io.tedix/ prefix per SEP-2640 § _meta key-name format.
				_meta: {
					"io.tedix/frontmatter": {
						version: skill.revision,
						tags: skill.tags ?? [],
						tools: skillToolNames(skill, uuidToToolId),
						audience: skillAudience,
						provenance: `${agent.appSlug ?? "tedix"}.mcp.tedix.dev`,
					},
					"io.tedix/version": skill.revision,
					"io.tedix/tags": skill.tags,
					"io.tedix/toolIds": skill.toolIds,
					"io.tedix/successCount": skill.successCount,
					"io.tedix/size": new TextEncoder().encode(skill.content).length,
					"io.tedix/provenance": {
						source: "d1",
						skillId: skill.id,
						serverUrl: `https://${agent.appSlug ?? "tedix"}.mcp.tedix.dev`,
					},
				},
			},
			async () => {
				trackResourceRead(agent, {
					resourceUri: skillUri,
					resourceType: "skill",
					skillId: skill.id,
					skillTitle: skill.title,
				});

				return {
					contents: [
						{
							uri: skillUri,
							mimeType: "text/markdown",
							text: renderSkillMarkdown(
								skill,
								agent.appSlug ?? null,
								uuidToToolId,
							),
						},
					],
					// SEP-2549: skill content changes on skill mutations — same
					// freshness window as the index/skill-summary cache
					// (consumed + stripped by the transport).
					_meta: {
						[MCP_RESULT_CACHE_HINT_META_KEY]: SKILL_INDEX_CACHE_HINT,
					},
				};
			},
		);

		agent.registeredResources.set(resourceId, registeredResource);
		agent.appResourceIds.add(resourceId);
	}

	// Shared handler for skill:// resource templates
	const handleSkillTemplate = async (
		uri: URL,
		variables: Record<string, string | string[]>,
	) => {
		const skillName = String(variables.skill_name ?? "");
		const appSlug = variables.app_slug ? String(variables.app_slug) : null;
		const skill = Array.from(skillIndex.values()).find(
			(s) =>
				(s.slug ?? s.id) === skillName &&
				(!appSlug ||
					s.appSlugOverride === appSlug ||
					(!s.appSlugOverride && agent.appSlug === appSlug)),
		);

		if (!skill) {
			resourceNotFound(uri, { resourceType: "skill", skillName });
		}
		if (
			!protocolSkillPaths.has(computeSkillPath(skill, agent.appSlug ?? null))
		) {
			resourceNotFound(uri, {
				resourceType: "skill",
				filePath: "SKILL.md",
				detail: "Skill exceeds the MCP Skills extension resource limits",
			});
		}

		trackResourceRead(agent, {
			resourceUri: uri.toString(),
			resourceType: "skill",
			skillId: skill.id,
			skillTitle: skill.title,
		});

		return {
			contents: [
				{
					uri: uri.toString(),
					mimeType: "text/markdown",
					text: renderSkillMarkdown(skill, agent.appSlug ?? null, uuidToToolId),
				},
			],
			// SEP-2549: same freshness window as the registered SKILL.md
			// resources above (consumed + stripped by the transport).
			_meta: {
				[MCP_RESULT_CACHE_HINT_META_KEY]: SKILL_INDEX_CACHE_HINT,
			},
		};
	};

	// Folder-style skills handler — serves any file in the skill directory.
	// SEP-2640 directory model: each file in the skill directory is addressable
	// at skill://<skill-path>/{+filePath}. SKILL.md routes to the existing handler;
	// other paths look up `skill.files[filePath]` from D1.
	const handleSkillFile = async (
		uri: URL,
		variables: Record<string, string | string[]>,
	) => {
		let filePath = String(variables.file_path ?? "");
		let skillName = String(variables.skill_name ?? "");
		let appSlug = variables.app_slug ? String(variables.app_slug) : null;
		// Canonical SKILL.md → reuse the markdown frontmatter handler.
		if (filePath === "SKILL.md") return handleSkillTemplate(uri, variables);
		// Defensive: if the flat template matched but `skill_name` is actually an
		// app slug (because the SDK routed an app-scoped URI to the flat template),
		// re-split — first segment becomes app_slug, second becomes skill_name,
		// remainder becomes file_path.
		if (!appSlug) {
			const directHit = Array.from(skillIndex.values()).find(
				(s) => (s.slug ?? s.id) === skillName,
			);
			if (!directHit && filePath.includes("/")) {
				const slash = filePath.indexOf("/");
				const candidateSkill = filePath.slice(0, slash);
				const candidateRest = filePath.slice(slash + 1);
				const recovered = Array.from(skillIndex.values()).find(
					(s) =>
						(s.slug ?? s.id) === candidateSkill &&
						s.appSlugOverride === skillName,
				);
				if (recovered) {
					appSlug = skillName;
					skillName = candidateSkill;
					filePath = candidateRest;
				}
			}
		}
		const skill = Array.from(skillIndex.values()).find(
			(s) =>
				(s.slug ?? s.id) === skillName &&
				(!appSlug ||
					s.appSlugOverride === appSlug ||
					(!s.appSlugOverride && agent.appSlug === appSlug)),
		);
		// Skill-existence + ownership check first. If the requested skill
		// doesn't exist (or doesn't belong to this app), fail with
		// resource_not_found *before* branching into the runs/ subtree —
		// otherwise an attacker could probe `skill://nonexistent/runs/{anyId}/...`
		// and learn whether a run id maps to *some* skill on the platform via timing.
		if (!skill) {
			resourceNotFound(uri, { resourceType: "skill", skillName, filePath });
		}
		if (
			!protocolSkillPaths.has(computeSkillPath(skill, agent.appSlug ?? null))
		) {
			resourceNotFound(uri, {
				resourceType: "skill",
				filePath,
				detail: "Skill exceeds the MCP Skills extension resource limits",
			});
		}
		// runs/{runId}/... paths are dynamic execution artifacts backed by
		// the `skill_run_artifacts` D1 table (+ R2 for spilled payloads).
		// We route through apps/api's `skills.getRunArtifact` procedure
		// rather than touching D1/R2 directly — apps/mcp is the protocol
		// edge, all data fetches go through apps/api.
		if (filePath.startsWith("runs/")) {
			const stripped = filePath.slice("runs/".length);
			const slash = stripped.indexOf("/");
			if (slash === -1) {
				resourceNotFound(uri, {
					resourceType: "skill",
					filePath,
					expectedTemplate: "runs/{runId}/{path}",
				});
			}
			const runId = stripped.slice(0, slash);
			const artifactPath = stripped.slice(slash + 1);
			try {
				const result = await agent.apiClient.skills.getRunArtifact({
					runId,
					path: artifactPath,
					skillId: skill.id,
				});
				return {
					contents: [
						{
							uri: uri.toString(),
							mimeType: result.mimeType,
							text: result.content ?? "",
						},
					],
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				resourceNotFound(uri, {
					resourceType: "skill",
					filePath,
					detail: message,
				});
			}
		}
		if (!skill.files || !(filePath in skill.files)) {
			resourceNotFound(uri, { resourceType: "skill", skillName, filePath });
		}
		const text = skill.files[filePath]!;
		const lower = filePath.toLowerCase();
		const mimeType = lower.endsWith(".md")
			? "text/markdown"
			: lower.endsWith(".json")
				? "application/json"
				: lower.endsWith(".yaml") || lower.endsWith(".yml")
					? "application/yaml"
					: lower.endsWith(".sh")
						? "text/x-shellscript"
						: lower.endsWith(".py")
							? "text/x-python"
							: lower.endsWith(".js") || lower.endsWith(".ts")
								? "text/javascript"
								: "text/plain";
		return {
			contents: [{ uri: uri.toString(), mimeType, text }],
			// SEP-2549: skill directory files mutate with the skill row — same
			// freshness window as SKILL.md/index reads. The dynamic runs/ branch
			// above deliberately keeps the transport default.
			_meta: {
				[MCP_RESULT_CACHE_HINT_META_KEY]: SKILL_INDEX_CACHE_HINT,
			},
		};
	};

	// Register flat resource template: skill://{skill_name}/SKILL.md
	agent.server.registerResource(
		"skill-template",
		new ResourceTemplate("skill://{skill_name}/SKILL.md", { list: undefined }),
		{
			description:
				"Skill procedure by name. URI: skill://{skill_name}/SKILL.md",
		},
		handleSkillTemplate,
	);

	// Register hierarchical resource template: skill://{app_slug}/{skill_name}/SKILL.md
	agent.server.registerResource(
		"skill-template-app",
		new ResourceTemplate("skill://{app_slug}/{skill_name}/SKILL.md", {
			list: undefined,
		}),
		{
			description:
				"App-scoped skill procedure. URI: skill://{app_slug}/{skill_name}/SKILL.md",
		},
		handleSkillTemplate,
	);

	// SEP-2640 directory model: skill://{skill_name}/{+file_path} serves any file
	// within the skill directory. SKILL.md is canonical; other files come from
	// skill.files (D1 JSON column). This unlocks references/, scripts/, etc.
	// Register app-scoped first so the SDK prefers the more-specific template
	// when both match (e.g. skill://firecrawl-tedix/single-page/.../example.md).
	agent.server.registerResource(
		"skill-file-app",
		new ResourceTemplate("skill://{app_slug}/{skill_name}/{+file_path}", {
			list: undefined,
		}),
		{
			description: "Any file within an app-scoped skill directory.",
		},
		handleSkillFile,
	);
	agent.server.registerResource(
		"skill-file",
		new ResourceTemplate("skill://{skill_name}/{+file_path}", {
			list: undefined,
		}),
		{
			description:
				"Any file within a skill directory (SEP-2640 directory model).",
		},
		handleSkillFile,
	);

	const directoryReadHandler: McpDirectoryReadHandler = ({ uri }) => {
		let parsed: URL;
		try {
			parsed = new URL(uri);
		} catch {
			throw new Error("Invalid URI");
		}
		if (parsed.protocol !== "skill:") {
			throw new Error("Only skill:// directory URIs are supported");
		}
		const segments = [
			parsed.hostname,
			...parsed.pathname.split("/").filter(Boolean),
		].filter(Boolean);
		if (segments.length < 1 || segments[0] === "index.json") {
			throw new Error("Skill directory URI must include a skill name");
		}
		if (segments.at(-1) === "SKILL.md") {
			throw new Error("Skill directory URI must identify a directory");
		}

		let skillName = decodeURIComponent(segments[0] ?? "");
		let appSlug: string | null = null;
		let directoryPath = segments.slice(1).map(decodeURIComponent).join("/");
		let skill = Array.from(skillIndex.values()).find(
			(s) => (s.slug ?? s.id) === skillName,
		);
		if (!skill && segments.length >= 2) {
			appSlug = decodeURIComponent(segments[0] ?? "");
			skillName = decodeURIComponent(segments[1] ?? "");
			directoryPath = segments.slice(2).map(decodeURIComponent).join("/");
			skill = Array.from(skillIndex.values()).find(
				(s) =>
					(s.slug ?? s.id) === skillName &&
					(s.appSlugOverride === appSlug ||
						(!s.appSlugOverride && agent.appSlug === appSlug)),
			);
		}
		if (!skill) throw new Error("Skill directory not found");

		const resources = listSkillDirectoryResources(skill, agent, directoryPath);
		if (!resources) throw new Error("Resource is not a directory");
		return { resources };
	};
	(
		agent.server as unknown as {
			tedixSkillDirectoryReadHandler?: McpDirectoryReadHandler;
		}
	).tedixSkillDirectoryReadHandler = directoryReadHandler;
	// SEP-2640: expose skill-template variable completion; index.ts merges
	// it into the surface's completion handler and advertises `completions`.
	(
		agent.server as unknown as {
			tedixSkillCompletionHandler?: (
				input: McpCompletionRequest,
			) => McpCompletionResult | null;
		}
	).tedixSkillCompletionHandler = buildSkillCompletionHandler({
		skillNames: [...skillNameCandidates],
		appSlugs: [...appSlugCandidates],
	});

	// Build tool→skill map for coupled skill context
	// Skills with toolIds are linked to specific tools — when the tool is called,
	// its skills provide operational context (like widgets provide UI).
	for (const [, skill] of skillIndex) {
		if (!skill.toolIds?.length) continue;
		const skillRef = {
			id: skill.id,
			title: skill.title,
			uri: `skill://${computeSkillPath(skill, agent.appSlug ?? null)}/SKILL.md`,
		};
		for (const refId of skill.toolIds) {
			const resolvedToolId = uuidToToolId.get(refId) ?? refId;
			const existing = agent.toolSkillMap.get(resolvedToolId) ?? [];
			existing.push(skillRef);
			agent.toolSkillMap.set(resolvedToolId, existing);
		}
	}

	// Enrich tool descriptions with linked skill context
	// Like widgets couple UI to tools, skills couple operational knowledge to tools
	for (const [toolId, skillRefs] of agent.toolSkillMap) {
		const registeredTool = agent.registeredTools.get(toolId);
		if (!registeredTool) continue;

		const linkedSkills = skillRefs
			.map((ref) => skillIndex.get(ref.id))
			.filter(Boolean);

		if (linkedSkills.length === 0) continue;

		// Build skill context to append to tool description
		const skillContext = linkedSkills
			.map((s) => {
				const summary = s!.summary ?? s!.description ?? s!.title;
				return `• ${s!.title}: ${summary}`;
			})
			.join("\n");

		const currentDesc = registeredTool.description ?? "";
		const skillUris = skillRefs.map((ref) => ref.uri).join(", ");
		const enrichedDesc = `${currentDesc}\n\n📋 Skills (proven procedures for this tool):\n${skillContext}\n\nUse read_skill or resources/read (${skillUris}) for full procedures.`;

		registeredTool.update({ description: enrichedDesc });
	}

	const toolLinkedCount = agent.toolSkillMap.size;
	console.log(
		`[MCP] Registered ${skillIndex.size} skill(s): list_skills + read_skill tools + ${skillIndex.size} resource(s) + ${toolLinkedCount} tool-linked skill(s)`,
	);
}
