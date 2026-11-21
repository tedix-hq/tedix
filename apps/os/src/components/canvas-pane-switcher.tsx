import "./canvas-pane-switcher.css";
import { SegmentedControl } from "@/components/kumo/segmented-control";
import type { CanvasMobilePane } from "@/lib/canvas-search";

/**
 * The phone's bottom tabs: always Chat and Files. Files holds the workspace's
 * list and whatever opens from it (a file, an app, the Overview, Work or
 * Agents), so no tab comes and goes with what is open.
 */
export type CanvasPhoneTab = "chat" | "files";

export function canvasPhoneTab(pane: CanvasMobilePane): CanvasPhoneTab {
	return pane === "chat" ? "chat" : "files";
}

/** "Chat (2)" when something is unread, the plain label otherwise. */
function countedLabel(label: string, count: number | undefined): string {
	return count ? `${label} (${count > 99 ? "99+" : count})` : label;
}

export function CanvasPaneSwitcher({
	tab,
	onChange,
	unreadChat,
	unreadFiles,
}: {
	tab: CanvasPhoneTab;
	onChange: (tab: CanvasPhoneTab) => void;
	unreadChat?: number;
	unreadFiles?: number;
}) {
	return (
		<SegmentedControl
			ariaLabel="Workspace pane"
			className="canvas-pane-switcher"
			compact
			fill
			onValueChange={onChange}
			options={[
				{ value: "chat", label: countedLabel("Chat", unreadChat) },
				{ value: "files", label: countedLabel("Files", unreadFiles) },
			]}
			value={tab}
		/>
	);
}
