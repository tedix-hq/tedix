/**
 * ink rendering layer for the live activity panel.
 *
 * Consumes RunState data (from live-panel.ts) and renders it via ink <Text>
 * components. All data-fetching / state logic stays in live-panel.ts; this
 * file is presentation-only.
 */

import {
	Box,
	Text,
	useBoxMetrics,
	useIsScreenReaderEnabled,
	useWindowSize,
	type DOMElement,
} from "ink";
import { stripVTControlCharacters } from "node:util";
import { useRef } from "react";
import {
	type ActivityDisplayMode,
	FRAMES,
	type RunState,
	renderChildPanelRow,
	renderPanelRow,
	isActivityNoise,
} from "./live-panel";

interface LivePanelProps {
	states: RunState[];
	frameIndex: number;
	now: number;
	activityMode: ActivityDisplayMode;
}

/**
 * Renders a single activity row as an ink Text element.
 * Pure render — data comes from renderPanelRow which is the same pure
 * function used by snapshot()/tests in live-panel.ts.
 *
 * Passes the current terminal width so cost (elapsed · tokens) is
 * right-aligned to the actual column count.
 */
function PanelRow({
	state,
	frameIndex,
	now,
	columns,
}: {
	state: RunState;
	frameIndex: number;
	now: number;
	columns: number;
}) {
	// Lay out to one column short of the edge: a line padded to exactly `columns`
	// auto-wraps at the last column, which desyncs ink's dynamic-region line count
	// from the terminal and leaks frames into scrollback on resize. wrap="truncate"
	// hard-caps it so each row is always exactly one visual line.
	const text = renderPanelRow(state, frameIndex, now, columns, {
		enabled: true,
	});
	return <Text wrap="truncate">{text}</Text>;
}

/**
 * Renders the full live activity panel (header + one row per in-flight run).
 * Displayed in the dynamic (re-rendered) area below the Static transcript.
 */
export function InkLivePanel({
	states,
	frameIndex,
	now,
	activityMode,
}: LivePanelProps) {
	const ref = useRef<DOMElement>(null);
	const isScreenReaderEnabled = useIsScreenReaderEnabled();
	const { clientWidth, hasMeasured } = useBoxMetrics(ref);
	const { columns: windowColumns } = useWindowSize();
	const columns = Math.max(1, (hasMeasured ? clientWidth : windowColumns) - 1);
	if (states.length === 0) return null;
	if (isScreenReaderEnabled) {
		return (
			<Box flexDirection="column">
				<Text>Run activity</Text>
				{states.map((state) => (
					<Text key={state.entry.homeRunId}>
						{semanticRunActivity(state, activityMode)}
					</Text>
				))}
			</Box>
		);
	}
	// No "tedix [N running]" header — the running count already lives in the
	// run state and the rows (spinner · target · activity · elapsed) are
	// self-describing. Keeps the live area tight, Codex/Claude-Code style.
	return (
		<Box ref={ref} flexDirection="column" width="100%">
			{states.map((state) => {
				const isFailure = (value: string) =>
					/(failed|error|approval|unauthorized)/i.test(value);
				const activities =
					activityMode === "full"
						? (state.activities ?? []).slice(-5)
						: activityMode === "errors"
							? (state.activities ?? []).filter(isFailure).slice(-5)
							: (state.activities ?? []).slice(-1);
				const children =
					activityMode === "errors"
						? (state.children ?? []).filter((child) => isFailure(child.status))
						: (state.children ?? []);
				return (
					<Box key={state.entry.homeRunId} flexDirection="column">
						<PanelRow
							state={state}
							frameIndex={frameIndex}
							now={now}
							columns={columns}
						/>
						{children.map((child) => (
							<Text key={child.id} wrap="truncate">
								{renderChildPanelRow(child, frameIndex)}
							</Text>
						))}
						{activities.map((activity, index) => (
							<Text
								key={`${index}-${activity}`}
								wrap="truncate"
								dimColor
							>{`      · ${activity}`}</Text>
						))}
						{state.answerStream ? (
							<Text
								wrap="truncate"
								dimColor
							>{`      ${state.answerStream}`}</Text>
						) : null}
					</Box>
				);
			})}
		</Box>
	);
}

/** No frame, clock, cost, clipping, or partial answer in semantic announcements. */
function semanticRunActivity(
	state: RunState,
	mode: ActivityDisplayMode,
): string {
	const clean = (value: string) => stripVTControlCharacters(value).trim();
	const status = (value: string) => clean(value).replaceAll("_", " ");
	const summary = state.summary;
	const lines = [
		`Run ${clean(state.entry.label)}: ${status(summary?.status ?? "running")}.`,
	];
	if (summary?.targetTediLabel)
		lines.push(`Worker: ${clean(summary.targetTediLabel)}.`);
	const isFailure = (value: string) =>
		/(failed|error|approval|unauthorized)/i.test(value);
	const progress = summary?.progressDetail ?? summary?.progressLabel;
	const activities = (state.activities ?? []).filter(
		(value) => !isActivityNoise(clean(value)),
	);
	const visibleActivities =
		mode === "full"
			? activities.slice(-5)
			: mode === "errors"
				? activities.filter(isFailure).slice(-5)
				: [...activities.filter(isFailure).slice(-5), ...activities.slice(-1)];
	const details = new Set<string>();
	if (
		progress &&
		!isActivityNoise(clean(progress)) &&
		(mode !== "errors" || isFailure(progress))
	)
		details.add(clean(progress));
	for (const activity of visibleActivities) details.add(clean(activity));
	for (const detail of details) if (detail) lines.push(`Activity: ${detail}`);
	if (state.childTotal !== undefined && state.childTotal > 0) {
		lines.push(
			`Child runs: ${state.childDone ?? 0} of ${state.childTotal} completed; ${state.childFailed ?? 0} failed.`,
		);
	}
	for (const child of state.children ?? []) {
		if (mode === "errors" && !isFailure(child.status)) continue;
		lines.push(
			`Child ${clean(child.label)}: ${status(child.status)}.${
				child.objective ? ` Objective: ${clean(child.objective)}` : ""
			}`,
		);
	}
	if (state.answerStream) lines.push("Answer is streaming.");
	return lines.join("\n");
}

/** Spinner frame index advanced by the bridge's active-state ticker. */
export function nextFrameIndex(current: number): number {
	return (current + 1) % FRAMES.length;
}
