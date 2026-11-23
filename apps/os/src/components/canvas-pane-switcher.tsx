import "./canvas-pane-switcher.css";
import { ChatCircle, Folder } from "@phosphor-icons/react";
import { SegmentedControl } from "@/components/kumo/segmented-control";
import { TabBarContent } from "@/components/tab-bar-content";
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
			className="canvas-pane-switcher tab-bar"
			compact
			fill
			tabBar
			onValueChange={onChange}
			options={[
				{
					value: "chat",
					label: (
						<TabBarContent
							icon={
								<ChatCircle
									size={24}
									weight={tab === "chat" ? "fill" : "regular"}
								/>
							}
							label="Chat"
							count={unreadChat || null}
						/>
					),
				},
				{
					value: "files",
					label: (
						<TabBarContent
							icon={
								<Folder
									size={24}
									weight={tab === "files" ? "fill" : "regular"}
								/>
							}
							label="Files"
							count={unreadFiles || null}
						/>
					),
				},
			]}
			value={tab}
		/>
	);
}
