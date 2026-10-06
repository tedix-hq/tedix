import {
	AppWindow,
	Blueprint,
	Brain,
	ChartLineUp,
	ChatCenteredText,
	CirclesThreePlus,
	DownloadSimple,
	Files,
	Lightning,
	Pulse,
	ShieldCheck,
	SquaresFour,
} from "@phosphor-icons/react";
import type { ComponentType } from "react";
import type { OsSurfaceId } from "@/lib/os-navigation";

export const SURFACE_ICONS: Record<
	OsSurfaceId,
	ComponentType<{ size?: number; strokeWidth?: number }>
> = {
	work: Pulse,
	chat: ChatCenteredText,
	workspaces: SquaresFour,
	blueprints: Blueprint,
	outputs: Files,
	team: CirclesThreePlus,
	skills: Lightning,
	gateways: AppWindow,
	sites: Files,
	brain: Brain,
	audit: ShieldCheck,
	widget: ChatCenteredText,
	compute: ChartLineUp,
	install: DownloadSimple,
};
