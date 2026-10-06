import {
	type GadgetWidgetTarget,
	widgetTargetFromResourceUri,
} from "@/lib/gadget-widget-target";
import { isRecord } from "@tedix/api-contract/utils/is-record";

export type ChatWidgetTarget = GadgetWidgetTarget & {
	toolInput?: Record<string, unknown>;
	toolResult?: Record<string, unknown>;
};

/** A transcript turn may surface a small, intentional stack of MCP Apps. */
export const MAX_CHAT_WIDGETS_PER_MESSAGE = 3;

const MAX_METADATA_DEPTH = 6;

/**
 * Locate MCP Apps resource references in durable assistant-message metadata.
 *
 * The kernel does not retain every transient tool-progress payload, so the
 * transcript only trusts a resource URI explicitly carried into durable
 * metadata. URI validation is shared with the canvas gadget host and the walk
 * is bounded to keep arbitrary response metadata from expanding the render.
 */
export function chatWidgetTargetsFromMetadata(
	metadata: unknown,
): ChatWidgetTarget[] {
	const targets: ChatWidgetTarget[] = [];
	const seenObjects = new WeakSet<object>();
	const seenUris = new Set<string>();

	const visit = (value: unknown, depth: number): void => {
		if (
			depth > MAX_METADATA_DEPTH ||
			targets.length >= MAX_CHAT_WIDGETS_PER_MESSAGE
		) {
			return;
		}
		if (Array.isArray(value)) {
			for (const item of value) visit(item, depth + 1);
			return;
		}
		if (!isRecord(value)) return;
		if (seenObjects.has(value)) return;
		seenObjects.add(value);

		const target = widgetTargetFromResourceUri(value.resourceUri);
		// PROVENANCE. `widgetTargetFromResourceUri` validates the URI's SHAPE and
		// places no constraint on WHICH app slug appears, so a tool result could
		// declare `ui://widgets/mcp-app/<any-app>/…` and summon that app's UI into
		// a turn where only some other tool ran. The kernel stamps the app whose
		// tool actually produced the result (`producedByAppSlug`, derived from the
		// tool NAME, not the payload), so a disagreement is refused here.
		//
		// Absent stamp means provenance is UNKNOWN, not "mismatched": the walk
		// deliberately finds three metadata shapes, only one of which the kernel
		// produces, and rejecting the unstamped ones would break legitimate
		// rendering that predates this field.
		const declaredProducer =
			typeof value.producedByAppSlug === "string"
				? value.producedByAppSlug
				: null;
		if (target && declaredProducer && declaredProducer !== target.appSlug) {
			// Do not rediscover the rejected target inside its own toolResult.
			return;
		}
		if (target && !seenUris.has(target.resourceUri)) {
			seenUris.add(target.resourceUri);
			targets.push({
				...target,
				...(isRecord(value.toolInput) ? { toolInput: value.toolInput } : {}),
				...(isRecord(value.toolResult) ? { toolResult: value.toolResult } : {}),
			});
		}

		for (const nested of Object.values(value)) visit(nested, depth + 1);
	};

	visit(metadata, 0);
	return targets;
}
