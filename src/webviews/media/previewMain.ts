import mermaid from 'mermaid';
import { PresentationKind, applyPresentationStep, clearPresentationDimming, findNodeElements, flowchartNodeId } from './presentation';

/**
 * Runs inside the webview (browser context, not Node). Communicates with the
 * extension host exclusively through postMessage — no direct filesystem or
 * VS Code API access here, per VS Code webview security guidelines.
 */

declare const acquireVsCodeApi: () => { postMessage: (msg: unknown) => void; getState: () => unknown; setState: (s: unknown) => void };
const vscode = (window as any).__mermaidForgeVsCodeApi || acquireVsCodeApi();
(window as any).__mermaidForgeVsCodeApi = vscode;

let currentZoom = 1;
let currentPanX = 0;
let currentPanY = 0;
let renderToken = 0;
/** True once the user zoomed or panned by hand: automatic fit-to-view then stops moving the diagram under them. */
let userMoved = false;

/** preview | viewer | presentation | studio — set on <body> by the host's HTML. */
const MODE = document.body.dataset.mode ?? 'preview';

interface PresentationStepData {
  label: string;
  revealedNodeIds: string[];
}
let presentationSteps: PresentationStepData[] | null = null;
let presentationKind: PresentationKind = 'flowchart';
let presentationKnown: Set<string> = new Set();
let presentationIndex = 0;

let lastSource = '';
let renderedTheme = 'default';
let diagramKind = 'flowchart';

interface CommentItem {
  id: string;
  targetType: 'node' | 'edge' | 'diagram';
  targetId: string | null;
  author: string;
  text: string;
  resolved: boolean;
}
let commentItems: CommentItem[] = [];

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el;
}

function applyTransform() {
  const svgHost = document.getElementById('diagram-svg-host');
  if (svgHost) {
    svgHost.style.transform = `translate(${currentPanX}px, ${currentPanY}px) scale(${currentZoom})`;
  }
}

/** Natural (unscaled) size of the rendered diagram. */
function naturalSize(): { w: number; h: number } | null {
  const svg = document.querySelector('#diagram-svg-host svg') as SVGSVGElement | null;
  if (!svg) return null;
  const vb = svg.viewBox.baseVal;
  const w = vb && vb.width ? vb.width : parseFloat(svg.getAttribute('width') ?? '') || svg.getBoundingClientRect().width / currentZoom;
  const h = vb && vb.height ? vb.height : parseFloat(svg.getAttribute('height') ?? '') || svg.getBoundingClientRect().height / currentZoom;
  return w && h ? { w, h } : null;
}

/** Puts the diagram in the middle of the view at the current zoom. The host is positioned at the container's top-left with transform-origin 0 0, so pan is the diagram's top-left in container pixels. */
function centerView(): void {
  const container = document.getElementById('diagram-container');
  const size = naturalSize();
  if (!container || !size) return;
  currentPanX = (container.clientWidth - size.w * currentZoom) / 2;
  currentPanY = (container.clientHeight - size.h * currentZoom) / 2;
  applyTransform();
}

/** Zooms by `factor`, keeping the point (cx, cy) in container pixels fixed (default: the middle of the view). */
function zoomBy(factor: number, cx?: number, cy?: number): void {
  const container = document.getElementById('diagram-container');
  const next = Math.min(6, Math.max(0.05, currentZoom * factor));
  const ratio = next / currentZoom;
  const px = cx ?? (container ? container.clientWidth / 2 : 0);
  const py = cy ?? (container ? container.clientHeight / 2 : 0);
  currentPanX = px - (px - currentPanX) * ratio;
  currentPanY = py - (py - currentPanY) * ratio;
  currentZoom = next;
  applyTransform();
}

/** 'auto' follows the VS Code colour theme: Mermaid's dark theme on dark VS Code themes, its default theme otherwise. */
function resolveTheme(setting: string | undefined): string {
  if (setting && setting !== 'auto') return setting;
  const cls = document.body.classList;
  return cls.contains('vscode-dark') || (cls.contains('vscode-high-contrast') && !cls.contains('vscode-high-contrast-light')) ? 'dark' : 'default';
}

