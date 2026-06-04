// Hex grid geometry + selection-outline computation.
//
// Both flat-top and flat-sides (pointy-top) layouts are supported natively.
// The orientation is passed as a `flatTop` boolean so the generated (column, row)
// coordinates always match the visual layout — no SVG rotation needed.

const SQRT3 = Math.sqrt(3);

// Quantization factor for snapping vertices to a shared key.
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
 * Six corner points of a hex centered at (cx, cy).
 * Flat-top corners start at 0°; pointy-top (flat-sides) corners start at 30°.
 * @param {number} cx
 * @param {number} cy
 * @param {number} size
 * @param {boolean} [pointyTop]
 * @returns {Point[]}
 */
function hexCorners(cx, cy, size, pointyTop = false) {
	/** @type {Point[]} */
	const pts = [];
	const start = pointyTop ? 30 : 0;
	for (let i = 0; i < 6; i++) {
		const ang = (Math.PI / 180) * (start + 60 * i);
		pts.push([cx + size * Math.cos(ang), cy + size * Math.sin(ang)]);
	}
	return pts;
}

/**
 * Generate a hex grid that fully covers a {width} × {height} viewport.
 *
 * Flat-top layout  (flatTop = true, default):
 *   colStep = 3·size,  rowStep = √3·size/2,  odd rows shift right ½ column.
 *
 * Flat-sides / pointy-top layout  (flatTop = false):
 *   colStep = √3·size/2,  rowStep = 3·size,  odd columns shift down ½ row.
 *
 * In both cases (column, row) increases rightward / downward on screen.
 *
 * @param {number} width
 * @param {number} height
 * @param {number} size
 * @param {boolean} [flatTop]
 * @returns {Hex[]}
 */
export function generateGrid(width, height, size, flatTop = true) {
	if (!width || !height || size <= 0) return [];

	const cx = width / 2;
	const cy = height / 2;
	// Half-extent to cover so no gap appears at any pan offset.
	const R = Math.sqrt(width * width + height * height) / 2 + size * 2;

	/** @type {Hex[]} */
	const hexes = [];

	if (flatTop) {
		// colStep = 3·size, rowStep = √3·size/2; odd rows shift right by colStep/2.
		const colStep = 3 * size;
		const rowStep = SQRT3 * size / 2;
		const cHalf = Math.ceil(Math.ceil((2 * R) / colStep + 2) / 2);
		const rHalf = Math.ceil(Math.ceil((2 * R) / rowStep + 2) / 2);
		for (let r = -rHalf; r <= rHalf; r++) {
			for (let c = -cHalf; c <= cHalf; c++) {
				const hx = cx + c * colStep + (Math.abs(r % 2) === 1 ? colStep / 2 : 0);
				const hy = cy + r * rowStep;
				if (Math.abs(hx - cx) > R || Math.abs(hy - cy) > R) continue;
				hexes.push({ id: `${c},${r}`, cx: hx, cy: hy, points: hexCorners(hx, hy, size, false) });
			}
		}
	} else {
		// colStep = √3·size/2, rowStep = 3·size; odd columns shift down by rowStep/2.
		const colStep = SQRT3 * size / 2;
		const rowStep = 3 * size;
		const cHalf = Math.ceil(Math.ceil((2 * R) / colStep + 2) / 2);
		const rHalf = Math.ceil(Math.ceil((2 * R) / rowStep + 2) / 2);
		for (let c = -cHalf; c <= cHalf; c++) {
			for (let r = -rHalf; r <= rHalf; r++) {
				const hx = cx + c * colStep;
				const hy = cy + r * rowStep + (Math.abs(c % 2) === 1 ? rowStep / 2 : 0);
				if (Math.abs(hx - cx) > R || Math.abs(hy - cy) > R) continue;
				hexes.push({ id: `${c},${r}`, cx: hx, cy: hy, points: hexCorners(hx, hy, size, true) });
			}
		}
	}

	return hexes;
}

/**
 * Rebuild hex geometry from a list of saved ids.
 * Centers are laid out about the origin — callers crop to bounding box.
 *
 * @param {string[]} ids
 * @param {number} size
 * @param {boolean} [flatTop]
 * @returns {Hex[]}
 */
export function buildHexesFromIds(ids, size, flatTop = true) {
	if (flatTop) {
		const colStep = 3 * size;
		const rowStep = SQRT3 * size / 2;
		return ids.map((id) => {
			const [c, r] = id.split(',').map(Number);
			const cx = c * colStep + (Math.abs(r % 2) === 1 ? colStep / 2 : 0);
			const cy = r * rowStep;
			return { id, points: hexCorners(cx, cy, size, false) };
		});
	} else {
		const colStep = SQRT3 * size / 2;
		const rowStep = 3 * size;
		return ids.map((id) => {
			const [c, r] = id.split(',').map(Number);
			const cx = c * colStep;
			const cy = r * rowStep + (Math.abs(c % 2) === 1 ? rowStep / 2 : 0);
			return { id, points: hexCorners(cx, cy, size, true) };
		});
	}
}

/**
 * Return the IDs of the 6 grid neighbors of a hex.
 *
 * In our coordinate system the flat top/bottom (or left/right) shared edges
 * connect cells that are 2 coordinate steps apart on the stagger axis, while
 * the four diagonal shared edges connect cells 1 step apart on that axis.
 *
 * Flat-top (odd rows shift right, colStep=3·size, rowStep=√3·size/2):
 *   even row: top/bottom at r±2 (same col); diagonals at r±1 (col and col-1)
 *   odd  row: top/bottom at r±2 (same col); diagonals at r±1 (col+1 and col)
 *
 * Flat-sides (odd cols shift down, colStep=√3·size/2, rowStep=3·size):
 *   even col: left/right at c±2 (same row); diagonals at c±1 (row and row-1)
 *   odd  col: left/right at c±2 (same row); diagonals at c±1 (row and row+1)
 *
 * @param {string} id
 * @param {boolean} [flatTop]
 * @returns {string[]}
 */
export function hexNeighborIds(id, flatTop = true) {
	const [c, r] = id.split(',').map(Number);
	if (flatTop) {
		if (Math.abs(r % 2) === 1) {
			// odd row
			return [
				`${c},${r - 2}`, `${c},${r + 2}`,
				`${c + 1},${r - 1}`, `${c + 1},${r + 1}`,
				`${c},${r - 1}`, `${c},${r + 1}`
			];
		} else {
			// even row
			return [
				`${c},${r - 2}`, `${c},${r + 2}`,
				`${c},${r - 1}`, `${c},${r + 1}`,
				`${c - 1},${r - 1}`, `${c - 1},${r + 1}`
			];
		}
	} else {
		if (Math.abs(c % 2) === 1) {
			// odd column
			return [
				`${c - 2},${r}`, `${c + 2},${r}`,
				`${c + 1},${r}`, `${c + 1},${r + 1}`,
				`${c - 1},${r}`, `${c - 1},${r + 1}`
			];
		} else {
			// even column
			return [
				`${c - 2},${r}`, `${c + 2},${r}`,
				`${c + 1},${r}`, `${c + 1},${r - 1}`,
				`${c - 1},${r}`, `${c - 1},${r - 1}`
			];
		}
	}
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
			if (!next) break;
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
