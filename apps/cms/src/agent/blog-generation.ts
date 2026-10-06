import type { McpServer } from "@tedix/mcp-shared/server";
import {
	type AiGatewayTransport,
	resolveAiGatewayTransport,
} from "@tedix/workers-ai/gateway-transport";
import * as z from "zod";
import { type CmsProxyContext, callCmsRest } from "./cms-proxy-runtime";
import { unwrapCmsToolResult } from "./tool-result";

// MCP SDK 1.29 supports Zod v4 at runtime but TS overload resolution
// can't match v4's ZodObject against the SDK's AnySchema union.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const schema = (s: z.ZodType): any => s;

type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	structuredContent?: unknown;
	isError?: true;
};

interface GeminiResponse {
	candidates?: Array<{
		content?: {
			parts?: Array<{ text?: string }>;
		};
	}>;
	error?: { message?: string };
}

interface GeneratedFaqItem {
	question: string;
	answer: string;
}

interface GeneratedBlogPost {
	slug: string;
	title: string;
	content: string;
	metaDescription?: string;
	faq?: GeneratedFaqItem[];
}

export interface GeminiGatewayConfig {
	accountId?: string;
	gatewayId?: string;
	token?: string;
	/**
	 * Workers AI binding. When `bindingProviders` lists `google-ai-studio` this
	 * carries the gateway request instead of public HTTPS + token. Opt a provider
	 * out through `bindingProviders`, never by unbinding `AI`.
	 */
	binding?: Ai;
	/** `AI_GATEWAY_BINDING_PROVIDERS` — see `@tedix/workers-ai/gateway-transport`. */
	bindingProviders?: string;
}

interface BlogGenerationContext {
	cms: CmsProxyContext;
	geminiApiKey?: string;
	geminiGateway?: GeminiGatewayConfig;
}

/** Blog generation is cost-attributed only when it traverses the authenticated gateway. */
export function requireGeminiGateway(
	gw?: GeminiGatewayConfig,
): AiGatewayTransport {
	const gatewayId = gw?.gatewayId?.trim();
	const transport = gatewayId
		? resolveAiGatewayTransport(
				{
					AI: gw?.binding,
					AI_GATEWAY_ACCOUNT_ID: gw?.accountId,
					CF_AI_GATEWAY_TOKEN: gw?.token,
					AI_GATEWAY_BINDING_PROVIDERS: gw?.bindingProviders,
				},
				gatewayId,
				"google-ai-studio",
			)
		: null;
	if (!transport) {
		throw new Error(
			"AI Gateway is required for Gemini blog generation; configure AI_GATEWAY_ACCOUNT_ID, AI_GATEWAY_ID, and either AI_GATEWAY_BINDING_PROVIDERS (with the AI binding) or CF_AI_GATEWAY_TOKEN.",
		);
	}
	return transport;
}

function geminiUrl(transport: AiGatewayTransport, model: string): string {
	return `${transport.providerRoot}/v1/models/${model}:generateContent`;
}

function geminiHeaders(
	apiKey: string,
	transport: AiGatewayTransport,
): Record<string, string> {
	return {
		"Content-Type": "application/json",
		"x-goog-api-key": apiKey,
		// On the binding transport this is the pre-authenticated sentinel.
		"cf-aig-authorization": `Bearer ${transport.authorization}`,
	};
}

interface PortableSpan {
	_type: "span";
	_key: string;
	text: string;
	marks: string[];
}

type PortableBlock = {
	_type: "block";
	_key: string;
	style: "normal" | "h2" | "h3" | "blockquote";
	children: PortableSpan[];
	markDefs: [];
	listItem?: "bullet" | "number";
	level?: number;
};