/** 'auto' lets the editor background show through, so the diagram never sits on a bright white slab in a dark theme. */
function resolveBackground(setting: string | undefined): string {
  return !setting || setting === 'auto' ? 'transparent' : setting;
}

/**
 * Mermaid draws its own "Syntax error" picture into the page (a temporary element appended to <body>) and, on failure,
 * leaves it there. Left alone it piles up over the real diagram and never goes away, so every render removes strays.
 */
function removeStrayMermaidElements(): void {
  document.querySelectorAll('body > [id^="dmermaidforge-"], body > [id^="mermaidforge-"], body > svg[aria-roledescription], body > div > svg[id^="mermaidforge-"]').forEach((el) => {
    if (!el.closest('#diagram-svg-host') && !el.closest('#diagram-container') && !el.closest('#mf-export-holder')) el.remove();
  });
}

function configureMermaid(theme: string, plainLabels = false): void {
  // Mermaid's defaults (50k chars / 500 edges) reject the larger diagrams that "Generate From Code" can produce.
  mermaid.initialize({
    startOnLoad: false,
    theme: theme as 'default',
    securityLevel: 'strict',
    maxTextSize: 1_000_000,
    maxEdges: 3000,
    suppressErrorRendering: true,
    ...(plainLabels ? { htmlLabels: false, flowchart: { htmlLabels: false } } : {}),
  } as Parameters<typeof mermaid.initialize>[0]);
}

function fitToView(): void {
  const container = document.getElementById('diagram-container');
  const size = naturalSize();
  if (!container || !size || container.clientWidth < 50 || container.clientHeight < 50) return;
  const maxFit = MODE === 'viewer' || MODE === 'presentation' ? 2.5 : 1.5;
  currentZoom = Math.max(0.05, Math.min(maxFit, Math.min((container.clientWidth - 32) / size.w, (container.clientHeight - 32) / size.h)));
  centerView();
}

async function renderDiagram(source: string, themeSetting: string, backgroundSetting: string) {
  const myToken = ++renderToken;
  const errorEl = $('error-panel');
  const host = $('diagram-svg-host');
  const theme = resolveTheme(themeSetting);
  const background = resolveBackground(backgroundSetting);
  document.body.style.background = background === 'transparent' ? 'var(--vscode-editor-background)' : background;

  try {
    configureMermaid(theme);
    // Parse first: a syntax error is reported without Mermaid drawing its error picture.
    await mermaid.parse(source);
    const id = `mermaidforge-${Date.now()}`;
    const { svg } = await mermaid.render(id, source);
    if (myToken !== renderToken) return; // a newer render started; drop this stale result
    host.innerHTML = svg;
    lastSource = source;
    renderedTheme = theme;
    errorEl.style.display = 'none';
    errorEl.textContent = '';
    vscode.postMessage({ type: 'renderResult', ok: true });

    // Give the SVG its natural pixel size (Mermaid emits width="100%"), so fit-to-view and export are exact.
    const svgEl = host.querySelector('svg');
    const vb = svgEl?.viewBox.baseVal;
    if (svgEl && vb && vb.width && vb.height) {
      svgEl.setAttribute('width', String(vb.width));
      svgEl.setAttribute('height', String(vb.height));
      svgEl.style.maxWidth = 'none';
    }
    if (!userMoved) fitToView();

    // Best-effort click-to-source: Mermaid gives generated SVG nodes ids like
    // `flowchart-<nodeId>-<n>` for flowchart diagrams; we extract the
    // original node id heuristically and let the extension host resolve it
    // back to a source range (it has the parsed model, we don't, here).
    host.querySelectorAll<SVGElement>('[id*="flowchart-"]').forEach((node) => {
      const nodeId = flowchartNodeId(node.id);
      if (nodeId === null) return;
      node.style.cursor = 'pointer';
      node.addEventListener('click', () => vscode.postMessage({ type: 'nodeClicked', nodeId }));
    });

    drawCommentBadges();

    // A live-editing update while presentation mode is active would
    // otherwise wipe out the dimming classes we'd applied to the previous
    // render's (now-replaced) SVG nodes — reapply the current step immediately.
    if (presentationSteps) renderCurrentStep();
  } catch (err) {
    if (myToken !== renderToken) return;
    errorEl.style.display = 'block';
    errorEl.textContent = `Diagram error: ${(err as Error).message}`;
    vscode.postMessage({ type: 'renderResult', ok: false, message: (err as Error).message });
  } finally {
    removeStrayMermaidElements();
  }
}

