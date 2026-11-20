import type { SetupAction, SetupState } from "./setup";
import type { Status } from "./status";

/** What the main process sends the This Mac and Set up this Mac windows. */
export interface PanelState {
	status: Status;
	setup: SetupState;
	summary: string;
	lastOutput: string;
	busy: boolean;
	/** Undefined when the app runs unpackaged, where the switch is hidden. */
	openAtLogin?: boolean;
}

/** `setup-window` opens the Set up this Mac window; `close-setup` closes it and shows Tedix. */
export type PanelAction = "restart" | "setup-window" | "close-setup";
export type RunnerField = "enabled" | "machineName" | "machineWriteMode";
/** The pages the chat-app rows may open in the browser. */
export type PanelLink = "claude-connectors";

/** The only functions the app's own two windows can call; the Tedix OS page gets none. */
export interface PanelApi {
	state(): Promise<PanelState>;
	set(
		index: number,
		key: RunnerField,
		value: string | boolean | undefined,
	): Promise<void>;
	action(name: PanelAction): Promise<void>;
	/** One button of the setup checklist; `id` names the coding tool or step. */
	setup(action: SetupAction, id?: string): Promise<void>;
	copy(text: string): Promise<void>;
	open(link: PanelLink): Promise<void>;
	openAtLogin(on: boolean): Promise<void>;
	onState(listener: (state: PanelState) => void): void;
}
