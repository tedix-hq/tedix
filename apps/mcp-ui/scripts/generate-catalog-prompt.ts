/**
 * Generate the layout catalog prompt for AI-assisted layout generation.
 *
 * Outputs both JSONL (legacy) and YAML (preferred) system prompts
 * to packages/api-contract/src/generated/layout-catalog-prompt.ts.
 *
 * Run: cd apps/mcp-ui && bun run generate:catalog-prompt
 */

import { writeFileSync } from "node:fs";
import { tedixCatalog, getTediJsonSchema } from "../src/json-render/catalog";
import { yamlPrompt } from "@json-render/yaml";

const decisionGuidance =
	'\nDecision views: use DecisionCard with ASK, IF YES, WHY and optional STAKES from source copy; DraftPreview shows the complete draft. Repeat cards in SwipeStack or Stack; put OptionList and spec-declared ActionButtons in each card. Critical actions link to the OS for step-up. For call_tool, optional textPath/textArgumentPath bind required user input and statusPath provides optimistic save/rollback. toolPrefix comes from /ui/toolPrefix for sibling tool calls in aggregate hosts. In action params a direct $item expression resolves to a state path; to pass its value use { $cond: true, $then: { $item: "field" }, $else: null }. Never infer consent from provenance.\n';
const jsonlPrompt = tedixCatalog.prompt() + decisionGuidance;
const yamlPrt =
	yamlPrompt(tedixCatalog, {
		mode: "standalone",
		editModes: ["merge", "patch", "diff"],
	}) + decisionGuidance;
const components = tedixCatalog.componentNames;
const actions = tedixCatalog.actionNames;
const jsonSchema = getTediJsonSchema();

const ts = `/**
 * AUTO-GENERATED — do not edit manually.
 * Regenerate: cd apps/mcp-ui && bun run generate:catalog-prompt
 */

export const LAYOUT_CATALOG_PROMPT = ${JSON.stringify(jsonlPrompt)};
export const LAYOUT_CATALOG_YAML_PROMPT = ${JSON.stringify(yamlPrt)};
export const LAYOUT_CATALOG_COMPONENT_COUNT = ${components.length};
export const LAYOUT_CATALOG_COMPONENTS = ${JSON.stringify(components)} as const;
export const LAYOUT_CATALOG_ACTIONS = ${JSON.stringify(actions)} as const;
export const LAYOUT_CATALOG_JSON_SCHEMA = ${JSON.stringify(jsonSchema)} as const;
`;

const outPath =
	"../../packages/api-contract/src/generated/layout-catalog-prompt.ts";
writeFileSync(outPath, ts);
console.log(
	`Generated catalog prompt (JSONL: ${jsonlPrompt.length} chars, YAML: ${yamlPrt.length} chars, ${components.length} components)`,
);