window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg.type) {
    case 'update':
      if (typeof msg.kind === 'string') diagramKind = msg.kind;
      renderDiagram(msg.source, msg.theme, msg.background);
      break;
    case 'comments':
      commentItems = Array.isArray(msg.items) ? msg.items : [];
      if (typeof msg.kind === 'string') diagramKind = msg.kind;
      drawCommentBadges();
      renderCommentsPopover();
      break;
    case 'zoomIn':
      userMoved = true;
      zoomBy(1.2);
      break;
    case 'zoomOut':
      userMoved = true;
      zoomBy(1 / 1.2);
      break;
    case 'zoomReset':
      userMoved = true;
      currentZoom = 1;
      centerView();
      break;
    case 'exportRequest': {
      handleExportRequest(msg.format, msg.scale, msg.background, msg.theme);
      break;
    }
    case 'presentationStart':
      startPresentation(msg.steps, msg.kind);
      break;
    case 'presentationExit':
      exitPresentation();
      break;
    default:
      break;
  }
});

function ensurePresentationBar(): HTMLElement {
  let bar = document.getElementById('presentation-bar');
  if (bar) return bar;
  bar = document.createElement('div');
  bar.id = 'presentation-bar';
  bar.style.cssText =
    'position:absolute;left:50%;bottom:16px;transform:translateX(-50%);display:flex;align-items:center;gap:10px;' +
    'background:var(--vscode-editorWidget-background,#252526);color:var(--vscode-editorWidget-foreground,#ccc);' +
    'padding:8px 14px;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,0.4);font-family:var(--vscode-font-family,sans-serif);' +
    'font-size:12px;z-index:20;';

  const prevBtn = document.createElement('button');
  prevBtn.textContent = '◀ Prev';
  prevBtn.addEventListener('click', () => goToStep(presentationIndex - 1));

  const label = document.createElement('span');
  label.id = 'presentation-label';
  label.style.cssText = 'min-width:160px;text-align:center;';

  const nextBtn = document.createElement('button');
  nextBtn.textContent = 'Next ▶';
  nextBtn.addEventListener('click', () => goToStep(presentationIndex + 1));

  const exitBtn = document.createElement('button');
  exitBtn.textContent = 'Exit';
  exitBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'presentationExitRequested' });
    exitPresentation();
  });

  for (const el of [prevBtn, label, nextBtn, exitBtn]) bar.appendChild(el);
  document.body.appendChild(bar);
  return bar;
}

function startPresentation(steps: PresentationStepData[], kind?: PresentationKind): void {
  if (!steps || steps.length === 0) {
    vscode.postMessage({ type: 'presentationResult', ok: false, message: 'This diagram has no nodes to present.' });
    return;
  }
  presentationSteps = steps;
  presentationKind = kind ?? 'flowchart';
  presentationKnown = new Set(steps.flatMap((s) => s.revealedNodeIds));
  presentationIndex = 0;
  ensurePresentationBar().style.display = 'flex';
  renderCurrentStep();
}

function exitPresentation(): void {
  presentationSteps = null;
  const bar = document.getElementById('presentation-bar');
  if (bar) bar.style.display = 'none';
  const host = document.getElementById('diagram-svg-host');
  if (host) clearPresentationDimming(host);
}

function goToStep(index: number): void {
  if (!presentationSteps) return;
  presentationIndex = Math.max(0, Math.min(presentationSteps.length - 1, index));
  renderCurrentStep();
}

