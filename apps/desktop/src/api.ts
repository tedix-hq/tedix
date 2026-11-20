import type { Status } from "./status";

/** What the main process sends the status strip and the This Mac panel. */
export interface PanelState {
	status: Status;
	summary: string;
	lastOutput: string;
	busy: boolean;
	/** The host of the page the Tedix OS view shows. */
	host: string;
	/** Undefined when the app runs unpackaged, where the switch is hidden. */
	openAtLogin?: boolean;
}

export type PanelAction =
	| "login"
	| "update"
	| "restart"
	| "open-panel"
	| "back"
	| "forward"
	| "reload";
export type RunnerField = "enabled" | "machineName" | "machineWriteMode";

/** The only functions the two local pages can call; the Tedix OS page gets none. */
export interface PanelApi {
	state(): Promise<PanelState>;
	set(
		index: number,
		key: RunnerField,
		value: string | boolean | undefined,
	): Promise<void>;
	action(name: PanelAction): Promise<void>;
	openAtLogin(on: boolean): Promise<void>;
	onState(listener: (state: PanelState) => void): void;
}
