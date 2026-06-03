<script>
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import { SvelteSet } from 'svelte/reactivity';
	import {
		generateGrid,
		computeOutlines,
		buildHexesFromIds,
		pointsString,
		outlinePath
	} from '$lib/hex.js';
	import { buildShape, exportSvg, exportPng } from '$lib/export.js';

	const LIB_KEY = 'hexabounds:library';

	/** @typedef {{ key: string, name: string, ids: string[], size: number, angle: number }} LibraryItem */

	// --- settings ---
	let size = $state(44); // hex radius in px
	let angle = $state(0); // rotation of the whole grid, 0 = flat top/bottom

	// --- selection ---
	/** @type {SvelteSet<string>} */
	const selected = new SvelteSet();
	let painting = $state(false);
	/** @type {'add' | 'erase'} */
	let paintMode = $state('add');
	/** @type {number | null} */
	let paintPointerId = $state(null);

	// --- viewport (the area the grid fills) ---
	let stageW = $state(0);
	let stageH = $state(0);

	const grid = $derived(generateGrid(stageW, stageH, size));
	const selectedHexes = $derived(grid.filter((h) => selected.has(h.id)));
	const outlines = $derived(computeOutlines(selectedHexes));
	const currentShape = $derived(
		selectedHexes.length ? buildShape(selectedHexes, outlines, angle) : null
	);

	// --- library ---
	/** @type {LibraryItem[]} */
	let library = $state([]);
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

	/** @param {string} id */
	function applyPaint(id) {
		if (paintMode === 'add') selected.add(id);
		else selected.delete(id);
	}

	/** @param {PointerEvent} event @param {string} id */
	function startPainting(event, id) {
		if (event.isPrimary === false) return;
		if (event.pointerType === 'mouse' && event.button !== 0) return;

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
	function paintFromPointer(event) {
		if (!painting || event.pointerId !== paintPointerId) return;

		const target = document.elementFromPoint(event.clientX, event.clientY);
		if (!(target instanceof Element)) return;

		const hex = target.closest('.hex');
		if (hex instanceof SVGElement && hex.dataset.id) applyPaint(hex.dataset.id);
	}

	/** @param {PointerEvent | undefined} event */
	function stopPainting(event = undefined) {
		if (event?.pointerId != null && paintPointerId != null && event.pointerId !== paintPointerId) return;
		painting = false;
		paintPointerId = null;
	}

	function clear() {
		selected.clear();
	}

	function saveShape() {
		if (!selected.size) return;
		const item = {
			key: crypto.randomUUID(),
			name: `Shape ${library.length + 1}`,
			ids: [...selected],
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
		angle = item.angle;
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

	// A small preview shape for a library item, rebuilt from its saved ids.
	/** @param {LibraryItem} item */
	function thumb(item) {
		const hexes = buildHexesFromIds(item.ids, item.size);
		return buildShape(hexes, computeOutlines(hexes), item.angle, 6);
	}
</script>

<svelte:window
	onpointermove={paintFromPointer}
	onpointerup={stopPainting}
	onpointercancel={stopPainting}
/>

<div class="app">
	<aside class="panel">
		<header>
			<h1>hexabounds</h1>
			<p class="hint">Click or drag across hexes to paint. Start on a selected hex to erase.</p>
		</header>

		<label class="control">
			<span class="control-label">
				<span>Hex radius</span>
				<span class="value">{size}px</span>
			</span>
			<input type="range" min="16" max="120" step="1" bind:value={size} />
		</label>

		<label class="control">
			<span class="control-label">
				<span>Angle</span>
				<span class="value">{angle}°</span>
			</span>
			<input type="range" min="0" max="60" step="1" bind:value={angle} />
		</label>

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
									<span class="sub">{item.ids.length} hexes · {item.size}px · {item.angle}°</span>
								</span>
							</button>
							<button class="rename" title="Rename" onclick={() => beginRename(item)}>✎</button>
						{/if}
						<button class="del" title="Delete" onclick={() => deleteShape(item.key)}>×</button>
					</div>
				{/each}
			</div>
		</div>

		<div class="status">
			<span>{selected.size} selected</span>
			<button onclick={clear} disabled={selected.size === 0}>Clear</button>
		</div>
	</aside>

	<main class="stage" bind:clientWidth={stageW} bind:clientHeight={stageH}>
		{#if stageW && stageH}
			<svg width={stageW} height={stageH} role="presentation" onpointerleave={stopPainting}>
				<g transform="rotate({angle} {stageW / 2} {stageH / 2})">
					{#each grid as hex (hex.id)}
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<polygon
							class="hex"
							class:selected={selected.has(hex.id)}
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

	input[type='range'] {
		width: 100%;
		accent-color: var(--green);
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
	.del {
		padding: 0 10px;
		font-size: 16px;
		line-height: 1;
	}

	.status {
		display: flex;
		align-items: center;
		justify-content: space-between;
		font-size: 13px;
		color: var(--black-soft);
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

	.hex {
		fill: var(--white);
		stroke: var(--black-faint);
		stroke-width: 1;
		cursor: pointer;
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