function renderCurrentStep(): void {
  if (!presentationSteps) return;
  const step = presentationSteps[presentationIndex];
  const host = document.getElementById('diagram-svg-host');
  if (host) {
    const matched = applyPresentationStep(host, new Set(step.revealedNodeIds), presentationKind, presentationKnown);
    if (matched === 0) {
      // Mermaid's element ids no longer match what presentation mode expects: say so instead of showing a presentation that does nothing.
      vscode.postMessage({ type: 'presentationResult', ok: false, message: 'Presentation mode could not find this diagram\'s elements in the rendered SVG (the bundled Mermaid may use a different id scheme). Nothing was dimmed.' });
      exitPresentation();
      return;
    }
  }
  const label = document.getElementById('presentation-label');
  if (label) label.textContent = `${step.label} (${presentationIndex + 1}/${presentationSteps.length})`;
}

document.addEventListener('keydown', (e) => {
  if (!presentationSteps) return;
  if (e.key === 'ArrowRight' || e.key === ' ') {
    e.preventDefault();
    goToStep(presentationIndex + 1);
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    goToStep(presentationIndex - 1);
  } else if (e.key === 'Escape') {
    vscode.postMessage({ type: 'presentationExitRequested' });
    exitPresentation();
  }
});

/**
 * Returns the SVG to export. If the export theme differs from the live one (e.g. a dark VS Code theme but a light-theme
 * export), the diagram is re-rendered offscreen with the export theme and the live theme is restored afterwards.
 */
async function svgForExport(exportTheme: string | undefined): Promise<{ svgEl: SVGSVGElement; cleanup: () => void }> {
  const live = document.querySelector('#diagram-svg-host svg') as SVGSVGElement | null;
  if (!live) throw new Error('No diagram is currently rendered.');
  const wanted = exportTheme && exportTheme !== 'auto' ? exportTheme : renderedTheme;
  if (wanted === renderedTheme || !lastSource) return { svgEl: live, cleanup: () => undefined };

  let holder = document.getElementById('mf-export-holder');
  if (!holder) {
    holder = document.createElement('div');
    holder.id = 'mf-export-holder';
    holder.style.cssText = 'position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none;';
    document.body.appendChild(holder);
  }
  try {
    configureMermaid(wanted);
    const { svg } = await mermaid.render(`mermaidforge-export-${Date.now()}`, lastSource);
    holder.innerHTML = svg;
  } finally {
    configureMermaid(renderedTheme);
  }
  const off = holder.querySelector('svg') as SVGSVGElement | null;
  if (!off) throw new Error('Could not render the diagram with the export theme.');
  const vb = off.viewBox.baseVal;
  if (vb && vb.width && vb.height) {
    off.setAttribute('width', String(vb.width));
    off.setAttribute('height', String(vb.height));
    off.style.maxWidth = 'none';
  }
  return { svgEl: off, cleanup: () => { holder!.innerHTML = ''; removeStrayMermaidElements(); } };
}

async function handleExportRequest(format: string, scale: number, background: string, theme?: string): Promise<void> {
  let target: { svgEl: SVGSVGElement; cleanup: () => void };
  try {
    target = await svgForExport(theme);
  } catch (err) {
    vscode.postMessage({ type: 'exportData', format, ok: false, message: (err as Error).message });
    return;
  }
  const svgEl = target.svgEl;
  try {
    if (format === 'svgFlat') {
      // Used by vector PDF export: the host-side converter has no CSS engine,
      // so bake the browser's computed styles into each element first.
      vscode.postMessage({ type: 'exportData', format, ok: true, svgText: serializeWithInlinedStyles(svgEl) });
      return;
    }
    const svgText = new XMLSerializer().serializeToString(svgEl);
    if (format === 'svg') {
      vscode.postMessage({ type: 'exportData', format, ok: true, svgText });
      return;
    }
    if (format === 'png') {
      const bg = !background || background === 'auto' ? 'white' : background;
      const dataUrl = await rasterize(svgText, svgEl, scale || 2, bg);
      vscode.postMessage({ type: 'exportData', format, ok: true, dataUrl });
      return;
    }
    vscode.postMessage({ type: 'exportData', format, ok: false, message: `Export format "${format}" is not supported yet.` });
  } catch (err) {
    vscode.postMessage({ type: 'exportData', format, ok: false, message: (err as Error).message });
  } finally {
    target.cleanup();
  }
}

