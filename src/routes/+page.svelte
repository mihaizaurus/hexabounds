<script>
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import { SvelteSet } from 'svelte/reactivity';
	import {
		generateGrid,
		computeOutlines,
		buildHexesFromIds,
		hexNeighborIds,
		pointsString,
		outlinePath
	} from '$lib/hex.js';
	import { buildShape, exportSvg, exportPng } from '$lib/export.js';

	const LIB_KEY = 'hexabounds:library';

	/** @typedef {{ key: string, name: string, ids: string[], positions?: {column: number, row: number}[], size: number, angle: number, folderId?: string | null, clusters?: { ids: string[], positions: {column: number, row: number}[] }[] }} LibraryItem */

	const CLUSTER_FILLS = [
		'rgba(0,166,62,0.18)',
		'rgba(0,122,204,0.18)',
		'rgba(220,110,0,0.18)',
		'rgba(140,0,166,0.18)',
		'rgba(0,166,140,0.18)',
		'rgba(200,50,50,0.18)',
	];
	const CLUSTER_STROKES = ['#00a63e', '#007acc', '#dc6e00', '#8c00a6', '#00a68c', '#c83232'];

	// --- settings ---
	let size = $state(44);
	let flatTop = $state(true);
	const angle = $derived(flatTop ? 0 : 30);

	// --- origin ---
	const ORIGIN_KEY = 'hexabounds:origin';
	let originCol = $state(0);
	let originRow = $state(0);

	// --- selection ---
	/** @type {SvelteSet<string>} */
	const selected = new SvelteSet();
	let painting = $state(false);
	/** @type {'add' | 'erase'} */
	let paintMode = $state('add');
	/** @type {number | null} */
	let paintPointerId = $state(null);

	// --- pan ---
	let panX = $state(0);
	let panY = $state(0);
	let spaceHeld = $state(false);
	let panActive = $state(false);
	/** @type {number | null} */
	let panPointerId = $state(null);
	let panStartX = 0;
	let panStartY = 0;
	let panStartPanX = 0;
	let panStartPanY = 0;

	// --- move ---
	let moveHeld = $state(false);
	let moveActive = $state(false);
	/** @type {string | null} */
	let moveStartHexId = null;
	/** @type {string[]} */
	let moveStartIds = [];
	/** @type {{ dc: number, dr: number }} */
	let moveDelta = $state({ dc: 0, dr: 0 });
	/** @type {number | null} */
	let movePointerId = null;

	// --- viewport (the area the grid fills) ---
	let stageW = $state(0);
	let stageH = $state(0);

	// Pan offset that places the origin hex at the viewport centre.
	const originPanTarget = $derived.by(() => {
		const SQRT3 = Math.sqrt(3);
		if (flatTop) {
			const colStep = 3 * size;
			const rowStep = (SQRT3 * size) / 2;
			return {
				x: -(originCol * colStep + (Math.abs(originRow % 2) === 1 ? colStep / 2 : 0)),
				y: -(originRow * rowStep),
			};
		} else {
			const colStep = (SQRT3 * size) / 2;
			const rowStep = 3 * size;
			return {
				x: -(originCol * colStep),
				y: -(originRow * rowStep + (Math.abs(originCol % 2) === 1 ? rowStep / 2 : 0)),
			};
		}
	});

	const grid = $derived(generateGrid(stageW, stageH, size, flatTop));
	const gridById = $derived(new Map(grid.map((h) => [h.id, h])));
	// Iterate `selected` in insertion order so that clusters are numbered by when they were first painted.
	const selectedHexes = $derived(
		/** @type {ReturnType<typeof generateGrid>} */ ([...selected].map((id) => gridById.get(id)).filter((h) => h != null))
	);

	const selectionClusters = $derived.by(() => {
		const hexById = new Map(selectedHexes.map((h) => [h.id, h]));
		const visited = new Set();
		/** @type {{ hexes: typeof selectedHexes, outlines: ReturnType<typeof computeOutlines> }[]} */
		const result = [];
		for (const hex of selectedHexes) {
			if (!visited.has(hex.id)) {
				const clusterHexes = [];
				const queue = [hex];
				visited.add(hex.id);
				while (queue.length) {
					const cur = /** @type {(typeof selectedHexes)[0]} */ (queue.shift());
					clusterHexes.push(cur);
					for (const nId of hexNeighborIds(cur.id, flatTop)) {
						const neighbor = hexById.get(nId);
						if (neighbor && !visited.has(nId)) {
							visited.add(nId);
							queue.push(neighbor);
						}
					}
				}
				result.push({ hexes: clusterHexes, outlines: computeOutlines(clusterHexes) });
			}
		}
		return result;
	});
	const outlines = $derived(selectionClusters.flatMap((c) => c.outlines));
	const clusterByHexId = $derived(
		new Map(selectionClusters.flatMap((c, i) => c.hexes.map((h) => [h.id, i])))
	);
	const clusterCentroids = $derived(
		selectionClusters.map((c) => ({
			cx: c.hexes.reduce((s, h) => s + (h.cx ?? 0), 0) / c.hexes.length,
			cy: c.hexes.reduce((s, h) => s + (h.cy ?? 0), 0) / c.hexes.length,
		}))
	);
	const currentShape = $derived(
		selectedHexes.length ? buildShape(selectedHexes, outlines, 0) : null
	);

	const ghostIds = $derived.by(() => {
		if (!moveActive || (moveDelta.dc === 0 && moveDelta.dr === 0) || !moveStartHexId) return null;
		const { dc, dr } = moveDelta;
		const [c0, r0] = moveStartHexId.split(',').map(Number);
		return new Set(moveStartIds.map((id) => translateHexId(id, c0, r0, dc, dr, flatTop)));
	});

	// --- library ---
	/** @type {LibraryItem[]} */
	let library = $state([]);
	/** @type {string | null} */
	let expandedKey = $state(null);
	/** @type {string | null} */
	let copiedKey = $state(null);
	/** @type {ReturnType<typeof setTimeout> | null} */
	let copyTimer = null;
	/** @type {string | null} */
	let renamingKey = $state(null);
	let draftName = $state('');
	/** @type {HTMLInputElement | null} */
	let renameInput = $state(null);

	// --- folders ---
	const FOLDERS_KEY = 'hexabounds:folders';
	/** @typedef {{ key: string, name: string, collapsed: boolean }} Folder */
	/** @type {Folder[]} */
	let folders = $state([]);
	/** @type {string | null} */
	let renamingFolderKey = $state(null);
	let draftFolderName = $state('');
	/** @type {HTMLInputElement | null} */
	let folderRenameInput = $state(null);

	const ungroupedItems = $derived(library.filter((i) => !i.folderId));

	// --- panel ---
	let panelCollapsed = $state(false);
	let panelWidth = $state(280);
	let resizing = $state(false);
	let resizeStartX = 0;
	let resizeStartWidth = 0;

	$effect(() => {
		if (renamingKey && renameInput) {
			renameInput.focus();
			renameInput.select();
		}
	});

	$effect(() => {
		if (renamingFolderKey && folderRenameInput) {
			folderRenameInput.focus();
			folderRenameInput.select();
		}
	});

	/** @param {PointerEvent} event */
	function startResize(event) {
		if (event.button !== 0) return;
		if (event.currentTarget instanceof Element) {
			event.currentTarget.setPointerCapture(event.pointerId);
		}
		resizing = true;
		resizeStartX = event.clientX;
		resizeStartWidth = panelWidth;
		event.preventDefault();
	}

	/** @param {PointerEvent} event */
	function handleResizeMove(event) {
		if (!resizing) return;
		panelWidth = Math.max(200, Math.min(600, resizeStartWidth + (event.clientX - resizeStartX)));
	}

	function stopResize() {
		resizing = false;
	}

	function persistFolders() {
		if (browser) localStorage.setItem(FOLDERS_KEY, JSON.stringify(folders));
	}

	function addFolder() {
		const folder = { key: crypto.randomUUID(), name: `Folder ${folders.length + 1}`, collapsed: false };
		folders = [...folders, folder];
		renamingFolderKey = folder.key;
		draftFolderName = folder.name;
		persistFolders();
	}

	/** @param {string} key */
	function deleteFolder(key) {
		library = library.map((i) => (i.folderId === key ? { ...i, folderId: null } : i));
		folders = folders.filter((f) => f.key !== key);
		if (renamingFolderKey === key) { renamingFolderKey = null; draftFolderName = ''; }
		persistFolders();
		persist();
	}

	/** @param {string} key */
	function toggleFolder(key) {
		folders = folders.map((f) => (f.key === key ? { ...f, collapsed: !f.collapsed } : f));
		persistFolders();
	}

	/** @param {Folder} folder */
	function beginRenameFolder(folder) {
		renamingFolderKey = folder.key;
		draftFolderName = folder.name;
	}

	function cancelRenameFolder() {
		renamingFolderKey = null;
		draftFolderName = '';
	}

	/** @param {Folder} folder */
	function commitRenameFolder(folder) {
		if (renamingFolderKey !== folder.key) return;
		const nextName = draftFolderName.trim() || folder.name;
		folders = folders.map((f) => (f.key === folder.key ? { ...f, name: nextName } : f));
		persistFolders();
		cancelRenameFolder();
	}

	/** @param {KeyboardEvent} event @param {Folder} folder */
	function handleFolderRenameKeydown(event, folder) {
		if (event.key === 'Enter') { event.preventDefault(); commitRenameFolder(folder); }
		else if (event.key === 'Escape') { event.preventDefault(); cancelRenameFolder(); }
	}

	/** @param {string} itemKey @param {string | null} folderId */
	function moveItemToFolder(itemKey, folderId) {
		library = library.map((i) => (i.key === itemKey ? { ...i, folderId: folderId || null } : i));
		persist();
	}

	onMount(() => {
		try {
			const stored = localStorage.getItem(LIB_KEY);
			if (stored) library = JSON.parse(stored);
		} catch {
			// ignore malformed storage
		}
		try {
			const storedFolders = localStorage.getItem(FOLDERS_KEY);
			if (storedFolders) folders = JSON.parse(storedFolders);
		} catch {
			// ignore malformed storage
		}
		try {
			const storedOrigin = localStorage.getItem(ORIGIN_KEY);
			if (storedOrigin) {
				const parsed = JSON.parse(storedOrigin);
				originCol = parsed.col ?? 0;
				originRow = parsed.row ?? 0;
			}
		} catch {
			// ignore malformed storage
		}
	});

	function persist() {
		if (browser) localStorage.setItem(LIB_KEY, JSON.stringify(library));
	}

	/**
	 * Get sorted {column, row} positions for a library item.
	 * Handles both the new format and old {id,x,y} format gracefully.
	 * @param {LibraryItem} item
	 * @returns {{column: number, row: number}[]}
	 */
	function getPositions(item) {
		if (item.positions && item.positions.length > 0 && 'column' in item.positions[0]) {
			return /** @type {{column: number, row: number}[]} */ (item.positions);
		}
		return item.ids
			.map((id) => { const [c, r] = id.split(',').map(Number); return { column: c, row: r }; })
			.sort((a, b) => a.row !== b.row ? a.row - b.row : a.column - b.column);
	}

	/** @param {{column: number, row: number}} p @returns {string} */
	function fmtPos(p) {
		return `{ column: ${p.column - originCol}, row: ${p.row - originRow} }`;
	}

	/** @param {LibraryItem} item @returns {string} */
	function formatCoords(item) {
		if (item.clusters && item.clusters.length > 1) {
			const groups = item.clusters.map((cluster, i) => {
				const inner = cluster.positions.map((p) => `      ${fmtPos(p)}`).join(',\n');
				return `  // Group ${i + 1}\n  [\n${inner},\n  ]`;
			});
			return `[\n${groups.join(',\n')},\n]`;
		}
		const positions = getPositions(item);
		if (!positions.length) return '[]';
		const inner = positions.map((p) => `    ${fmtPos(p)}`).join(',\n');
		return `[\n${inner},\n]`;
	}

	/** @param {LibraryItem} item */
	async function copyCoords(item) {
		try {
			await navigator.clipboard.writeText(formatCoords(item));
			copiedKey = item.key;
			if (copyTimer) clearTimeout(copyTimer);
			copyTimer = setTimeout(() => { copiedKey = null; }, 1500);
		} catch {
			// clipboard unavailable
		}
	}

	/** @param {string} id */
	function applyPaint(id) {
		if (paintMode === 'add') selected.add(id);
		else selected.delete(id);
	}

	/**
	 * Translate a hex ID by (dc, dr) with stagger-aware correction so the shape
	 * is pixel-exact regardless of parity.
	 *
	 * In the "doubled" offset system each layout has a stagger that flips when the
	 * anchor axis changes parity:
	 *   flat-top:   odd rows shift right → moving by odd dr flips the column stagger
	 *   flat-sides: odd cols shift down  → moving by odd dc flips the row stagger
	 *
	 * Correction formula (flat-top example):
	 *   correction = (stagger(r1) - stagger(r0) + stagger(rs) - stagger(rs+dr)) / 2
	 * where stagger(r) = |r%2|===1 ? 1 : 0. The sum is always 0 or ±2, so /2 is
	 * always an integer (0 or ±1).
	 *
	 * @param {string} id source hex ID
	 * @param {number} c0 drag-anchor column
	 * @param {number} r0 drag-anchor row
	 * @param {number} dc column delta
	 * @param {number} dr row delta
	 * @param {boolean} flatTop
	 * @returns {string}
	 */
	function translateHexId(id, c0, r0, dc, dr, flatTop) {
		const [cs, rs] = id.split(',').map(Number);
		const stagger = (/** @type {number} */ n) => Math.abs(n % 2) === 1 ? 1 : 0;
		if (flatTop) {
			const correction = (stagger(r0 + dr) - stagger(r0) + stagger(rs) - stagger(rs + dr)) / 2;
			return `${cs + dc + correction},${rs + dr}`;
		} else {
			const correction = (stagger(c0 + dc) - stagger(c0) + stagger(cs) - stagger(cs + dc)) / 2;
			return `${cs + dc},${rs + dr + correction}`;
		}
	}

	function commitMove() {
		if (!moveActive || !moveStartHexId) return;
		const { dc, dr } = moveDelta;
		if (dc !== 0 || dr !== 0) {
			const [c0, r0] = moveStartHexId.split(',').map(Number);
			for (const id of moveStartIds) selected.delete(id);
			for (const id of moveStartIds) {
				selected.add(translateHexId(id, c0, r0, dc, dr, flatTop));
			}
		}
		moveActive = false;
		movePointerId = null;
		moveStartHexId = null;
		moveDelta = { dc: 0, dr: 0 };
	}

	/**
	 * BFS through the selected set from startId, returning all connected hex IDs.
	 * @param {string} startId
	 * @returns {string[]}
	 */
	function getCluster(startId) {
		const cluster = new Set([startId]);
		const queue = [startId];
		while (queue.length) {
			const id = /** @type {string} */ (queue.shift());
			for (const nId of hexNeighborIds(id, flatTop)) {
				if (selected.has(nId) && !cluster.has(nId)) {
					cluster.add(nId);
					queue.push(nId);
				}
			}
		}
		return [...cluster];
	}

	/** @param {PointerEvent} event @param {string} id */
	function startPainting(event, id) {
		if (spaceHeld) return; // let event bubble up so SVG can handle panning
		if (event.isPrimary === false) return;
		if (event.pointerType === 'mouse' && event.button !== 0) return;

		// Move mode: drag the cluster under the pointer independently
		if (moveHeld && selected.has(id)) {
			event.preventDefault();
			if (event.currentTarget instanceof Element) {
				try { event.currentTarget.releasePointerCapture(event.pointerId); } catch {}
			}
			moveActive = true;
			movePointerId = event.pointerId;
			moveStartHexId = id;
			moveStartIds = getCluster(id);
			moveDelta = { dc: 0, dr: 0 };
			return;
		}

		// Ctrl+click: move the coordinate origin to this hex
		if (event.ctrlKey) {
			event.preventDefault();
			const [c, r] = id.split(',').map(Number);
			originCol = c;
			originRow = r;
			if (browser) localStorage.setItem(ORIGIN_KEY, JSON.stringify({ col: c, row: r }));
			return;
		}

		// Alt+click on a selected hex deletes its entire connected cluster
		if (event.altKey && selected.has(id)) {
			event.preventDefault();
			for (const cId of getCluster(id)) selected.delete(cId);
			return;
		}

		event.preventDefault();
		if (event.currentTarget instanceof Element) {
			try {
				event.currentTarget.releasePointerCapture(event.pointerId);
			} catch {
				// The pointer may not have been captured (e.g. mouse input).
			}
		}
		painting = true;
		paintPointerId = event.pointerId;
		paintMode = selected.has(id) ? 'erase' : 'add';
		applyPaint(id);
	}

	/** @param {PointerEvent} event */
	function handleSvgPointerDown(event) {
		if (!spaceHeld) return;
		if (event.isPrimary === false) return;
		if (event.pointerType === 'mouse' && event.button !== 0) return;
		event.preventDefault();
		panActive = true;
		panPointerId = event.pointerId;
		panStartX = event.clientX;
		panStartY = event.clientY;
		panStartPanX = panX;
		panStartPanY = panY;
	}

	/** @param {PointerEvent} event */
	function handleWindowPointerMove(event) {
		if (panActive && event.pointerId === panPointerId) {
			panX = panStartPanX + (event.clientX - panStartX);
			panY = panStartPanY + (event.clientY - panStartY);
			return;
		}
		if (moveActive && event.pointerId === movePointerId) {
			const target = document.elementFromPoint(event.clientX, event.clientY);
			if (target instanceof Element) {
				const hex = target.closest('.hex');
				if (hex instanceof SVGElement && hex.dataset.id && moveStartHexId) {
					const [c0, r0] = moveStartHexId.split(',').map(Number);
					const [c1, r1] = hex.dataset.id.split(',').map(Number);
					moveDelta = { dc: c1 - c0, dr: r1 - r0 };
				}
			}
			return;
		}
		if (!painting || event.pointerId !== paintPointerId) return;
		const target = document.elementFromPoint(event.clientX, event.clientY);
		if (!(target instanceof Element)) return;
		const hex = target.closest('.hex');
		if (hex instanceof SVGElement && hex.dataset.id) applyPaint(hex.dataset.id);
	}

	/** @param {PointerEvent | undefined} event */
	function stopPainting(event = undefined) {
		if (event?.pointerId != null && paintPointerId != null && event.pointerId !== paintPointerId)
			return;
		painting = false;
		paintPointerId = null;
	}

	/** @param {PointerEvent} event */
	function handleWindowPointerUp(event) {
		if (panActive && event.pointerId === panPointerId) {
			panActive = false;
			panPointerId = null;
		}
		if (moveActive && event.pointerId === movePointerId) {
			commitMove();
			return;
		}
		stopPainting(event);
	}

	/** @param {KeyboardEvent} event */
	function handleKeyDown(event) {
		if (event.code === 'Space' && !event.repeat) {
			const active = document.activeElement;
			if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
			spaceHeld = true;
			if (painting) stopPainting();
			event.preventDefault();
		}
		if (event.code === 'KeyM' && !event.repeat) {
			const active = document.activeElement;
			if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
			moveHeld = true;
			event.preventDefault();
		}
		if (event.code === 'Escape' && moveActive) {
			moveActive = false;
			movePointerId = null;
			moveStartHexId = null;
			moveDelta = { dc: 0, dr: 0 };
		}
	}

	/** @param {KeyboardEvent} event */
	function handleKeyUp(event) {
		if (event.code === 'Space') {
			spaceHeld = false;
			if (panActive) {
				panActive = false;
				panPointerId = null;
			}
		}
		if (event.code === 'KeyM') {
			moveHeld = false;
			if (moveActive) commitMove();
		}
	}

	function clear() {
		selected.clear();
	}

	function saveShape() {
		if (!selected.size) return;
		const ids = [...selected];
		const positions = ids
			.map((id) => { const [c, r] = id.split(',').map(Number); return { column: c, row: r }; })
			.sort((a, b) => a.row !== b.row ? a.row - b.row : a.column - b.column);
		const clusterData = selectionClusters.map((cluster) => ({
			ids: cluster.hexes.map((h) => h.id),
			positions: cluster.hexes
				.map((h) => { const [c, r] = h.id.split(',').map(Number); return { column: c, row: r }; })
				.sort((a, b) => a.row !== b.row ? a.row - b.row : a.column - b.column)
		}));
		const item = {
			key: crypto.randomUUID(),
			name: `Shape ${library.length + 1}`,
			ids,
			positions,
			size,
			angle,
			clusters: clusterData.length > 1 ? clusterData : undefined
		};
		library = [item, ...library];
		renamingKey = item.key;
		draftName = item.name;
		persist();
	}

	/** @param {LibraryItem} item */
	function loadShape(item) {
		selected.clear();
		for (const id of item.ids) selected.add(id);
		size = item.size;
		flatTop = item.angle !== 30;
	}

	/** @param {string} key */
	function deleteShape(key) {
		library = library.filter((i) => i.key !== key);
		if (renamingKey === key) cancelRename();
		persist();
	}

	/** @param {LibraryItem} item */
	function beginRename(item) {
		renamingKey = item.key;
		draftName = item.name;
	}

	function cancelRename() {
		renamingKey = null;
		draftName = '';
	}

	/** @param {LibraryItem} item @param {string} name */
	function rename(item, name) {
		const nextName = name.trim() || item.name;
		library = library.map((i) => (i.key === item.key ? { ...i, name: nextName } : i));
		persist();
	}

	/** @param {LibraryItem} item */
	function commitRename(item) {
		if (renamingKey !== item.key) return;
		rename(item, draftName);
		cancelRename();
	}

	/** @param {KeyboardEvent} event @param {LibraryItem} item */
	function handleRenameKeydown(event, item) {
		if (event.key === 'Enter') {
			event.preventDefault();
			commitRename(item);
		} else if (event.key === 'Escape') {
			event.preventDefault();
			cancelRename();
		}
	}

	const _r2 = (/** @type {number} */ n) => Math.round(n * 100) / 100;

	/** @param {LibraryItem} item */
	function thumbForItem(item) {
		const allHexes = buildHexesFromIds(item.ids, item.size, item.angle !== 30);
		const combined = buildShape(allHexes, computeOutlines(allHexes), 0, 6);
		if (!combined || !item.clusters || item.clusters.length <= 1) {
			return { combined, clusterShapes: null };
		}
		// Reconstruct the offset buildShape applied (pad=6, angle=0 → no rotation)
		let minX = Infinity, minY = Infinity;
		for (const h of allHexes) {
			for (const [x, y] of h.points) {
				if (x < minX) minX = x;
				if (y < minY) minY = y;
			}
		}
		const ox = 6 - minX;
		const oy = 6 - minY;
		const idToIdx = new Map(item.ids.map((id, i) => [id, i]));
		// Font size scaled so it renders ~11px in the 44px thumbnail regardless of viewBox size.
		// With xMidYMid meet, scale = min(44/w, 44/h), so font_svg = 11 / scale = 11 * max(w,h) / 44.
		const fontSize = _r2(Math.max(combined.width, combined.height) * 0.28);
		const clusterShapes = item.clusters.map((cluster, ci) => {
			const polys = cluster.ids
				.map((id) => combined.polys[/** @type {number} */ (idToIdx.get(id))])
				.filter(Boolean);
			const clusterHexes = buildHexesFromIds(cluster.ids, item.size, item.angle !== 30);
			const paths = computeOutlines(clusterHexes).map((loop) => {
				const pts = loop.map(([x, y]) => `${_r2(x + ox)} ${_r2(y + oy)}`);
				return 'M ' + pts.join(' L ') + ' Z';
			});
			let sumX = 0, sumY = 0, count = 0;
			for (const h of clusterHexes) {
				for (const [x, y] of h.points) { sumX += x + ox; sumY += y + oy; count++; }
			}
			const rawCx = sumX / count;
			const rawCy = sumY / count;
			// Clamp centroid so the label stays within the viewBox.
			const half = fontSize * 0.6;
			const cx = _r2(Math.max(half, Math.min(combined.width - half, rawCx)));
			const cy = _r2(Math.max(half, Math.min(combined.height - half, rawCy)));
			return { polys, paths, colorIdx: ci, cx, cy };
		});
		return { combined, clusterShapes, fontSize };
	}