const GenerateBlogPostInput = z.object({
	keyword: z.string().min(1).describe("Focus keyword or topic"),
	wordCount: z
		.number()
		.int()
		.min(200)
		.max(8000)
		.default(1200)
		.describe("Target word count"),
	language: z
		.string()
		.min(2)
		.default("en")
		.describe("Language code or language name"),
	market: z.string().min(2).default("global").describe("Target market"),
	competitorContent: z
		.array(
			z.object({
				url: z.string(),
				title: z.string().optional(),
				markdown: z.string(),
			}),
		)
		.default([])
		.describe("Competitor/reference markdown for grounding"),
	contentGenerationInstruction: z
		.string()
		.default("")
		.describe("Brand/editorial instructions for the generated article"),
	collection: z
		.string()
		.default("posts")
		.describe("Target collection when createDraft is true"),
	createDraft: z
		.boolean()
		.default(false)
		.describe("Create a draft content item in Emdash after generation"),
	status: z
		.enum(["draft"])
		.default("draft")
		.describe(
			"Initial status. Emdash creates drafts; publish later with cms_*.content_publish.",
		),
	slug: z
		.string()
		.optional()
		.describe("Override generated slug when creating/returning content"),
	locale: z.string().optional().describe("Locale for the created item"),
	seoTitle: z
		.string()
		.optional()
		.describe("Override generated SEO title when writing Emdash SEO fields"),
	seoDescription: z
		.string()
		.optional()
		.describe(
			"Override generated SEO description when writing Emdash SEO fields",
		),
	canonical: z
		.string()
		.optional()
		.describe("Canonical URL to store in Emdash SEO fields"),
});

type GenerateBlogPostArgs = z.infer<typeof GenerateBlogPostInput>;

export function registerBlogGenerationTool(
	server: McpServer,
	ctx: BlogGenerationContext,
): void {
	server.registerTool(
		"generate_blog_post_ai",
		{
			title: "Generate Blog Post",
			description:
				"Generate a GEO/AEO-oriented blog post with Gemini. Optionally creates a full draft in this tenant CMS and writes native Emdash SEO metadata.",
			inputSchema: schema(GenerateBlogPostInput),
		},
		async (rawArgs: any) => {
			const args = GenerateBlogPostInput.parse(rawArgs);
			if (!ctx.geminiApiKey) {
				return errorResult(
					"GEMINI_API_KEY is not configured on CMS. Add it as a cms Worker secret before using generate_blog_post_ai.",
				);
			}

			try {
				const generated = await generateBlogPost(
					ctx.geminiApiKey,
					args,
					ctx.geminiGateway,
				);
				const slug = args.slug?.trim() ? slugify(args.slug) : generated.slug;
				const seoTitle = args.seoTitle?.trim() || generated.title;
				const seoDescription =
					args.seoDescription?.trim() || generated.metaDescription;

				if (!args.createDraft) {
					return jsonResult({
						...generated,
						slug,
						seo: {
							title: seoTitle,
							description: seoDescription,
							canonical: args.canonical,
						},
					});
				}

				const draftContent = markdownToPortableText(generated.content);
				const createResult = await callCmsRest(ctx.cms, "content_create", {
					collection: args.collection,
					slug,
					status: args.status,
					locale: args.locale,
					data: {
						title: generated.title,
						excerpt: seoDescription,
						content: draftContent.blocks,
					},
				});
				if (createResult.isError) return createResult;

				const created = unwrapCmsToolResult(
					createResult,
					"CMS blog generation",
				);
				const contentId = findContentId(created) ?? slug;
				const updateResult = await callCmsRest(ctx.cms, "content_update", {
					collection: args.collection,
					id: contentId,
					seo: {
						title: seoTitle,
						description: seoDescription,
						canonical: args.canonical,
					},
				});

				if (updateResult.isError) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify(
									{
										ok: false,
										error: "Draft was created, but SEO update failed.",
										createResult: created,
										seoUpdateError: updateResult.content[0]?.text,
										generated: { ...generated, slug },
									},
									null,
									2,
								),
							},
						],
						isError: true as const,
					};
				}

				return jsonResult({
					ok: true,
					org: ctx.cms.orgSlug,
					collection: args.collection,
					id: contentId,
					status: args.status,
					slug,
					seoPersisted: true,
					generated: { ...generated, slug },
					createResult: created,
					seoUpdateResult: unwrapCmsToolResult(
						updateResult,
						"CMS blog generation",
					),
				});
			} catch (err) {
				return errorResult(err instanceof Error ? err.message : String(err));
			}
		},
	);
}