const INLINE_PROPS = [
  'fill', 'stroke', 'stroke-width', 'opacity', 'fill-opacity', 'stroke-opacity', 'stroke-dasharray',
  'stroke-linecap', 'stroke-linejoin', 'fill-rule', 'font-size', 'text-anchor', 'dominant-baseline',
  'display', 'visibility', 'color', 'marker-start', 'marker-end',
];

function serializeWithInlinedStyles(svgEl: SVGSVGElement): string {
  const clone = svgEl.cloneNode(true) as SVGSVGElement;
  const originals = [svgEl, ...Array.from(svgEl.querySelectorAll('*'))];
  const clones = [clone, ...Array.from(clone.querySelectorAll('*'))];
  for (let i = 0; i < originals.length && i < clones.length; i++) {
    const cs = getComputedStyle(originals[i]);
    const decls: string[] = [];
    for (const prop of INLINE_PROPS) {
      const v = cs.getPropertyValue(prop);
      if (v) decls.push(`${prop}:${v}`);
    }
    const existing = clones[i].getAttribute('style');
    // Computed values come last so they win over stale inline style text.
    clones[i].setAttribute('style', (existing ? existing + ';' : '') + decls.join(';'));
  }
  // The viewBox, not the CSS size, defines page geometry for PDF.
  clone.removeAttribute('style');
  return new XMLSerializer().serializeToString(clone);
}

function rasterize(svgText: string, svgEl: SVGSVGElement, scale: number, background: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const vb = svgEl.viewBox.baseVal;
    const natW = vb && vb.width ? vb.width : svgEl.getBBox().width || svgEl.clientWidth;
    const natH = vb && vb.height ? vb.height : svgEl.getBBox().height || svgEl.clientHeight;
    const width = Math.max(1, Math.ceil(natW * scale));
    const height = Math.max(1, Math.ceil(natH * scale));
    if (width * height > 160_000_000) {
      reject(new Error('The diagram is too large to export as PNG at this scale. Lower mermaidForge.export.scale or export SVG/PDF instead.'));
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      reject(new Error('Canvas 2D context is unavailable.'));
      return;
    }
    if (background !== 'transparent') {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, width, height);
    }

    // The <img> needs an explicit pixel size (Mermaid's own is width="100%"), and a data: URL, which is not subject to
    // blob: restrictions in the webview's Content-Security-Policy.
    const sized = svgText.replace(/<svg\b([^>]*)>/, (_m, attrs: string) => {
      const cleaned = attrs.replace(/\s(width|height)="[^"]*"/g, '');
      return `<svg${cleaned} width="${natW}" height="${natH}">`;
    });
    const img = new Image();
    img.onload = () => {
      try {
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/png'));
      } catch (err) {
        reject(new Error(`PNG export failed: the browser refused to read the drawn image (${(err as Error).message}). Export SVG or PDF instead.`));
      }
    };
    img.onerror = () => reject(new Error('Failed to rasterize SVG for PNG export (the browser could not decode the SVG). Export SVG or PDF instead.'));
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(sized);
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Comment markers

function nodeComments(): Map<string, CommentItem[]> {
  const map = new Map<string, CommentItem[]>();
  for (const c of commentItems) {
    if (c.targetType !== 'node' || !c.targetId) continue;
    const list = map.get(c.targetId) ?? [];
    list.push(c);
    map.set(c.targetId, list);
  }
  return map;
}

