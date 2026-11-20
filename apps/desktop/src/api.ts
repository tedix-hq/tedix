import type { Status } from "./status";

/** What the main process sends the This Mac window. */
export interface PanelState {
	status: Status;
	summary: string;
	lastOutput: string;
	busy: boolean;
	/** Undefined when the app runs unpackaged, where the switch is hidden. */
	openAtLogin?: boolean;
}

export type PanelAction = "login" | "update" | "restart";
export type RunnerField = "enabled" | "machineName" | "machineWriteMode";

/** The only functions the This Mac window can call; the Tedix OS page gets none. */
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
