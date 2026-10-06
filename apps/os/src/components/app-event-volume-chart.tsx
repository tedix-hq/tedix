import * as echarts from "echarts";
import { useMemo } from "react";
import {
	Chart,
	ChartPalette,
	type KumoChartOption,
} from "@/components/kumo/event-chart";
import { useTheme } from "@/hooks/use-theme";

type EventVolumeBucket = {
	bucket: string;
	successEvents: number;
	failedEvents: number;
};

/**
 * Intentionally loaded behind the analytics route boundary: ECharts is useful
 * for trend reading, but it must not become part of the initial OS shell.
 * The adjacent table remains the accessible exact-value view.
 */
export function EventVolumeChart({
	buckets,
}: {
	buckets: readonly EventVolumeBucket[];
}) {
	const { theme } = useTheme();
	const isDarkMode = theme === "dark";
	const options = useMemo<KumoChartOption>(() => {
		const success = ChartPalette.semantic("Success", isDarkMode);
		const failed = ChartPalette.semantic("Attention", isDarkMode);
		const text = ChartPalette.text("primary", isDarkMode);

		return {
			aria: {
				enabled: true,
				description: "Daily successful and failed event volume",
			},
			animationDuration: 180,
			grid: { left: 16, right: 16, top: 24, bottom: 28, containLabel: true },
			legend: { top: 0, right: 0, itemWidth: 9, itemHeight: 9 },
			tooltip: { trigger: "axis" },
			xAxis: {
				type: "category",
				boundaryGap: false,
				data: buckets.map((bucket) => bucket.bucket.slice(5)),
				axisLabel: { color: text, fontSize: 11 },
			},
			yAxis: {
				type: "value",
				minInterval: 1,
				axisLabel: { color: text, fontSize: 11 },
			},
			series: [
				{
					name: "Success",
					type: "line",
					smooth: true,
					symbol: "none",
					lineStyle: { width: 2, color: success },
					areaStyle: { color: success, opacity: 0.14 },
					data: buckets.map((bucket) => bucket.successEvents),
				},
				{
					name: "Failed",
					type: "line",
					smooth: true,
					symbol: "none",
					lineStyle: { width: 2, color: failed },
					areaStyle: { color: failed, opacity: 0.1 },
					data: buckets.map((bucket) => bucket.failedEvents),
				},
			],
		};
	}, [buckets, isDarkMode]);

	return (
		<Chart
			echarts={echarts}
			options={options}
			height={240}
			isDarkMode={isDarkMode}
		/>
	);
}
