/** Snap distance in slide units: a gentle assist, a few screen pixels at
 * typical stage sizes, not a hard grid. */
export const SNAP_THRESHOLD = 6;

export interface SnapBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Vertical lines (x values) and horizontal lines (y values) to snap to. */
export interface SnapTargets {
	verts: number[];
	horiz: number[];
}

export interface SnapResult {
	x: number;
	y: number;
	guidesV: number[];
	guidesH: number[];
}

/** The slide's edges and center plus every other element's edges and center. */
export function computeSnapTargets(
	others: readonly SnapBox[],
	slideWidth: number,
	slideHeight: number,
): SnapTargets {
	const verts = [0, slideWidth / 2, slideWidth];
	const horiz = [0, slideHeight / 2, slideHeight];
	for (const box of others) {
		verts.push(box.x, box.x + box.width / 2, box.x + box.width);
		horiz.push(box.y, box.y + box.height / 2, box.y + box.height);
	}
	return { verts, horiz };
}

function snapAxis(
	start: number,
	size: number,
	targets: readonly number[],
): { position: number; guide: number } | null {
	let best: { distance: number; position: number; guide: number } | null = null;
	for (const offset of [0, size / 2, size]) {
		for (const target of targets) {
			const distance = Math.abs(target - (start + offset));
			if (distance <= SNAP_THRESHOLD && (!best || distance < best.distance))
				best = { distance, position: target - offset, guide: target };
		}
	}
	return best && { position: best.position, guide: best.guide };
}

/** Moves a box's top-left to the nearest target within SNAP_THRESHOLD on each
 * axis independently, and returns the guide lines that snapped. */
export function applySnap(box: SnapBox, targets: SnapTargets): SnapResult {
	const x = snapAxis(box.x, box.width, targets.verts);
	const y = snapAxis(box.y, box.height, targets.horiz);
	return {
		x: x ? x.position : box.x,
		y: y ? y.position : box.y,
		guidesV: x ? [x.guide] : [],
		guidesH: y ? [y.guide] : [],
	};
}
