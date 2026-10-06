/**
 * Layout System Exports
 *
 * Pruned to the live surface: ComparisonLayout is the only layout with real
 * consumers (apps/mcp-ui json-render and apps/landing ChatGPTDemo). The other
 * vertical layouts and the config-driven LayoutRenderer were removed with the
 * widget-ui audit remediation; recover them from git history if a vertical
 * ships again.
 */

export type {
	ComparisonLayoutProps,
	ComparisonVertical,
	ComparisonWidgetState,
	ListingGroup,
} from "./ComparisonLayout";
// Comparison Layout (price comparison)
export { ComparisonLayout } from "./ComparisonLayout";
export type { LayoutItemSchemaType as LayoutItem } from "@tedix/api-contract/schemas/layout";
