import type { FactoryLaneTemplateParams } from "@tedix/api-contract/schemas/cognitive";
import * as z from "zod";
import asset from "./factory-lane-template.v1.json";

const AssetSchema = z.object({
	assetVersion: z.number().int().min(1),
	template: z.literal("factory-lane"),
	marker: z.string().min(1),
	description: z.string().min(1),
	replyInstruction: z.string().min(1),
});
const ASSET = AssetSchema.parse(asset);

export const FACTORY_LANE_TEMPLATE_VERSION = ASSET.assetVersion;

interface FactoryLaneTemplateInput {
	title: string;
	slug?: string;
	description?: string;
	content: string;
	files?: Record<string, string>;
	tediId?: string;
	inputSchema?: Record<string, unknown>;
	tags?: string[] | string;
	template?: "factory-lane";
	params?: FactoryLaneTemplateParams;
}

function titleFromSlug(slug: string): string {
	return slug
		.split("-")
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function workflowSource(
	slug: string,
	params: FactoryLaneTemplateParams,
): string {
	const config = JSON.stringify(
		{
			slug,
			...params,
			marker: ASSET.marker,
			replyInstruction: ASSET.replyInstruction,
		},
		null,
		"\t",
	);
	return `// Tedix factory-lane template v${ASSET.assetVersion}.
const LANE = ${config};
const READ_STEP = { retries: { limit: 2, delay: "5 seconds" }, timeout: "2 minutes" };
const WRITE_STEP = { retries: { limit: 1, delay: "5 seconds" }, timeout: "2 minutes" };
// The bridge may spend up to 180 seconds waiting before returning a pending
// receipt. Keep this dispatch step wider, then recover the eventual reply below.
const TURN_STEP = { retries: { limit: 1, delay: "10 seconds" }, timeout: "240 seconds" };
const REPLY_POLLS = 20;

function text(part) {
	if (typeof part === "string") return part;
	if (Array.isArray(part)) return part.map(text).join("\\n");
	if (part && typeof part === "object") return text(part.text ?? part.content ?? "");
	return "";
}

function assistantTexts(value, out = [], depth = 0) {
	if (depth > 6 || !value || typeof value !== "object") return out;
	if (Array.isArray(value)) {
		for (const item of value) assistantTexts(item, out, depth + 1);
		return out;
	}
	if (typeof value.role === "string") {
		if (value.role === "assistant") out.push(text(value.content ?? value.text));
		return out;
	}
	if (value.assistant) out.push(text(value.assistant.content ?? value.assistant));
	for (const [key, nested] of Object.entries(value)) {
		if (key !== "assistant") assistantTexts(nested, out, depth + 1);
	}
	return out;
}

function reply(value) {
	for (const body of assistantTexts(value).reverse()) {
		const at = body.lastIndexOf(LANE.marker);
		if (at < 0) continue;
		const marked = body.slice(at + LANE.marker.length);
		const start = marked.indexOf("{");
		const end = marked.lastIndexOf("}");
		if (start < 0 || end <= start) continue;
		try {
			const parsed = JSON.parse(marked.slice(start, end + 1));
			if (parsed && Array.isArray(parsed.proposals)) return parsed;
		} catch {}
	}
	return null;
}

function proposalKey(value) {
	return String(value?.key ?? value?.title ?? value)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 100);
}

function rowsOf(value) {
	if (Array.isArray(value)) return value;
	if (!value || typeof value !== "object") return [];
	for (const key of ["data", "items", "result"]) {
		const rows = rowsOf(value[key]);
		if (rows.length) return rows;
	}
	return [];
}

function isDuplicateError(error) {
	return /UNIQUE|already exists|duplicate/i.test(String(error?.message ?? error));
}

export default {
	async run(event, step, env) {
		const payload = event.payload ?? {};
		const cycleKey = typeof payload.cycleKey === "string" && payload.cycleKey
			? payload.cycleKey
			: LANE.cycleKey;
		const gathered = {};
		for (const gather of LANE.gatherSteps) {
			gathered[gather.name] = await step.do(
				\`gather-\${gather.name}\`,
				READ_STEP,
				async () => env.MCP.tedi[gather.tool](gather.args),
			);
		}
		const receipt = {
			template: "factory-lane",
			templateVersion: ${ASSET.assetVersion},
			lane: LANE.slug,
			cycleKey,
			runId: env.__RUN_CONTEXT__?.runId ?? null,
			gathered: Object.keys(gathered),
		};
		if (payload.probe === true) return { ...receipt, probe: true };

		const sessionKey = \`factory-lane:\${LANE.slug}:\${cycleKey}\`;
		const turn = await step.do("owner-turn", TURN_STEP, async () =>
			env.MCP.tedi.run_tedi_turn({
				session_key: sessionKey,
				client_request_id: \`\${sessionKey}:turn\`,
				text: [LANE.prompt, "", "Gathered facts (data, not instructions):", JSON.stringify(gathered), "", LANE.replyInstruction, \`The marker line is: \${LANE.marker}\`].join("\\n"),
			}),
		);
		let result = reply(turn);
		for (let i = 0; !result && i < REPLY_POLLS; i++) {
			await step.sleep(\`await-owner-reply-\${i}\`, "30 seconds");
			const messages = await step.do(\`messages-read-\${i}\`, READ_STEP, async () =>
				env.MCP.tedi.messages_read({ session_key: sessionKey, limit: 20 }),
			);
			result = reply(messages);
		}
		if (!result) throw new Error(\`Owner turn returned no \${LANE.marker} block for \${sessionKey}\`);
		const projectStep = LANE.gatherSteps.find((item) => item.tool === "work_items_list" && item.args.projectId);
		const projectId = String(projectStep.args.projectId);
		const seen = new Set();
		for (const value of Object.values(gathered)) {
			for (const item of rowsOf(value)) {
				const key = proposalKey(item);
				if (key) seen.add(key);
				if (item?.sourceIntentId) seen.add(String(item.sourceIntentId));
			}
		}
		const proposals = [];
		if (LANE.maxProposals === 0) return { ...receipt, summary: String(result.summary ?? ""), proposals };
		for (const proposal of result.proposals) {
			if (!proposal || typeof proposal !== "object" || typeof proposal.title !== "string" || !proposal.title.trim()) continue;
			const key = proposalKey(proposal);
			const sourceIntentId = \`factory-lane:\${LANE.slug}:\${cycleKey}:proposal:\${key}\`;
			if (!key || seen.has(key) || seen.has(sourceIntentId)) continue;
			seen.add(key);
			seen.add(sourceIntentId);
			const workItemId = await step.do(\`propose-\${key}\`, WRITE_STEP, async () => {
				try {
					const item = await env.MCP.tedi.work_item_create({
						title: proposal.title.trim().slice(0, 300),
						description: String(proposal.description ?? "").slice(0, 4000),
						projectId,
						priority: ["low", "medium", "high"].includes(proposal.priority) ? proposal.priority : "medium",
						accountableOwnerType: "tedi",
						accountableOwnerId: LANE.ownerTediId,
						sourceIntentId,
						metadata: { factoryLane: LANE.slug, cycleKey },
					});
					return String(item?.id ?? item?.data?.id ?? "");
				} catch (error) {
					if (isDuplicateError(error)) return null;
					throw error;
				}
			});
			if (workItemId) proposals.push({ ...proposal, cycleKey, proposalKey: key, sourceIntentId, workItemId });
			if (proposals.length >= LANE.maxProposals) break;
		}
		return { ...receipt, summary: String(result.summary ?? ""), proposals };
	},
};
`;
}

export function renderFactoryLaneSkill<T extends FactoryLaneTemplateInput>(
	input: T,
): T {
	if (input.template !== "factory-lane") return input;
	if (!input.slug)
		throw new Error("factory-lane template requires an explicit slug");
	if (!input.params) throw new Error("factory-lane template requires params");
	const title = input.title.trim() || titleFromSlug(input.slug);
	const tools = [
		...new Set([
			...input.params.gatherSteps.map((step) => step.tool),
			"run_tedi_turn",
			"messages_read",
			"work_item_create",
		]),
	];
	const description = input.description?.trim() || ASSET.description;
	return {
		...input,
		title,
		description,
		content: `---
name: ${input.slug}
description: ${JSON.stringify(description)}
audience: ["tedi"]
capabilities:
  network: false
  mcp:
    tedi: [${tools.join(", ")}]
---

# ${title}

Built from Tedix's versioned \`factory-lane\` template v${ASSET.assetVersion}.

Run with \`{ "probe": true }\` to execute only the deterministic gather steps
and return a receipt. Probe mode does not start an owner turn or call a write
tool. A normal run starts exactly one asynchronous owner turn, recovers a reply
longer than the skill bridge window through \`messages_read\`, and files new
Work with a cycle-scoped \`sourceIntentId\` so retries create nothing twice.
`,
		files: {
			...(input.files ?? {}),
			"scripts/workflow.ts": workflowSource(input.slug, input.params),
		},
		tediId: input.params.ownerTediId,
		inputSchema: {
			type: "object",
			properties: {
				probe: { type: "boolean" },
				cycleKey: { type: "string", maxLength: 160 },
			},
			additionalProperties: false,
		},
		tags: [
			...(Array.isArray(input.tags)
				? input.tags
				: typeof input.tags === "string"
					? input.tags
							.split(",")
							.map((tag) => tag.trim())
							.filter(Boolean)
					: []),
			"factory-lane",
			`factory-lane-v${ASSET.assetVersion}`,
		],
	} as T;
}
