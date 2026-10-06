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

const jsonlPrompt = tedixCatalog.prompt();
const yamlPrt = yamlPrompt(tedixCatalog, {
	mode: "standalone",
	editModes: ["merge", "patch", "diff"],
});
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
