import { runLaneActivity } from "./dispatcher-lane-health-checks";

// Task activity rows on /work/capacity, dark theme, at phone, medium and
// desktop widths. dispatcher-lane-health.spec.ts covers the lane states.
await runLaneActivity("dark");