function drawCommentBadges(): void {
  const host = document.getElementById('diagram-svg-host');
  if (!host) return;
  host.querySelectorAll('g.mf-badge').forEach((el) => el.remove());
  const byNode = nodeComments();
  if (byNode.size === 0) return;
  const kind = (diagramKind === 'flowchart' || diagramKind === 'graph' ? 'flowchart' : diagramKind) as PresentationKind;
  let found: Map<string, Element>;
  try {
    found = findNodeElements(host, kind, new Set(byNode.keys()));
  } catch {
    return;
  }
  const NS = 'http://www.w3.org/2000/svg';
  for (const [nodeId, list] of byNode) {
    const el = found.get(nodeId);
    if (!el || !(el as SVGGraphicsElement).getBBox) continue;
    const box = (el as SVGGraphicsElement).getBBox();
    const open = list.filter((c) => !c.resolved).length;
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', 'mf-badge' + (open === 0 ? ' mf-resolved' : ''));
    g.setAttribute('transform', `translate(${box.x + box.width}, ${box.y})`);
    const circle = document.createElementNS(NS, 'circle');
    circle.setAttribute('r', '9');
    const text = document.createElementNS(NS, 'text');
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dy', '3.5');
    text.textContent = String(list.length);
    const title = document.createElementNS(NS, 'title');
    title.textContent = list.map((c) => `${c.author}${c.resolved ? ' (resolved)' : ''}: ${c.text}`).join('\n');
    g.append(circle, text, title);
    g.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePopover(true);
    });
    // Badge goes into the node's own group (so it shares its coordinate space); shapes like <rect> cannot have children.
    const parent = el.tagName.toLowerCase() === 'g' ? el : el.parentNode;
    if (parent && parent !== el) {
      // getBBox is in the element's own space; a rect's parent group shares it unless transformed, which Mermaid does not do for actors.
    }
    (parent ?? el).appendChild(g);
  }
}

function renderCommentsPopover(): void {
  const pop = document.getElementById('mf-comments-popover');
  const count = document.getElementById('mf-comment-count');
  if (count) count.textContent = commentItems.length ? String(commentItems.length) : '';
  if (!pop) return;
  pop.textContent = '';
  const head = document.createElement('div');
  head.style.fontWeight = '600';
  head.textContent = commentItems.length ? `Comments (${commentItems.length})` : 'No comments on this diagram yet';
  pop.appendChild(head);
  for (const c of commentItems) {
    const row = document.createElement('div');
    row.className = 'mf-comment' + (c.resolved ? ' resolved' : '');
    const where = c.targetType === 'diagram' ? 'Diagram' : `${c.targetType === 'node' ? 'Node' : 'Edge'} ${c.targetId ?? ''}`;
    const head2 = document.createElement('b');
    head2.textContent = where;
    const meta = document.createElement('small');
    meta.textContent = `${c.author}${c.resolved ? ' · resolved' : ''}`;
    const body = document.createElement('div');
    body.textContent = c.text;
    row.append(head2, meta, body);
    if (c.targetType === 'node' && c.targetId) {
      row.addEventListener('click', () => pulseNode(c.targetId!));
    }
    pop.appendChild(row);
  }
}

function pulseNode(nodeId: string): void {
  const host = document.getElementById('diagram-svg-host');
  if (!host) return;
  const kind = (diagramKind === 'graph' ? 'flowchart' : diagramKind) as PresentationKind;
  try {
    const el = findNodeElements(host, kind, new Set([nodeId])).get(nodeId);
    if (el) {
      el.classList.add('mf-comment-focus');
      setTimeout(() => el.classList.remove('mf-comment-focus'), 1600);
    }
  } catch {
    /* best effort */
  }
}

function togglePopover(force?: boolean): void {
  const pop = document.getElementById('mf-comments-popover');
  if (!pop) return;
  pop.classList.toggle('open', force ?? !pop.classList.contains('open'));
}

// ---------------------------------------------------------------------------------------------------------------
// Toolbar

function toolbarAction(action: string, format?: string): void {
  vscode.postMessage({ type: 'toolbar', action, format });
}

