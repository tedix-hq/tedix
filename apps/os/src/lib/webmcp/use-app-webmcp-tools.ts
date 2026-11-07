import { useEffect, useLayoutEffect, useRef } from "react";
import type { WebMcpToolDef } from "@tedix/webmcp-core/model-context";
import {
	type PageChatToolExtras,
	registerPageChatTools,
} from "@/lib/page-chat-tools";
import { useWebMcpTools } from "./use-webmcp-tools";

/**
 * Register a first-party workspace app's WebMCP tools while the app is on
 * screen. Call it from the app component: the workbench mounts that component
 * only while the app is the selected workpiece in its preview view, so the
 * tools appear when the app opens and are unregistered when it closes.
 *
 * `controller` is the app's live UI state and the same callbacks its buttons
 * call. Tools read it through `current()` at execute time, so an agent's
 * action drives the screen the human is watching, and state changes never
 * re-register the scope. `deps` lists only what changes the tool SHAPE (for
 * example an enum of filter values), following the useEffect contract.
 *
 * Tool names start with the app's snake_case id (`card_review_next_card`),
 * which keeps them unique beside the route scopes.
 *
 * `pageChat` also offers the same tools to the quick chat on this page, with
 * the chat's extras per tool (inline confirm, activity wording, undo). Only
 * apps that pass it are offered; the chat never sees the rest.
 */
export function useAppWebMcpTools<Controller>(
	appId: string,
	controller: Controller,
	build: (current: () => Controller) => WebMcpToolDef[],
	deps: readonly unknown[],
	options: {
		pageChat?: (
			current: () => Controller,
		) => Record<string, PageChatToolExtras>;
	} = {},
): void {
	const ref = useRef(controller);
	useLayoutEffect(() => {
		ref.current = controller;
	});
	useWebMcpTools(`app:${appId}`, () => build(() => ref.current), deps);
	const pageChat = options.pageChat;
	useEffect(() => {
		if (!pageChat) return;
		const current = () => ref.current;
		const extras = pageChat(current);
		return registerPageChatTools(
			`app:${appId}`,
			build(current).map((tool) => ({ ...tool, ...extras[tool.name] })),
		);
		// The builders are deliberately not dependencies: `deps` names their inputs.
	}, [appId, Boolean(pageChat), ...deps]);
}