async function generateBlogPost(
	apiKey: string,
	input: GenerateBlogPostArgs,
	gateway?: GeminiGatewayConfig,
): Promise<GeneratedBlogPost> {
	const competitorBlock = input.competitorContent
		.map((c, i) => {
			const head = `### Competitor ${i + 1}: ${c.title ?? c.url}\nSource: ${c.url}\n`;
			return `${head}\n${c.markdown.slice(0, 8000)}`;
		})
		.join("\n\n---\n\n");

	const systemPrompt = [
		input.contentGenerationInstruction || "",
		"",
		"You are an expert technical writer producing long-form, GEO/AEO-optimized blog content.",
		"Output STRICT JSON matching this TypeScript shape (no markdown fences, no commentary):",
		'{ "slug": string, "title": string, "metaDescription": string, "content": string, "faq": Array<{ "question": string, "answer": string }> }',
		"",
		"`content` MUST be valid Markdown of approximately the requested word count.",
		"Use H2 (`## `) section headings only — NO H1 (the title is rendered separately).",
		"Open with a 2-3 sentence summary suitable for AI citation extraction.",
		"End the markdown with a `## FAQ` section containing the same question/answer pairs returned in `faq`.",
		"`faq` MUST contain 4-6 concise, user-search-style questions with direct 1-3 sentence answers.",
		"Cite sources inline where applicable.",
		"`slug` MUST be kebab-case, ASCII, max 80 chars.",
	].join("\n");

	const userPrompt = [
		`Focus keyword: ${input.keyword}`,
		`Target word count: ${input.wordCount}`,
		`Language: ${input.language}`,
		`Market: ${input.market}`,
		"",
		"Competitor reference content (for inspiration only - do not plagiarize):",
		competitorBlock || "(none provided)",
	].join("\n");

	const model = "gemini-2.5-flash";
	const transport = requireGeminiGateway(gateway);
	const resp = await transport.fetch(geminiUrl(transport, model), {
		method: "POST",
		headers: geminiHeaders(apiKey, transport),
		body: JSON.stringify({
			systemInstruction: {
				role: "system",
				parts: [{ text: systemPrompt }],
			},
			contents: [
				{
					role: "user",
					parts: [{ text: userPrompt }],
				},
			],
			generationConfig: {
				temperature: 0.6,
				responseMimeType: "application/json",
				maxOutputTokens: 16000,
			},
		}),
	});

	if (!resp.ok) {
		const text = await resp.text().catch(() => "");
		throw new Error(
			`Gemini ${model} failed (${resp.status}): ${text.slice(0, 300)}`,
		);
	}

	const json = (await resp.json()) as GeminiResponse;
	if (json.error) {
		throw new Error(`Gemini error: ${json.error.message ?? "unknown"}`);
	}

	const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
	if (!text) throw new Error("Gemini returned empty content");

	const parsed = parseGeneratedJson(text);
	const title = parsed.title?.trim() || input.keyword;
	const slug = (parsed.slug?.trim() && slugify(parsed.slug)) || slugify(title);
	const content = parsed.content?.trim() ?? "";
	if (!content) throw new Error("Gemini returned empty `content` field");

	const faq: GeneratedFaqItem[] = Array.isArray(parsed.faq)
		? parsed.faq.flatMap((entry): GeneratedFaqItem[] => {
				const question = entry.question?.trim() ?? "";
				const answer = entry.answer?.trim() ?? "";
				return question && answer ? [{ question, answer }] : [];
			})
		: [];

	return {
		slug,
		title,
		content,
		metaDescription: parsed.metaDescription?.trim(),
		...(faq.length > 0 ? { faq } : {}),
	};
}

function parseGeneratedJson(text: string): {
	slug?: string;
	title?: string;
	content?: string;
	metaDescription?: string;
	faq?: Array<{ question?: string; answer?: string }>;
} {
	try {
		return JSON.parse(text);
	} catch {
		const cleaned = text
			.replace(/^```(?:json)?\s*/i, "")
			.replace(/```\s*$/i, "");
		return JSON.parse(cleaned);
	}
}

