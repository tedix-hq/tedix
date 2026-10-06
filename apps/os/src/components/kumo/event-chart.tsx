// This event-volume chart boundary keeps analytics code independent from the
// upstream Kumo package while leaving OS's richer chart adapter local.
export {
	Chart,
	ChartPalette,
	type KumoChartOption,
} from "@cloudflare/kumo/components/chart";
