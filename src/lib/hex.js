// Hex grid geometry + selection-outline computation.
//
// Hexes are identified by their axial coordinates (q, r) as the string "${q},${r}".
// The same (q, r) pair represents the same hex regardless of flat-top or flat-sides
// orientation — only the pixel projection differs, so shapes transfer cleanly between
// the two layouts.
//
// Axial pixel projections (size = circumradius):
//   flat-top:   x = size·(3/2·q)                  y = size·(√3/2·q + √3·r)
//   flat-sides: x = size·(√3·q + √3/2·r)           y = size·(3/2·r)
//
// Neighbor offsets are the same six axial vectors in both orientations:
//   (+1,0) (−1,0) (0,+1) (0,−1) (+1,−1) (−1,+1)

const SQRT3 = Math.sqrt(3);

// Quantization factor for snapping vertices to a shared key.
const Q_SNAP = 1000;

/**
 * @typedef {[number, number]} Point
 * @typedef {{id: string, cx?: number, cy?: number, points: Point[]}} Hex
 * @typedef {{count: number, ak: string, bk: string, a: Point, b: Point}} Edge
 */

/** @param {Point} p */
function vkey(p) {
	return `${Math.round(p[0] * Q_SNAP)},${Math.round(p[1] * Q_SNAP)}`;
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
 * Hex IDs are axial coordinates: "${q},${r}".
 *
 * Internally the grid is still generated via the same offset layout loops so
 * the bounding-box culling is unchanged; we just derive the axial ID from the
 * offset counters instead of using them directly as IDs.
 *
 * Flat-top offset → axial:   q = 2·co + (|ro%2|===1 ? 1 : 0),  r = (ro − q) / 2
 * Flat-sides offset → axial: r = 2·ro + (|co%2|===1 ? 1 : 0),  q = (co − r) / 2
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
	const R = Math.sqrt(width * width + height * height) / 2 + size * 2;

	/** @type {Hex[]} */
	const hexes = [];

	if (flatTop) {
		const colStep = 3 * size;
		const rowStep = SQRT3 * size / 2;
		const cHalf = Math.ceil(Math.ceil((2 * R) / colStep + 2) / 2);
		const rHalf = Math.ceil(Math.ceil((2 * R) / rowStep + 2) / 2);
		for (let ro = -rHalf; ro <= rHalf; ro++) {
			for (let co = -cHalf; co <= cHalf; co++) {
				const hx = cx + co * colStep + (Math.abs(ro % 2) === 1 ? colStep / 2 : 0);
				const hy = cy + ro * rowStep;
				if (Math.abs(hx - cx) > R || Math.abs(hy - cy) > R) continue;
				const q = 2 * co + (Math.abs(ro % 2) === 1 ? 1 : 0);
				const r = (ro - q) / 2;
				hexes.push({ id: `${q},${r}`, cx: hx, cy: hy, points: hexCorners(hx, hy, size, false) });
			}
		}
	} else {
		const colStep = SQRT3 * size / 2;
		const rowStep = 3 * size;
		const cHalf = Math.ceil(Math.ceil((2 * R) / colStep + 2) / 2);
		const rHalf = Math.ceil(Math.ceil((2 * R) / rowStep + 2) / 2);
		for (let co = -cHalf; co <= cHalf; co++) {
			for (let ro = -rHalf; ro <= rHalf; ro++) {
				const hx = cx + co * colStep;
				const hy = cy + ro * rowStep + (Math.abs(co % 2) === 1 ? rowStep / 2 : 0);
				if (Math.abs(hx - cx) > R || Math.abs(hy - cy) > R) continue;
				const r = 2 * ro + (Math.abs(co % 2) === 1 ? 1 : 0);
				const q = (co - r) / 2;
				hexes.push({ id: `${q},${r}`, cx: hx, cy: hy, points: hexCorners(hx, hy, size, true) });
			}
		}
	}

	return hexes;
}

/**
 * Rebuild hex geometry from a list of axial-coordinate IDs ("${q},${r}").
 * Centers are laid out about the origin — callers crop to bounding box.
 *
 * @param {string[]} ids  axial "${q},${r}" IDs
 * @param {number} size
 * @param {boolean} [flatTop]
 * @returns {Hex[]}
 */
export function buildHexesFromIds(ids, size, flatTop = true) {
	return ids.map((id) => {
		const [q, r] = id.split(',').map(Number);
		let hx, hy;
		if (flatTop) {
			hx = size * (3 / 2) * q;
			hy = size * (SQRT3 / 2 * q + SQRT3 * r);
		} else {
			hx = size * (SQRT3 * q + SQRT3 / 2 * r);
			hy = size * (3 / 2) * r;
		}
		return { id, points: hexCorners(hx, hy, size, !flatTop) };
	});
}

/**
 * Return the IDs of the 6 grid neighbors of a hex.
 * In axial coordinates the six neighbor offsets are the same regardless of
 * flat-top or flat-sides orientation, so no layout parameter is needed.
 *
 * @param {string} id  axial "${q},${r}" ID
 * @returns {string[]}
 */
export function hexNeighborIds(id) {
	const [q, r] = id.split(',').map(Number);
	return [
		`${q + 1},${r}`, `${q - 1},${r}`,
		`${q},${r + 1}`, `${q},${r - 1}`,
		`${q + 1},${r - 1}`, `${q - 1},${r + 1}`
	];
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