function button(label: string, title: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.title = title;
  if (cls) b.className = cls;
  b.addEventListener('click', onClick);
  return b;
}

function buildToolbar(): void {
  const bar = document.getElementById('mf-toolbar');
  if (!bar) return;
  bar.textContent = '';
  const left = document.createDocumentFragment();
  const right = document.createDocumentFragment();
  const spacer = document.createElement('div');
  spacer.className = 'mf-spacer';

  if (MODE === 'viewer' || MODE === 'presentation') {
    left.appendChild(button('← Return to code', 'Close this view and go back to the Mermaid source', () => toolbarAction('returnToCode'), 'mf-primary'));
  }
  if (MODE !== 'viewer') left.appendChild(button('Viewer', 'Open the diagram on its own, in place of the code', () => toolbarAction('openViewer')));
  if (MODE !== 'presentation') left.appendChild(button('Present', 'Step through the diagram node by node', () => toolbarAction('present')));
  if (MODE !== 'studio') left.appendChild(button('Studio', 'Open Mermaid Studio: complexity, problems and comments next to the diagram', () => toolbarAction('studio')));
  if (MODE !== 'preview' && MODE !== 'studio') left.appendChild(button('Preview', 'Open the side-by-side live preview', () => toolbarAction('openPreview')));

  // Export menu
  const wrap = document.createElement('div');
  wrap.className = 'mf-menu';
  const menu = document.createElement('div');
  menu.className = 'mf-menu-list';
  for (const f of ['svg', 'png', 'pdf']) {
    menu.appendChild(button(f.toUpperCase(), `Export as ${f.toUpperCase()}`, () => { wrap.classList.remove('open'); toolbarAction('export', f); }));
  }
  const exportBtn = button('Export ▾', 'Export the diagram', () => { wrap.classList.toggle('open'); });
  wrap.append(exportBtn, menu);
  left.appendChild(wrap);

  right.appendChild(button('Comment', 'Add a comment to a node, edge or the diagram', () => toolbarAction('comment')));
  const cc = button('💬', 'Show comments', () => togglePopover());
  const badge = document.createElement('span');
  badge.id = 'mf-comment-count';
  cc.appendChild(badge);
  right.appendChild(cc);
  right.appendChild(button('−', 'Zoom out', () => { userMoved = true; zoomBy(1 / 1.2); }));
  right.appendChild(button('Fit', 'Fit the diagram to the window', () => { userMoved = false; fitToView(); }));
  right.appendChild(button('+', 'Zoom in', () => { userMoved = true; zoomBy(1.2); }));
  bar.append(left, spacer, right);

  let pop = document.getElementById('mf-comments-popover');
  if (!pop) {
    pop = document.createElement('div');
    pop.id = 'mf-comments-popover';
    document.body.appendChild(pop);
  }
  renderCommentsPopover();
  document.addEventListener('click', (e) => {
    if (!(e.target as Element).closest('.mf-menu')) wrap.classList.remove('open');
  });
}

// Basic pan support via drag.
let dragging = false;
let dragStartX = 0;
let dragStartY = 0;
document.addEventListener('DOMContentLoaded', () => {
  const container = $('diagram-container');
  buildToolbar();
  container.addEventListener('mousedown', (e) => {
    dragging = true;
    dragStartX = e.clientX - currentPanX;
    dragStartY = e.clientY - currentPanY;
  });
  window.addEventListener('mouseup', () => (dragging = false));
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    userMoved = true;
    currentPanX = e.clientX - dragStartX;
    currentPanY = e.clientY - dragStartY;
    applyTransform();
  });
  container.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    userMoved = true;
    const box = container.getBoundingClientRect();
    zoomBy(e.deltaY < 0 ? 1.1 : 0.9, e.clientX - box.left, e.clientY - box.top);
  });
  // A view opened in a background tab has no size yet; ResizeObserver fits it once it is actually shown.
  new ResizeObserver(() => { if (!userMoved) fitToView(); }).observe(container);

  vscode.postMessage({ type: 'ready' });
});
