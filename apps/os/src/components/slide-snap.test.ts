import { describe, expect, it } from "vite-plus/test";
import { applySnap, computeSnapTargets } from "./slide-snap";

const targets = computeSnapTargets(
	[{ x: 100, y: 200, width: 300, height: 100 }],
	1200,
	675,
);

describe("slide snapping", () => {
	it("targets the slide's edges and center and each other element's", () => {
		expect(targets.verts).toEqual([0, 600, 1200, 100, 250, 400]);
		expect(targets.horiz).toEqual([0, 337.5, 675, 200, 250, 300]);
	});

	it("snaps each axis on its own to the nearest edge or center in reach", () => {
		// Left edge 104 is 4 from 100; the y edges are all out of reach.
		expect(
			applySnap({ x: 104, y: 500, width: 50, height: 20 }, targets),
		).toEqual({ x: 100, y: 500, guidesV: [100], guidesH: [] });
		// The box's center (x + 25) snaps to the slide center.
		expect(
			applySnap({ x: 572, y: 196, width: 50, height: 20 }, targets),
		).toEqual({ x: 575, y: 200, guidesV: [600], guidesH: [200] });
	});

	it("leaves a box alone when nothing is within the threshold", () => {
		expect(
			applySnap({ x: 120, y: 500, width: 50, height: 20 }, targets),
		).toEqual({ x: 120, y: 500, guidesV: [], guidesH: [] });
	});
});
