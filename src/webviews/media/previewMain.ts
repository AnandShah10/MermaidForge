import mermaid from 'mermaid';
import { PresentationKind, applyPresentationStep, clearPresentationDimming, flowchartNodeId } from './presentation';

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

interface PresentationStepData {
  label: string;
  revealedNodeIds: string[];
}
let presentationSteps: PresentationStepData[] | null = null;
let presentationKind: PresentationKind = 'flowchart';
let presentationKnown: Set<string> = new Set();
let presentationIndex = 0;

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

async function renderDiagram(source: string, theme: string, background: string) {
  const myToken = ++renderToken;
  const errorEl = $('error-panel');
  const host = $('diagram-svg-host');
  document.body.style.background = background || 'transparent';

  try {
    // Mermaid's defaults (50k chars / 500 edges) reject the larger diagrams that "Generate From Code" can produce.
    mermaid.initialize({ startOnLoad: false, theme: (theme || 'default') as 'default', securityLevel: 'strict', maxTextSize: 1_000_000, maxEdges: 3000 });
    const id = `mermaidforge-${Date.now()}`;
    const { svg } = await mermaid.render(id, source);
    if (myToken !== renderToken) return; // a newer render started; drop this stale result
    host.innerHTML = svg;
    errorEl.style.display = 'none';
    errorEl.textContent = '';
    vscode.postMessage({ type: 'renderResult', ok: true });

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

    // A live-editing update while presentation mode is active would
    // otherwise wipe out the dimming classes we'd applied to the previous
    // render's (now-replaced) SVG nodes — reapply the current step immediately.
    if (presentationSteps) renderCurrentStep();
  } catch (err) {
    if (myToken !== renderToken) return;
    errorEl.style.display = 'block';
    errorEl.textContent = `Diagram error: ${(err as Error).message}`;
    vscode.postMessage({ type: 'renderResult', ok: false, message: (err as Error).message });
  }
}

window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg.type) {
    case 'update':
      renderDiagram(msg.source, msg.theme, msg.background);
      break;
    case 'zoomIn':
      currentZoom = Math.min(6, currentZoom * 1.2);
      applyTransform();
      break;
    case 'zoomOut':
      currentZoom = Math.max(0.1, currentZoom / 1.2);
      applyTransform();
      break;
    case 'zoomReset':
      currentZoom = 1;
      currentPanX = 0;
      currentPanY = 0;
      applyTransform();
      break;
    case 'exportRequest': {
      handleExportRequest(msg.format, msg.scale, msg.background);
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

async function handleExportRequest(format: string, scale: number, background: string): Promise<void> {
  const svgEl = document.querySelector('#diagram-svg-host svg') as SVGSVGElement | null;
  if (!svgEl) {
    vscode.postMessage({ type: 'exportData', format, ok: false, message: 'No diagram is currently rendered.' });
    return;
  }
  if (format === 'svgFlat') {
    // Used by vector PDF export: the host-side converter has no CSS engine,
    // so bake the browser's computed styles into each element first.
    try {
      vscode.postMessage({ type: 'exportData', format, ok: true, svgText: serializeWithInlinedStyles(svgEl) });
    } catch (err) {
      vscode.postMessage({ type: 'exportData', format, ok: false, message: (err as Error).message });
    }
    return;
  }

  const svgText = new XMLSerializer().serializeToString(svgEl);

  if (format === 'svg') {
    vscode.postMessage({ type: 'exportData', format, ok: true, svgText });
    return;
  }

  if (format === 'png') {
    try {
      const dataUrl = await rasterize(svgText, svgEl, scale || 2, background || 'white');
      vscode.postMessage({ type: 'exportData', format, ok: true, dataUrl });
    } catch (err) {
      vscode.postMessage({ type: 'exportData', format, ok: false, message: (err as Error).message });
    }
    return;
  }

  vscode.postMessage({ type: 'exportData', format, ok: false, message: `Export format "${format}" is not supported yet.` });
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
    const bbox = svgEl.getBBox();
    const width = Math.max(1, Math.ceil((bbox.width || svgEl.clientWidth) * scale));
    const height = Math.max(1, Math.ceil((bbox.height || svgEl.clientHeight) * scale));

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

    const img = new Image();
    const blob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      ctx.drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to rasterize SVG for PNG export.'));
    };
    img.src = url;
  });
}

// Basic pan support via drag.
let dragging = false;
let dragStartX = 0;
let dragStartY = 0;
document.addEventListener('DOMContentLoaded', () => {
  const container = $('diagram-container');
  container.addEventListener('mousedown', (e) => {
    dragging = true;
    dragStartX = e.clientX - currentPanX;
    dragStartY = e.clientY - currentPanY;
  });
  window.addEventListener('mouseup', () => (dragging = false));
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    currentPanX = e.clientX - dragStartX;
    currentPanY = e.clientY - dragStartY;
    applyTransform();
  });
  container.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    currentZoom = Math.min(6, Math.max(0.1, currentZoom * (e.deltaY < 0 ? 1.1 : 0.9)));
    applyTransform();
  });

  vscode.postMessage({ type: 'ready' });
});