function markdownToPortableText(markdown: string): {
	blocks: PortableBlock[];
} {
	const blocks: PortableBlock[] = [];
	let paragraph: string[] = [];

	const pushBlocks = (nextBlocks: PortableBlock[]) => {
		blocks.push(...nextBlocks);
	};

	const flushParagraph = () => {
		const text = paragraph.join(" ").trim();
		paragraph = [];
		if (text) pushBlocks(createTextBlocks(text, "normal"));
	};

	for (const rawLine of markdown.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) {
			flushParagraph();
			continue;
		}

		const h2 = /^##\s+(.+)$/.exec(line);
		if (h2) {
			flushParagraph();
			pushBlocks([createBlock(h2[1]!, "h2")]);
			continue;
		}

		const h3 = /^###\s+(.+)$/.exec(line);
		if (h3) {
			flushParagraph();
			pushBlocks([createBlock(h3[1]!, "h3")]);
			continue;
		}

		const bullet = /^[-*]\s+(.+)$/.exec(line);
		if (bullet) {
			flushParagraph();
			pushBlocks(createTextBlocks(bullet[1]!, "normal", "bullet"));
			continue;
		}

		const numbered = /^\d+\.\s+(.+)$/.exec(line);
		if (numbered) {
			flushParagraph();
			pushBlocks(createTextBlocks(numbered[1]!, "normal", "number"));
			continue;
		}

		const quote = /^>\s+(.+)$/.exec(line);
		if (quote) {
			flushParagraph();
			pushBlocks(createTextBlocks(quote[1]!, "blockquote"));
			continue;
		}

		paragraph.push(line);
	}

	flushParagraph();
	return { blocks };
}

function createTextBlocks(
	text: string,
	style: PortableBlock["style"],
	listItem?: PortableBlock["listItem"],
): PortableBlock[] {
	return chunkBlockText(stripInlineMarkdown(text)).map((chunk) =>
		createBlock(chunk, style, listItem),
	);
}

function createBlock(
	text: string,
	style: PortableBlock["style"],
	listItem?: PortableBlock["listItem"],
): PortableBlock {
	return {
		_type: "block",
		_key: key("b"),
		style,
		children: [
			{
				_type: "span",
				_key: key("s"),
				text,
				marks: [],
			},
		],
		markDefs: [],
		...(listItem ? { listItem, level: 1 } : {}),
	};
}

function chunkBlockText(text: string): string[] {
	const chunks: string[] = [];
	let current = "";
	for (const word of text.split(/(\s+)/)) {
		if (current.length + word.length > 180) {
			if (current) chunks.push(current);
			current = word.length > 180 ? "" : word;
			if (word.length > 180) {
				for (let i = 0; i < word.length; i += 180) {
					chunks.push(word.slice(i, i + 180));
				}
			}
			continue;
		}
		current += word;
	}
	if (current) chunks.push(current);

	return chunks.length > 0 ? chunks : [""];
}

function stripInlineMarkdown(text: string): string {
	return text
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/__([^_]+)__/g, "$1")
		.replace(/\*([^*]+)\*/g, "$1")
		.replace(/_([^_]+)_/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/`([^`]+)`/g, "$1");
}

function slugify(input: string): string {
	return input
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
}

function key(prefix: string): string {
	return `${prefix}${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

function findContentId(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	for (const keyName of ["id", "contentId"]) {
		const candidate = record[keyName];
		if (typeof candidate === "string" && candidate.length > 0) return candidate;
	}
	for (const keyName of ["data", "item", "content"]) {
		const nested = findContentId(record[keyName]);
		if (nested) return nested;
	}
	return undefined;
}

function jsonResult(value: unknown): ToolResult {
	return {
		content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
	};
}

function errorResult(message: string): ToolResult {
	return {
		content: [{ type: "text", text: `[ERROR] ${message}` }],
		isError: true,
	};
}
