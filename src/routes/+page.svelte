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

	/** @typedef {{ key: string, name: string, ids: string[], positions?: {column: number, row: number}[], size: number, angle: number }} LibraryItem */

	// --- settings ---
	let size = $state(44);
	let flatTop = $state(true);
	const angle = $derived(flatTop ? 0 : 30);

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

	// --- viewport (the area the grid fills) ---
	let stageW = $state(0);
	let stageH = $state(0);

	const grid = $derived(generateGrid(stageW, stageH, size, flatTop));
	const selectedHexes = $derived(grid.filter((h) => selected.has(h.id)));
	const outlines = $derived(computeOutlines(selectedHexes));
	const currentShape = $derived(
		selectedHexes.length ? buildShape(selectedHexes, outlines, 0) : null
	);

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

	$effect(() => {
		if (renamingKey && renameInput) {
			renameInput.focus();
			renameInput.select();
		}
	});

	onMount(() => {
		try {
			const stored = localStorage.getItem(LIB_KEY);
			if (stored) library = JSON.parse(stored);
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

	/** @param {LibraryItem} item @returns {string} */
	function formatCoords(item) {
		const positions = getPositions(item);
		if (!positions.length) return '[]';
		const inner = positions.map((p) => `    { column: ${p.column}, row: ${p.row} }`).join(',\n');
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
		const item = {
			key: crypto.randomUUID(),
			name: `Shape ${library.length + 1}`,
			ids,
			positions,
			size,
			angle
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

	/** @param {LibraryItem} item */
	function thumb(item) {
		const hexes = buildHexesFromIds(item.ids, item.size, item.angle !== 30);
		return buildShape(hexes, computeOutlines(hexes), 0, 6);
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
	<aside class="panel">
		<header>
			<h1>hexabounds</h1>
			<p class="hint">
				Click or drag to paint. Start on a selected hex to erase.
				<kbd>Alt</kbd>+click a selected hex to remove its connected cluster.
				Hold <kbd>Space</kbd> and drag to pan.
			</p>
		</header>

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
				<button class="save" onclick={saveShape} disabled={!selected.size}>Save shape</button>
			</div>

			<div class="lib-list">
				{#if library.length === 0}
					<p class="empty">Select hexes and save a shape to build your library.</p>
				{/if}
				{#each library as item (item.key)}
					{@const s = thumb(item)}
					<div class="lib-entry">
						<div class="lib-item">
							{#if renamingKey === item.key}
								<div class="lib-load rename-form">
									<span class="preview">
										{#if s}
											<svg viewBox="0 0 {s.width} {s.height}" preserveAspectRatio="xMidYMid meet">
												{#each s.polys as p}
													<polygon points={p} fill="rgba(0,166,62,0.14)" />
												{/each}
												{#each s.paths as d}
													<path {d} fill="none" stroke="#00a63e" stroke-width="3" stroke-linejoin="round" />
												{/each}
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
										{#if s}
											<svg viewBox="0 0 {s.width} {s.height}" preserveAspectRatio="xMidYMid meet">
												{#each s.polys as p}
													<polygon points={p} fill="rgba(0,166,62,0.14)" />
												{/each}
												{#each s.paths as d}
													<path {d} fill="none" stroke="#00a63e" stroke-width="3" stroke-linejoin="round" />
												{/each}
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
								<button class="rename" title="Rename" onclick={() => beginRename(item)}>✎</button>
							{/if}
							<button
								class="coords-toggle"
								class:active={expandedKey === item.key}
								title="Show coordinates"
								onclick={() => (expandedKey = expandedKey === item.key ? null : item.key)}
								>{'{ }'}</button
							>
							<button class="del" title="Delete" onclick={() => deleteShape(item.key)}>×</button>
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
				{/each}
			</div>
		</div>

		<div class="status">
			<span>{selected.size} selected</span>
			<div class="status-actions">
				<button
					onclick={() => {
						panX = 0;
						panY = 0;
					}}
					disabled={panX === 0 && panY === 0}>Re-center</button
				>
				<button onclick={clear} disabled={selected.size === 0}>Clear</button>
			</div>
		</div>
	</aside>

	<main class="stage" bind:clientWidth={stageW} bind:clientHeight={stageH}>
		{#if stageW && stageH}
			<svg
				width={stageW}
				height={stageH}
				role="presentation"
				class:pan-mode={spaceHeld}
				class:pan-active={panActive}
				onpointerdown={handleSvgPointerDown}
				onpointerleave={stopPainting}
			>
				<g transform="translate({panX} {panY})">
					{#each grid as hex (hex.id)}
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<polygon
							class="hex"
							class:selected={selected.has(hex.id)}
							class:origin={hex.id === '0,0'}
							data-id={hex.id}
							points={pointsString(hex.points)}
							onpointerdown={(e) => startPainting(e, hex.id)}
						/>
					{/each}

					{#each outlines as loop, i (i)}
						<path class="outline" d={outlinePath(loop)} />
					{/each}
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
		width: var(--panel-width);
		flex-shrink: 0;
		padding: 24px;
		border-right: 1px solid var(--black-faint);
		display: flex;
		flex-direction: column;
		gap: 20px;
		background: var(--white);
		z-index: 1;
	}

	header {
		display: flex;
		flex-direction: column;
		gap: 10px;
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
		align-items: stretch;
		gap: 6px;
	}

	.lib-load {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 6px;
		text-align: left;
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

	.rename,
	.del,
	.coords-toggle {
		padding: 0 10px;
		font-size: 16px;
		line-height: 1;
	}

	.coords-toggle {
		font-size: 11px;
		letter-spacing: -0.05em;
	}

	.coords-toggle.active {
		border-color: var(--green);
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
</style>