</script>

<svelte:window
	onpointermove={handleWindowPointerMove}
	onpointerup={handleWindowPointerUp}
	onpointercancel={handleWindowPointerUp}
	onkeydown={handleKeyDown}
	onkeyup={handleKeyUp}
/>

<div class="app">
	<aside class="panel" class:collapsed={panelCollapsed} style={panelCollapsed ? '' : `width: ${panelWidth}px`}>
		{#if !panelCollapsed}
		<div
			class="resize-handle"
			onpointerdown={startResize}
			onpointermove={handleResizeMove}
			onpointerup={stopResize}
			onpointercancel={stopResize}
		></div>
		{/if}
		<div class="panel-top">
			{#if !panelCollapsed}<h1>hexabounds</h1>{/if}
			<button
				class="collapse-btn"
				title={panelCollapsed ? 'Expand panel' : 'Collapse panel'}
				onclick={() => (panelCollapsed = !panelCollapsed)}
			>{panelCollapsed ? '›' : '‹'}</button>
		</div>
		{#if !panelCollapsed}
		<p class="hint">
			Click or drag to paint. Start on a selected hex to erase.
			<kbd>Alt</kbd>+click a selected hex to remove its connected cluster.
			<kbd>Ctrl</kbd>+click any hex to set the coordinate origin.
			Hold <kbd>Space</kbd> and drag to pan.
			Hold <kbd>M</kbd> and drag a selected hex to move the whole selection.
		</p>

		<label class="control">
			<span class="control-label">
				<span>Hex radius</span>
				<span class="value-input-wrap">
					<input
						class="value-input"
						type="number"
						min="10"
						max="120"
						step="1"
						bind:value={size}
						onchange={() => (size = Math.min(120, Math.max(10, size)))}
					/>px
				</span>
			</span>
			<input type="range" min="10" max="120" step="1" bind:value={size} />
		</label>

		<div class="control">
			<span class="control-label">
				<span>Orientation</span>
			</span>
			<div class="toggle">
				<button class:active={flatTop} onclick={() => (flatTop = true)}>Flat top</button>
				<button class:active={!flatTop} onclick={() => (flatTop = false)}>Flat sides</button>
			</div>
		</div>

		<div class="row">
			<button onclick={() => exportSvg(currentShape)} disabled={!currentShape}>Export SVG</button>
			<button onclick={() => exportPng(currentShape)} disabled={!currentShape}>Export PNG</button>
		</div>

		<div class="library">
			<div class="lib-head">
				<span class="section">Library</span>
				<div class="lib-head-actions">
					<button class="new-folder" onclick={addFolder} title="New folder">+ Folder</button>
					<button class="save" onclick={saveShape} disabled={!selected.size}>Save shape</button>
				</div>
			</div>

			{#snippet libEntry(item)}
				{@const tc = thumbForItem(item)}
				<div class="lib-entry">
					<div class="lib-item">
						{#if renamingKey === item.key}
							<div class="lib-load rename-form">
								<span class="preview">
									{#if tc.combined}
										<svg viewBox="0 0 {tc.combined.width} {tc.combined.height}" preserveAspectRatio="xMidYMid meet">
											{#if tc.clusterShapes}
												{#each tc.clusterShapes as cs (cs.colorIdx)}
													{#each cs.polys as p}
														<polygon points={p} fill={CLUSTER_FILLS[cs.colorIdx % CLUSTER_FILLS.length]} />
													{/each}
													{#each cs.paths as d}
														<path {d} fill="none" stroke={CLUSTER_STROKES[cs.colorIdx % CLUSTER_STROKES.length]} stroke-width="3" stroke-linejoin="round" />
													{/each}
												{/each}
											{#each tc.clusterShapes as cs (cs.colorIdx)}
												<text x={cs.cx} y={cs.cy} text-anchor="middle" dominant-baseline="middle" font-size={tc.fontSize} font-weight="bold" paint-order="stroke" stroke="white" stroke-width={tc.fontSize * 0.18} fill={CLUSTER_STROKES[cs.colorIdx % CLUSTER_STROKES.length]}>{cs.colorIdx + 1}</text>
											{/each}
											{:else}
												{#each tc.combined.polys as p}
													<polygon points={p} fill="rgba(0,166,62,0.14)" />
												{/each}
												{#each tc.combined.paths as d}
													<path {d} fill="none" stroke="#00a63e" stroke-width="3" stroke-linejoin="round" />
												{/each}
											{/if}
										</svg>
									{/if}
								</span>
								<span class="meta">
									<input
										class="name"
										bind:value={draftName}
										bind:this={renameInput}
										onkeydown={(e) => handleRenameKeydown(e, item)}
										onblur={() => commitRename(item)}
									/>
									<span class="sub">Enter saves · Esc cancels</span>
								</span>
							</div>
						{:else}
							<button class="lib-load" title="Load this shape" onclick={() => loadShape(item)}>
								<span class="preview">
									{#if tc.combined}
										<svg viewBox="0 0 {tc.combined.width} {tc.combined.height}" preserveAspectRatio="xMidYMid meet">
											{#if tc.clusterShapes}
												{#each tc.clusterShapes as cs (cs.colorIdx)}
													{#each cs.polys as p}
														<polygon points={p} fill={CLUSTER_FILLS[cs.colorIdx % CLUSTER_FILLS.length]} />
													{/each}
													{#each cs.paths as d}
														<path {d} fill="none" stroke={CLUSTER_STROKES[cs.colorIdx % CLUSTER_STROKES.length]} stroke-width="3" stroke-linejoin="round" />
													{/each}
												{/each}
											{#each tc.clusterShapes as cs (cs.colorIdx)}
												<text x={cs.cx} y={cs.cy} text-anchor="middle" dominant-baseline="middle" font-size={tc.fontSize} font-weight="bold" paint-order="stroke" stroke="white" stroke-width={tc.fontSize * 0.18} fill={CLUSTER_STROKES[cs.colorIdx % CLUSTER_STROKES.length]}>{cs.colorIdx + 1}</text>
											{/each}
											{:else}
												{#each tc.combined.polys as p}
													<polygon points={p} fill="rgba(0,166,62,0.14)" />
												{/each}
												{#each tc.combined.paths as d}
													<path {d} fill="none" stroke="#00a63e" stroke-width="3" stroke-linejoin="round" />
												{/each}
											{/if}
										</svg>
									{/if}
								</span>
								<span class="meta">
									<span class="name name-display">{item.name}</span>
									<span class="sub"
										>{item.ids.length} hexes · {item.size}px · {item.angle !== 30
											? 'flat-top'
											: 'flat-sides'}</span
									>
								</span>
							</button>
							<div class="lib-actions">
								<button class="rename" title="Rename" onclick={() => beginRename(item)}>Rename</button>
								<button
									class="coords-toggle"
									class:active={expandedKey === item.key}
									title="Show coordinates"
									onclick={() => (expandedKey = expandedKey === item.key ? null : item.key)}
								>Coords</button>
								<button class="del" title="Delete" onclick={() => deleteShape(item.key)}>Delete</button>
							</div>
							{#if folders.length > 0}
							<div class="lib-folder-row">
								<span class="folder-label">Folder</span>
								<select
									class="folder-select"
									value={item.folderId ?? ''}
									onchange={(e) => moveItemToFolder(item.key, e.currentTarget.value || null)}
								>
									<option value="">—</option>
									{#each folders as f (f.key)}
										<option value={f.key}>{f.name}</option>
									{/each}
								</select>
							</div>
							{/if}
						{/if}
					</div>
					{#if expandedKey === item.key}
						<div class="coords-panel">
							<pre class="coords-text">{formatCoords(item)}</pre>
							<button
								class="copy-btn"
								onclick={() => copyCoords(item)}
							>{copiedKey === item.key ? 'Copied!' : 'Copy'}</button>
						</div>
					{/if}
				</div>
			{/snippet}

			<div class="lib-list">
				{#if library.length === 0 && folders.length === 0}
					<p class="empty">Select hexes and save a shape to build your library.</p>
				{/if}
				{#each folders as folder (folder.key)}
					<div class="folder">
						<div class="folder-header">
							<button class="folder-toggle" onclick={() => toggleFolder(folder.key)}>
								{folder.collapsed ? '▶' : '▼'}
							</button>
							{#if renamingFolderKey === folder.key}
								<input
									class="folder-name-input"
									bind:value={draftFolderName}
									bind:this={folderRenameInput}
									onkeydown={(e) => handleFolderRenameKeydown(e, folder)}
									onblur={() => commitRenameFolder(folder)}
								/>
							{:else}
								<span class="folder-name">{folder.name} <span class="folder-count">({library.filter((i) => i.folderId === folder.key).length})</span></span>
							{/if}
							<button class="folder-btn" title="Rename folder" onclick={() => beginRenameFolder(folder)}>✎</button>
							<button class="folder-btn del" title="Delete folder" onclick={() => deleteFolder(folder.key)}>×</button>
						</div>
						{#if !folder.collapsed}
							<div class="folder-items">
								{#each library.filter((i) => i.folderId === folder.key) as item (item.key)}
									{@render libEntry(item)}
								{/each}
								{#if library.filter((i) => i.folderId === folder.key).length === 0}
									<p class="empty-folder">Empty — use the Folder selector on a shape to add it here.</p>
								{/if}
							</div>
						{/if}
					</div>
				{/each}
				{#each ungroupedItems as item (item.key)}
					{@render libEntry(item)}
				{/each}
			</div>
		</div>

		<div class="status">
			<span>{selected.size} selected</span>
			<div class="status-actions">
				<button
					onclick={() => {
						panX = originPanTarget.x;
						panY = originPanTarget.y;
					}}
					disabled={panX === originPanTarget.x && panY === originPanTarget.y}>Re-center</button
				>
				<button onclick={clear} disabled={selected.size === 0}>Clear</button>
			</div>
		</div>
		{/if}
	</aside>

	<main class="stage" bind:clientWidth={stageW} bind:clientHeight={stageH}>
		{#if stageW && stageH}
			<svg
				width={stageW}
				height={stageH}
				role="presentation"
				class:pan-mode={spaceHeld}
				class:pan-active={panActive}
				class:move-mode={moveHeld && !moveActive}
				class:move-active={moveActive}
				onpointerdown={handleSvgPointerDown}
				onpointerleave={stopPainting}
			>
				<g transform="translate({panX} {panY})">
					{#each grid as hex (hex.id)}
						{@const ci = selected.has(hex.id) ? (clusterByHexId.get(hex.id) ?? 0) : null}
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<polygon
							class="hex"
							class:selected={selected.has(hex.id)}
							class:origin={hex.id === `${originCol},${originRow}`}
							data-id={hex.id}
							points={pointsString(hex.points)}
							style={ci != null ? `fill:${CLUSTER_FILLS[ci % CLUSTER_FILLS.length]}` : ''}
							onpointerdown={(e) => startPainting(e, hex.id)}
						/>
					{/each}

					{#each selectionClusters as cluster, ci (ci)}
						{#each cluster.outlines as loop, li (li)}
							<path class="outline" d={outlinePath(loop)} style="stroke:{CLUSTER_STROKES[ci % CLUSTER_STROKES.length]}" />
						{/each}
					{/each}

					{#if selectionClusters.length > 1}
						{#each clusterCentroids as centroid, ci (ci)}
							<text
								x={centroid.cx}
								y={centroid.cy}
								text-anchor="middle"
								dominant-baseline="middle"
								font-size={size * 0.65}
								font-weight="bold"
								paint-order="stroke"
								stroke="white"
								stroke-width={size * 0.12}
								fill={CLUSTER_STROKES[ci % CLUSTER_STROKES.length]}
							>{ci + 1}</text>
						{/each}
					{/if}

					{#if ghostIds}
						{#each grid as hex (hex.id)}
							{#if ghostIds.has(hex.id)}
								<polygon
									class="hex ghost"
									points={pointsString(hex.points)}
								/>
							{/if}
						{/each}
					{/if}
				</g>
			</svg>
		{/if}
	</main>
</div>

<style>
	.app {
		display: flex;
		height: 100vh;
		width: 100vw;
		overflow: hidden;
	}

	.panel {
		flex-shrink: 0;
		padding: 24px;
		border-right: 1px solid var(--black-faint);
		display: flex;
		flex-direction: column;
		gap: 20px;
		background: var(--white);
		z-index: 1;
		position: relative;
		overflow: hidden;
	}

	.panel.collapsed {
		width: 48px;
		padding: 12px 8px;
		gap: 0;
		align-items: center;
	}

	.panel-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		flex-shrink: 0;
	}

	.panel.collapsed .panel-top {
		justify-content: center;
	}

	.collapse-btn {
		width: 24px;
		height: 24px;
		padding: 0;
		font-size: 16px;
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.resize-handle {
		position: absolute;
		right: 0;
		top: 0;
		bottom: 0;
		width: 5px;
		cursor: col-resize;
		z-index: 10;
	}

	.resize-handle:hover {
		background: var(--green-wash);
	}

	h1 {
		margin: 0;
		font-size: 20px;
		font-weight: 600;
		letter-spacing: -0.01em;
	}

	.hint {
		margin: 0;
		font-size: 13px;
		line-height: 1.5;
		color: var(--black-soft);
	}

	kbd {
		font: inherit;
		font-size: 11px;
		padding: 1px 4px;
		border: 1px solid var(--black-faint);
		border-radius: 3px;
		background: var(--white);
		color: var(--black);
	}

	.control {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.control-label {
		display: flex;
		justify-content: space-between;
		font-size: 13px;
		font-weight: 500;
	}

	.value {
		color: var(--green);
		font-variant-numeric: tabular-nums;
	}

	.value-input-wrap {
		color: var(--green);
		font-variant-numeric: tabular-nums;
		display: flex;
		align-items: baseline;
		gap: 1px;
	}

	.value-input {
		font: inherit;
		font-size: 13px;
		color: var(--green);
		background: transparent;
		border: none;
		border-bottom: 1px solid var(--green);
		padding: 0;
		width: 3ch;
		text-align: right;
		-moz-appearance: textfield;
	}

	.value-input::-webkit-outer-spin-button,
	.value-input::-webkit-inner-spin-button {
		-webkit-appearance: none;
	}

	.value-input:focus {
		outline: none;
		border-bottom-color: var(--green);
	}

	input[type='range'] {
		width: 100%;
		accent-color: var(--green);
	}

	.toggle {
		display: flex;
	}

	.toggle button {
		flex: 1;
		border-radius: 0;
	}

	.toggle button:first-child {
		border-right: none;
	}

	.toggle button.active {
		background: var(--green-wash);
		border-color: var(--green);
		color: var(--green);
	}

	.row {
		display: flex;
		gap: 8px;
	}

	.row button {
		flex: 1;
	}

	button {
		font: inherit;
		font-size: 13px;
		padding: 6px 14px;
		color: var(--black);
		background: var(--white);
		border: 1px solid var(--black-faint);
		border-radius: 0;
		cursor: pointer;
	}

	button:disabled {
		color: var(--black-faint);
		cursor: default;
	}

	button:not(:disabled):hover {
		border-color: var(--green);
		color: var(--green);
	}

	/* --- library --- */
	.library {
		display: flex;
		flex-direction: column;
		gap: 10px;
		flex: 1;
		min-height: 0;
	}

	.lib-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.lib-head-actions {
		display: flex;
		gap: 6px;
	}

	.new-folder {
		padding: 5px 10px;
	}

	.section {
		font-size: 13px;
		font-weight: 600;
	}

	.save {
		padding: 5px 10px;
	}

	.lib-list {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.empty {
		margin: 0;
		font-size: 12px;
		line-height: 1.5;
		color: var(--black-soft);
	}

	.lib-item {
		display: flex;
		flex-direction: column;
		border: 1px solid var(--black-faint);
	}

	.lib-load {
		width: 100%;
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px;
		text-align: left;
		border: none;
	}

	.lib-actions {
		display: flex;
		border-top: 1px solid var(--black-faint);
	}

	.lib-actions button {
		flex: 1;
		padding: 5px 6px;
		font-size: 12px;
		border: none;
		border-right: 1px solid var(--black-faint);
		border-radius: 0;
	}

	.lib-actions button:last-child {
		border-right: none;
	}

	.rename-form {
		border: 1px solid var(--green);
		background: var(--white);
	}

	.preview {
		width: 44px;
		height: 44px;
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		border: 1px solid var(--black-faint);
		background: var(--white);
	}

	.preview svg {
		width: 100%;
		height: 100%;
		padding: 4px;
		box-sizing: border-box;
	}

	.meta {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.name {
		font: inherit;
		font-size: 13px;
		font-weight: 500;
		color: var(--black);
		border: none;
		background: transparent;
		padding: 0;
		width: 100%;
	}

	.name:focus {
		outline: none;
		color: var(--green);
	}

	.name-display {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.sub {
		font-size: 11px;
		color: var(--black-soft);
		font-variant-numeric: tabular-nums;
	}

	.coords-toggle.active {
		color: var(--green);
	}

	/* --- folders --- */
	.folder {
		display: flex;
		flex-direction: column;
	}

	.folder-header {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 4px 2px;
		border-bottom: 1px solid var(--black-faint);
	}

	.folder-toggle {
		padding: 2px 6px;
		font-size: 10px;
		border: none;
		flex-shrink: 0;
	}

	.folder-toggle:not(:disabled):hover {
		border-color: transparent;
		background: var(--green-wash);
		color: var(--black);
	}

	.folder-name {
		flex: 1;
		font-size: 13px;
		font-weight: 500;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.folder-count {
		font-size: 11px;
		font-weight: 400;
		color: var(--black-soft);
	}

	.folder-name-input {
		flex: 1;
		font: inherit;
		font-size: 13px;
		font-weight: 500;
		border: none;
		border-bottom: 1px solid var(--green);
		background: transparent;
		padding: 0;
		min-width: 0;
		color: var(--green);
	}

	.folder-name-input:focus {
		outline: none;
	}

	.folder-btn {
		padding: 2px 6px;
		font-size: 14px;
		border: none;
		flex-shrink: 0;
	}

	.folder-btn.del {
		font-size: 16px;
	}

	.folder-items {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 6px 0 6px 12px;
	}

	.empty-folder {
		margin: 0;
		font-size: 11px;
		color: var(--black-soft);
		line-height: 1.5;
	}

	.lib-folder-row {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 3px 8px;
		border-top: 1px solid var(--black-faint);
	}

	.folder-label {
		font-size: 11px;
		color: var(--black-soft);
		flex-shrink: 0;
	}

	.folder-select {
		font: inherit;
		font-size: 11px;
		flex: 1;
		border: none;
		background: transparent;
		color: var(--black);
		padding: 1px 0;
		cursor: pointer;
		min-width: 0;
	}

	.folder-select:focus {
		outline: none;
		color: var(--green);
	}

	.coords-panel {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 8px;
		border: 1px solid var(--black-faint);
		border-top: none;
		background: rgba(0, 0, 0, 0.02);
	}

	.coords-text {
		margin: 0;
		font-family: ui-monospace, monospace;
		font-size: 11px;
		line-height: 1.5;
		color: var(--black);
		max-height: 160px;
		overflow-y: auto;
		white-space: pre;
	}

	.copy-btn {
		align-self: flex-end;
		padding: 4px 10px;
		font-size: 11px;
	}

	.status {
		display: flex;
		align-items: center;
		justify-content: space-between;
		font-size: 13px;
		color: var(--black-soft);
	}

	.status-actions {
		display: flex;
		gap: 8px;
	}

	.stage {
		flex: 1;
		position: relative;
		overflow: hidden;
		background: var(--white);
	}

	svg {
		display: block;
		touch-action: none;
		user-select: none;
	}

	svg.pan-mode,
	svg.pan-mode .hex {
		cursor: grab;
	}

	svg.pan-active,
	svg.pan-active .hex {
		cursor: grabbing;
	}

	svg.move-mode .hex.selected {
		cursor: move;
	}

	svg.move-active,
	svg.move-active .hex {
		cursor: move;
	}

	.hex {
		fill: var(--white);
		stroke: var(--black-faint);
		stroke-width: 1;
		cursor: pointer;
	}

	.hex.origin:not(.selected) {
		fill: rgba(0, 0, 0, 0.06);
	}

	.hex.selected {
		fill: var(--green-wash);
	}

	.outline {
		fill: none;
		stroke: var(--green);
		stroke-width: 3;
		stroke-linejoin: round;
		pointer-events: none;
	}

	.hex.ghost {
		fill: rgba(0, 166, 62, 0.35);
		stroke: var(--green);
		stroke-width: 2;
		stroke-dasharray: 5 3;
		pointer-events: none;
	}
</style>
