// Hex grid geometry + selection-outline computation.
//
// All hexes are generated as flat-top hexes in an un-rotated coordinate space.
// The user-facing "angle" is applied as a single SVG rotation of the whole
// group, so the geometry here never needs to know about it.

const SQRT3 = Math.sqrt(3);

// Quantization factor for snapping vertices to a shared key. Hexes that touch
// share vertices; tiny floating-point differences would otherwise prevent us
// from recognising an edge as "internal". Snapping to 1/1000 px is plenty
// finer than any visible difference while erasing float noise.
const Q = 1000;

/**
 * @typedef {[number, number]} Point
 * @typedef {{id: string, cx?: number, cy?: number, points: Point[]}} Hex
 * @typedef {{count: number, ak: string, bk: string, a: Point, b: Point}} Edge
 */

/** @param {Point} p */
function vkey(p) {
	return `${Math.round(p[0] * Q)},${Math.round(p[1] * Q)}`;
}

/**
 * The six corner points of a flat-top hex centered at (cx, cy).
 * @param {number} cx
 * @param {number} cy
 * @param {number} size
 * @returns {Point[]}
 */
function hexCorners(cx, cy, size) {
	/** @type {Point[]} */
	const pts = [];
	for (let i = 0; i < 6; i++) {
		const ang = (Math.PI / 180) * (60 * i);
		pts.push([cx + size * Math.cos(ang), cy + size * Math.sin(ang)]);
	}
	return pts;
}

/**
 * Generate a flat-top hex grid that fully covers a {width} x {height} viewport
 * even after it is rotated about its center (we over-cover by the diagonal so
 * the corners never reveal empty space at any angle).
 *
 * @param {number} width
 * @param {number} height
 * @param {number} size
 * @returns {Hex[]}
 */
export function generateGrid(width, height, size) {
	if (!width || !height || size <= 0) return [];

	const cx = width / 2;
	const cy = height / 2;
	// Half-extent we need to cover so rotation never exposes a gap.
	const R = Math.sqrt(width * width + height * height) / 2 + size * 2;

	const colStep = 1.5 * size; // horizontal distance between hex centers
	const rowStep = SQRT3 * size; // vertical distance between hex centers

	const colCount = Math.ceil((2 * R) / colStep) + 2;
	const rowCount = Math.ceil((2 * R) / rowStep) + 2;
	const cHalf = Math.ceil(colCount / 2);
	const rHalf = Math.ceil(rowCount / 2);

	/** @type {Hex[]} */
	const hexes = [];
	for (let c = -cHalf; c <= cHalf; c++) {
		for (let r = -rHalf; r <= rHalf; r++) {
			const hx = cx + c * colStep;
			// Odd columns are nudged down half a row (flat-top offset layout).
			const hy = cy + r * rowStep + (Math.abs(c % 2) === 1 ? rowStep / 2 : 0);
			if (Math.abs(hx - cx) > R || Math.abs(hy - cy) > R) continue;
			hexes.push({ id: `${c},${r}`, cx: hx, cy: hy, points: hexCorners(hx, hy, size) });
		}
	}
	return hexes;
}

/**
 * Rebuild hex geometry from a list of saved ids (e.g. a library item).
 * Centers are laid out about the origin — absolute position doesn't matter to
 * callers, which crop to the shape's bounding box anyway.
 *
 * @param {string[]} ids
 * @param {number} size
 * @returns {Hex[]}
 */
export function buildHexesFromIds(ids, size) {
	const colStep = 1.5 * size;
	const rowStep = SQRT3 * size;
	return ids.map((id) => {
		const [c, r] = id.split(',').map(Number);
		const cx = c * colStep;
		const cy = r * rowStep + (Math.abs(c % 2) === 1 ? rowStep / 2 : 0);
		return { id, points: hexCorners(cx, cy, size) };
	});
}

/**
 * Turn a hex's points into the string an SVG <polygon> expects.
 * @param {Point[]} points
 */
export function pointsString(points) {
	return points.map((p) => `${p[0]},${p[1]}`).join(' ');
}

/**
 * Given a set of selected hexes, compute the outline(s) that wrap around them.
 *
 * The boundary of a union of polygons is exactly the set of edges that belong
 * to only one selected hex (edges shared by two selected hexes are internal).
 * We collect those boundary edges and stitch them into ordered closed loops so
 * each connected cluster — and any hole — becomes its own continuous path.
 *
 * @param {Hex[]} hexes
 * @returns {Point[][]} an array of loops (each a list of points)
 */
export function computeOutlines(hexes) {
	/** @type {Map<string, Edge>} */
	const edges = new Map();

	for (const h of hexes) {
		const pts = h.points;
		for (let i = 0; i < pts.length; i++) {
			const a = pts[i];
			const b = pts[(i + 1) % pts.length];
			const ak = vkey(a);
			const bk = vkey(b);
			const ek = ak < bk ? `${ak}|${bk}` : `${bk}|${ak}`;
			const existing = edges.get(ek);
			if (existing) existing.count++;
			else edges.set(ek, { count: 1, ak, bk, a, b });
		}
	}

	// Keep only boundary edges, and build a vertex adjacency map for stitching.
	/** @type {Map<string, Array<{ek: string, to: string}>>} */
	const adj = new Map();
	/** @type {Map<string, Point>} */
	const coord = new Map();
	/** @type {Set<string>} */
	const remaining = new Set();

	for (const [ek, e] of edges) {
		if (e.count !== 1) continue;
		remaining.add(ek);
		coord.set(e.ak, e.a);
		coord.set(e.bk, e.b);
		let aNeighbors = adj.get(e.ak);
		if (!aNeighbors) {
			aNeighbors = [];
			adj.set(e.ak, aNeighbors);
		}
		let bNeighbors = adj.get(e.bk);
		if (!bNeighbors) {
			bNeighbors = [];
			adj.set(e.bk, bNeighbors);
		}
		aNeighbors.push({ ek, to: e.bk });
		bNeighbors.push({ ek, to: e.ak });
	}

	/** @type {Point[][]} */
	const loops = [];
	while (remaining.size) {
		const startEk = remaining.values().next().value;
		if (!startEk) break;
		const e0 = edges.get(startEk);
		if (!e0) {
			remaining.delete(startEk);
			continue;
		}
		remaining.delete(startEk);

		const startK = e0.ak;
		let curK = e0.bk;
		const a = coord.get(e0.ak);
		const b = coord.get(e0.bk);
		if (!a || !b) continue;
		/** @type {Point[]} */
		const loop = [a, b];

		while (curK !== startK) {
			const neighbors = adj.get(curK) || [];
			let next = null;
			for (const n of neighbors) {
				if (remaining.has(n.ek)) {
					next = n;
					break;
				}
			}
			if (!next) break; // safety: shouldn't happen for a closed boundary
			remaining.delete(next.ek);
			const nextPoint = coord.get(next.to);
			if (!nextPoint) break;
			loop.push(nextPoint);
			curK = next.to;
		}
		loops.push(loop);
	}

	return loops;
}

/**
 * Convert a stitched loop into an SVG path string.
 * @param {Point[]} loop
 */
export function outlinePath(loop) {
	if (!loop.length) return '';
	const [first, ...rest] = loop;
	let d = `M ${first[0]} ${first[1]}`;
	for (const p of rest) d += ` L ${p[0]} ${p[1]}`;
	return d + ' Z';
}
