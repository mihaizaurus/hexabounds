// Build a self-contained, cropped SVG of a selected shape, and download it as
// SVG or PNG. The shape is the selected hexes (green wash + faint grid edges)
// plus the merged green outline, rotated by the current angle and cropped to a
// tight bounding box with a little padding.

const r2 = (n) => Math.round(n * 100) / 100;

function rotate([x, y], deg) {
	const a = (deg * Math.PI) / 180;
	const c = Math.cos(a);
	const s = Math.sin(a);
	return [x * c - y * s, x * s + y * c];
}

/**
 * Produce renderable shape data: dimensions plus polygon/path geometry already
 * offset into a (0,0)-anchored box. Returns null when there's nothing selected.
 *
 * @param {Array<{points: Array<[number, number]>}>} hexes
 * @param {Array<Array<[number, number]>>} outlines
 * @param {number} angle
 */
export function buildShape(hexes, outlines, angle, pad = 10) {
	if (!hexes.length) return null;

	const hx = hexes.map((h) => h.points.map((p) => rotate(p, angle)));
	const ls = outlines.map((l) => l.map((p) => rotate(p, angle)));

	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const poly of hx) {
		for (const [x, y] of poly) {
			if (x < minX) minX = x;
			if (y < minY) minY = y;
			if (x > maxX) maxX = x;
			if (y > maxY) maxY = y;
		}
	}

	const ox = pad - minX;
	const oy = pad - minY;
	const off = ([x, y]) => [r2(x + ox), r2(y + oy)];

	const polys = hx.map((poly) => poly.map(off).map((p) => `${p[0]},${p[1]}`).join(' '));
	const paths = ls.map((l) => {
		const pts = l.map(off);
		return 'M ' + pts.map((p) => `${p[0]} ${p[1]}`).join(' L ') + ' Z';
	});

	return {
		width: r2(maxX - minX + pad * 2),
		height: r2(maxY - minY + pad * 2),
		polys,
		paths
	};
}

/** Serialize shape data to a standalone SVG string. */
export function shapeSvgString(shape, { background = false } = {}) {
	const bg = background ? `<rect width="${shape.width}" height="${shape.height}" fill="#ffffff"/>` : '';
	const hexes = shape.polys
		.map((p) => `<polygon points="${p}" fill="rgba(0,166,62,0.14)" stroke="rgba(0,0,0,0.1)" stroke-width="1"/>`)
		.join('');
	const outline = shape.paths
		.map((d) => `<path d="${d}" fill="none" stroke="#00a63e" stroke-width="3" stroke-linejoin="round"/>`)
		.join('');
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" width="${shape.width}" height="${shape.height}" ` +
		`viewBox="0 0 ${shape.width} ${shape.height}">${bg}${hexes}${outline}</svg>`
	);
}

function download(href, filename) {
	const a = document.createElement('a');
	a.href = href;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
}

export function exportSvg(shape, filename = 'hexshape.svg') {
	if (!shape) return;
	const blob = new Blob([shapeSvgString(shape)], { type: 'image/svg+xml' });
	const url = URL.createObjectURL(blob);
	download(url, filename);
	URL.revokeObjectURL(url);
}

export function exportPng(shape, filename = 'hexshape.png', scale = 2) {
	if (!shape) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const blob = new Blob([shapeSvgString(shape, { background: true })], { type: 'image/svg+xml' });
		const url = URL.createObjectURL(blob);
		const img = new Image();
		img.onload = () => {
			const canvas = document.createElement('canvas');
			canvas.width = Math.ceil(shape.width * scale);
			canvas.height = Math.ceil(shape.height * scale);
			const ctx = canvas.getContext('2d');
			ctx.scale(scale, scale);
			ctx.drawImage(img, 0, 0);
			URL.revokeObjectURL(url);
			canvas.toBlob((b) => {
				const u = URL.createObjectURL(b);
				download(u, filename);
				URL.revokeObjectURL(u);
				resolve();
			}, 'image/png');
		};
		img.onerror = reject;
		img.src = url;
	});
}
