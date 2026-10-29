import { XmlNode, parseXml, findFirstElement } from './miniXmlParser';
import { parsePathData, PathSegment } from './pathDataParser';
import { IDENTITY, Matrix, isIdentity, multiplyMatrices, parseColor, parseStyleDeclarations, parseTransform, RgbColor } from './svgStyle';
import { estimateTextWidth } from './helveticaWidths';

/**
 * Converts the SVG that Mermaid produces into a PDF page content stream.
 *
 * Scope (documented in README): paths, basic shapes (incl. rounded rects),
 * text in Helvetica, solid fill/stroke colours, opacity, dashes, transforms,
 * and flattened foreignObject (HTML) labels. NOT supported: gradients,
 * patterns, filters, clip paths, embedded images, <style>/class CSS (the
 * webview inlines computed styles before export so this is not needed in
 * practice), and non-Helvetica fonts.
 */
export interface SvgPdfResult {
  contentStream: string;
  widthPt: number;
  heightPt: number;
  /** Opacity graphics states: name (GS1..) -> [fillAlpha, strokeAlpha]. */
  extGStates: Array<{ name: string; fillAlpha: number; strokeAlpha: number }>;
  warnings: string[];
}

export interface SvgPdfOptions {
  /** CSS colour painted behind the diagram; omit for a transparent page. */
  background?: string;
}

const KAPPA = 0.5522847498307936;
const SKIP = new Set(['defs', 'style', 'marker', 'clippath', 'symbol', 'title', 'desc', 'metadata', 'mask', 'pattern', 'lineargradient', 'radialgradient', 'filter', 'script']);

interface State {
  fill: string;
  stroke: string;
  strokeWidth: number;
  fillOpacity: number;
  strokeOpacity: number;
  fontSize: number;
  textAnchor: string;
  fillRule: string;
  dash: string;
  linecap: string;
  linejoin: string;
  color: string;
  markerStart: string;
  markerEnd: string;
}

const INHERITED: Array<[keyof State, string]> = [
  ['fill', 'fill'],
  ['stroke', 'stroke'],
  ['fillOpacity', 'fill-opacity'],
  ['strokeOpacity', 'stroke-opacity'],
  ['textAnchor', 'text-anchor'],
  ['fillRule', 'fill-rule'],
  ['dash', 'stroke-dasharray'],
  ['linecap', 'stroke-linecap'],
  ['linejoin', 'stroke-linejoin'],
  ['color', 'color'],
  ['markerStart', 'marker-start'],
  ['markerEnd', 'marker-end'],
];

export function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const r = Math.round(n * 10000) / 10000;
  return Object.is(r, -0) ? '0' : String(r);
}

function parseLength(v: string | undefined): number | null {
  if (!v) return null;
  const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(px|pt|em|%)?\s*$/.exec(v);
  if (!m || m[2] === '%') return null;
  const n = parseFloat(m[1]);
  if (m[2] === 'pt') return (n * 4) / 3; // 1pt = 1.333 user px; keeps relative sizes
  return n;
}

function num(v: string | undefined, fallback = 0): number {
  if (v === undefined) return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function winAnsiEscape(text: string): string {
  const CP1252: Record<string, number> = {
    '€': 0x80, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '™': 0x99,
  };
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    let b: number;
    if (CP1252[ch] !== undefined) b = CP1252[ch];
    else if (code === 0xa0) b = 0x20;
    else if (code >= 32 && code <= 255 && code !== 127) b = code;
    else b = 0x3f; // '?'
    const c = String.fromCharCode(b);
    out += c === '(' || c === ')' || c === '\\' ? '\\' + c : c;
  }
  return out;
}

class Converter {
  out: string[] = [];
  ids = new Map<string, XmlNode>();
  baseState!: State;
  markerDepth = 0;
  warnings = new Set<string>();
  gs = new Map<string, string>();
  gsList: Array<{ name: string; fillAlpha: number; strokeAlpha: number }> = [];

  gsName(fillAlpha: number, strokeAlpha: number): string {
    const key = `${fmt(fillAlpha)}|${fmt(strokeAlpha)}`;
    let name = this.gs.get(key);
    if (!name) {
      name = `GS${this.gsList.length + 1}`;
      this.gs.set(key, name);
      this.gsList.push({ name, fillAlpha, strokeAlpha });
    }
    return name;
  }

  emit(s: string): void {
    this.out.push(s);
  }

  style(node: XmlNode, parent: State): { state: State; opacity: number; hidden: boolean } {
    const decl = { ...node.attrs, ...parseStyleDeclarations(node.attrs.style) } as Record<string, string>;
    const state: State = { ...parent };
    for (const [key, attr] of INHERITED) {
      const v = decl[attr];
      if (v === undefined || v === 'inherit') continue;
      if (key === 'fillOpacity' || key === 'strokeOpacity') {
        (state as unknown as Record<string, unknown>)[key] = Math.min(1, Math.max(0, num(v, 1)));
      } else {
        (state as unknown as Record<string, unknown>)[key] = v;
      }
    }
    if (decl['stroke-width'] !== undefined) state.strokeWidth = parseLength(decl['stroke-width']) ?? state.strokeWidth;
    if (decl['font-size'] !== undefined) state.fontSize = parseLength(decl['font-size']) ?? state.fontSize;
    const opacity = decl.opacity !== undefined ? Math.min(1, Math.max(0, num(decl.opacity, 1))) : 1;
    const hidden = decl.display === 'none' || decl.visibility === 'hidden' || decl.visibility === 'collapse';
    return { state, opacity, hidden };
  }

  /** Emits colour/opacity/dash setup. Returns whether fill and stroke are active. */
  setupPaint(state: State, opacity: number): { fill: boolean; stroke: boolean } {
    const fill: RgbColor | null = parseColor(state.fill === 'currentColor' ? state.color : state.fill);
    const stroke: RgbColor | null = parseColor(state.stroke);
    const doStroke = !!stroke && state.strokeWidth > 0;
    if (!fill && !doStroke) return { fill: false, stroke: false };
    const fa = (fill ? fill.a : 1) * state.fillOpacity * opacity;
    const sa = (stroke ? stroke.a : 1) * state.strokeOpacity * opacity;
    if (fa < 1 || sa < 1) this.emit(`/${this.gsName(fa, sa)} gs`);
    if (fill) this.emit(`${fmt(fill.r)} ${fmt(fill.g)} ${fmt(fill.b)} rg`);
    if (doStroke && stroke) {
      this.emit(`${fmt(stroke.r)} ${fmt(stroke.g)} ${fmt(stroke.b)} RG`);
      this.emit(`${fmt(state.strokeWidth)} w`);
      this.emit(state.linecap === 'round' ? '1 J' : state.linecap === 'square' ? '2 J' : '0 J');
      this.emit(state.linejoin === 'round' ? '1 j' : state.linejoin === 'bevel' ? '2 j' : '0 j');
      const dashes = state.dash && state.dash !== 'none' ? state.dash.split(/[\s,]+/).map((t) => parseFloat(t)).filter((n) => Number.isFinite(n) && n >= 0) : [];
      if (dashes.length && dashes.some((d) => d > 0)) {
        const arr = dashes.length % 2 ? [...dashes, ...dashes] : dashes;
        this.emit(`[${arr.map(fmt).join(' ')}] 0 d`);
      }
    }
    return { fill: !!fill, stroke: doStroke };
  }

  paint(fill: boolean, stroke: boolean, evenOdd: boolean): void {
    if (fill && stroke) this.emit(evenOdd ? 'B*' : 'B');
    else if (fill) this.emit(evenOdd ? 'f*' : 'f');
    else if (stroke) this.emit('S');
    else this.emit('n');
  }

  drawPath(segs: PathSegment[]): void {
    for (const s of segs) {
      if (s.op === 'm') this.emit(`${fmt(s.x)} ${fmt(s.y)} m`);
      else if (s.op === 'l') this.emit(`${fmt(s.x)} ${fmt(s.y)} l`);
      else if (s.op === 'c') this.emit(`${fmt(s.x1)} ${fmt(s.y1)} ${fmt(s.x2)} ${fmt(s.y2)} ${fmt(s.x)} ${fmt(s.y)} c`);
      else this.emit('h');
    }
  }

  walk(node: XmlNode, parent: State, parentOpacity: number): void {
    const lname = node.name.toLowerCase().replace(/^svg:/, '');
    if (SKIP.has(lname)) return;
    const { state, opacity, hidden } = this.style(node, parent);
    if (hidden) return;
    const eff = parentOpacity * opacity;
    const matrix = parseTransform(node.attrs.transform);
    const transformed = !isIdentity(matrix);

    switch (lname) {
      case 'svg':
      case 'g':
      case 'a':
      case 'switch': {
        if (transformed) this.emit(`q ${matrix.map(fmt).join(' ')} cm`);
        for (const c of node.children) this.walk(c, state, eff);
        if (transformed) this.emit('Q');
        return;
      }
      case 'rect':
      case 'circle':
      case 'ellipse':
      case 'line':
      case 'polyline':
      case 'polygon':
      case 'path': {
        this.emit(`q${transformed ? ` ${matrix.map(fmt).join(' ')} cm` : ''}`);
        const effState = lname === 'line' ? { ...state, fill: 'none' } : state;
        const paintInfo = this.setupPaint(effState, eff);
        if (paintInfo.fill || paintInfo.stroke) {
          if (this.shape(lname, node)) this.paint(paintInfo.fill, paintInfo.stroke, state.fillRule === 'evenodd');
        }
        this.emit('Q');
        if (lname !== 'rect' && lname !== 'circle' && lname !== 'ellipse') this.markers(lname, node, state, eff, matrix);
        return;
      }
      case 'text': {
        this.emit(`q${transformed ? ` ${matrix.map(fmt).join(' ')} cm` : ''}`);
        this.text(node, state, eff);
        this.emit('Q');
        return;
      }
      case 'foreignobject': {
        this.emit(`q${transformed ? ` ${matrix.map(fmt).join(' ')} cm` : ''}`);
        this.foreignObject(node, state, eff);
        this.emit('Q');
        return;
      }
      case 'image':
      case 'use':
        this.warnings.add(`<${lname}> elements are not supported in vector PDF and were skipped.`);
        return;
      default:
        for (const c of node.children) this.walk(c, state, eff);
    }
  }


  /** Draws marker-start / marker-end (e.g. arrowheads) at the ends of open paths. */
  markers(name: string, node: XmlNode, state: State, opacity: number, matrix: Matrix): void {
    if (state.markerStart === 'none' && state.markerEnd === 'none') return;
    if (this.markerDepth > 2) return;
    const pts = this.endpoints(name, node);
    if (!pts) return;
    const draw = (ref: string, p: { x: number; y: number }, angle: number, isStart: boolean) => {
      const m = /url\(\s*["']?#([^"')\s]+)["']?\s*\)/.exec(ref);
      if (!m) return;
      const marker = this.ids.get(m[1]);
      if (!marker || marker.name.toLowerCase() !== 'marker') return;
      const a = marker.attrs;
      const mw = a.markerWidth !== undefined ? num(a.markerWidth, 3) : 3;
      const mh = a.markerHeight !== undefined ? num(a.markerHeight, 3) : 3;
      const vb = (a.viewBox ?? '').split(/[\s,]+/).filter(Boolean).map(Number);
      const hasVb = vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0;
      const [vbx, vby, vbw, vbh] = hasVb ? vb : [0, 0, mw, mh];
      const scale = Math.min(mw / vbw, mh / vbh);
      const orient = a.orient ?? '0';
      let rot = 0;
      if (orient === 'auto') rot = angle;
      else if (orient === 'auto-start-reverse') rot = isStart ? angle + Math.PI : angle;
      else rot = (num(orient) * Math.PI) / 180;
      const sw = a.markerUnits === 'userSpaceOnUse' ? 1 : state.strokeWidth;
      const cos = Math.cos(rot), sin = Math.sin(rot);
      const refX = num(a.refX), refY = num(a.refY);
      let mat: Matrix = [cos, sin, -sin, cos, p.x, p.y];
      mat = multiplyMatrices(mat, [sw, 0, 0, sw, 0, 0]);
      mat = multiplyMatrices(mat, [scale, 0, 0, scale, 0, 0]);
      mat = multiplyMatrices(mat, [1, 0, 0, 1, -(refX - 0) , -(refY - 0)]);
      void vbx; void vby;
      this.emit(`q${isIdentity(matrix) ? '' : ` ${matrix.map(fmt).join(' ')} cm`} ${mat.map(fmt).join(' ')} cm`);
      this.markerDepth++;
      for (const c of marker.children) this.walk(c, this.baseState, opacity);
      this.markerDepth--;
      this.emit('Q');
    };
    draw(state.markerStart, pts.start, pts.startAngle, true);
    draw(state.markerEnd, pts.end, pts.endAngle, false);
  }

  endpoints(name: string, node: XmlNode): { start: { x: number; y: number }; end: { x: number; y: number }; startAngle: number; endAngle: number } | null {
    const a = node.attrs;
    let segs: PathSegment[] = [];
    if (name === 'path') segs = parsePathData(a.d ?? '');
    else if (name === 'line') segs = [{ op: 'm', x: num(a.x1), y: num(a.y1) }, { op: 'l', x: num(a.x2), y: num(a.y2) }];
    else if (name === 'polyline' || name === 'polygon') {
      const n = (a.points ?? '').split(/[\s,]+/).filter(Boolean).map(Number);
      for (let i = 0; i + 1 < n.length; i += 2) segs.push({ op: i === 0 ? 'm' : 'l', x: n[i], y: n[i + 1] });
    }
    // Only the pen positions matter; collect them with control points.
    const pts: Array<{ x: number; y: number }> = [];
    let first: { x: number; y: number } | null = null;
    let startCtl: { x: number; y: number } | null = null;
    let endCtl: { x: number; y: number } | null = null;
    let prev: { x: number; y: number } | null = null;
    for (const sg of segs) {
      if (sg.op === 'h') continue;
      if (sg.op === 'c') {
        if (prev && !startCtl) startCtl = { x: sg.x1, y: sg.y1 };
        endCtl = { x: sg.x2, y: sg.y2 };
      } else if (sg.op === 'l') {
        if (prev && !startCtl) startCtl = { x: sg.x, y: sg.y };
        endCtl = prev;
      }
      if (!first) first = { x: sg.x, y: sg.y };
      prev = { x: sg.x, y: sg.y };
      pts.push(prev);
    }
    if (!first || !prev || pts.length < 2) return null;
    const dir = (from: { x: number; y: number } | null, to: { x: number; y: number }, fallback: { x: number; y: number }) => {
      let dx = from ? to.x - from.x : 0;
      let dy = from ? to.y - from.y : 0;
      if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) {
        dx = to.x - fallback.x;
        dy = to.y - fallback.y;
      }
      return Math.atan2(dy, dx);
    };
    const secondLast = pts[pts.length - 2];
    const second = pts[1];
    return {
      start: first,
      end: prev,
      startAngle: dir(first, startCtl ?? second, second),
      endAngle: dir(endCtl, prev, secondLast),
    };
  }

  /** Emits path construction ops; returns false if the geometry is degenerate. */
  shape(name: string, node: XmlNode): boolean {
    const a = node.attrs;
    switch (name) {
      case 'rect': {
        const x = num(a.x), y = num(a.y), w = num(a.width), h = num(a.height);
        if (w <= 0 || h <= 0) return false;
        let rx = a.rx !== undefined ? num(a.rx) : a.ry !== undefined ? num(a.ry) : 0;
        let ry = a.ry !== undefined ? num(a.ry) : rx;
        rx = Math.min(Math.max(rx, 0), w / 2);
        ry = Math.min(Math.max(ry, 0), h / 2);
        if (rx === 0 || ry === 0) {
          this.emit(`${fmt(x)} ${fmt(y)} ${fmt(w)} ${fmt(h)} re`);
          return true;
        }
        const kx = rx * KAPPA, ky = ry * KAPPA;
        const r = x + w, b = y + h;
        this.emit(`${fmt(x + rx)} ${fmt(y)} m`);
        this.emit(`${fmt(r - rx)} ${fmt(y)} l`);
        this.emit(`${fmt(r - rx + kx)} ${fmt(y)} ${fmt(r)} ${fmt(y + ry - ky)} ${fmt(r)} ${fmt(y + ry)} c`);
        this.emit(`${fmt(r)} ${fmt(b - ry)} l`);
        this.emit(`${fmt(r)} ${fmt(b - ry + ky)} ${fmt(r - rx + kx)} ${fmt(b)} ${fmt(r - rx)} ${fmt(b)} c`);
        this.emit(`${fmt(x + rx)} ${fmt(b)} l`);
        this.emit(`${fmt(x + rx - kx)} ${fmt(b)} ${fmt(x)} ${fmt(b - ry + ky)} ${fmt(x)} ${fmt(b - ry)} c`);
        this.emit(`${fmt(x)} ${fmt(y + ry)} l`);
        this.emit(`${fmt(x)} ${fmt(y + ry - ky)} ${fmt(x + rx - kx)} ${fmt(y)} ${fmt(x + rx)} ${fmt(y)} c`);
        this.emit('h');
        return true;
      }
      case 'circle': {
        const r = num(a.r);
        if (r <= 0) return false;
        this.ellipse(num(a.cx), num(a.cy), r, r);
        return true;
      }
      case 'ellipse': {
        const rx = num(a.rx), ry = num(a.ry);
        if (rx <= 0 || ry <= 0) return false;
        this.ellipse(num(a.cx), num(a.cy), rx, ry);
        return true;
      }
      case 'line': {
        this.emit(`${fmt(num(a.x1))} ${fmt(num(a.y1))} m`);
        this.emit(`${fmt(num(a.x2))} ${fmt(num(a.y2))} l`);
        return true;
      }
      case 'polyline':
      case 'polygon': {
        const nums = (a.points ?? '').split(/[\s,]+/).filter(Boolean).map(Number);
        if (nums.length < 4 || nums.some((n) => !Number.isFinite(n))) return false;
        for (let i = 0; i + 1 < nums.length; i += 2) this.emit(`${fmt(nums[i])} ${fmt(nums[i + 1])} ${i === 0 ? 'm' : 'l'}`);
        if (name === 'polygon') this.emit('h');
        return true;
      }
      case 'path': {
        const segs = parsePathData(a.d ?? '');
        if (!segs.length) return false;
        this.drawPath(segs);
        return true;
      }
    }
    return false;
  }

  ellipse(cx: number, cy: number, rx: number, ry: number): void {
    const kx = rx * KAPPA, ky = ry * KAPPA;
    this.emit(`${fmt(cx + rx)} ${fmt(cy)} m`);
    this.emit(`${fmt(cx + rx)} ${fmt(cy + ky)} ${fmt(cx + kx)} ${fmt(cy + ry)} ${fmt(cx)} ${fmt(cy + ry)} c`);
    this.emit(`${fmt(cx - kx)} ${fmt(cy + ry)} ${fmt(cx - rx)} ${fmt(cy + ky)} ${fmt(cx - rx)} ${fmt(cy)} c`);
    this.emit(`${fmt(cx - rx)} ${fmt(cy - ky)} ${fmt(cx - kx)} ${fmt(cy - ry)} ${fmt(cx)} ${fmt(cy - ry)} c`);
    this.emit(`${fmt(cx + kx)} ${fmt(cy - ry)} ${fmt(cx + rx)} ${fmt(cy - ky)} ${fmt(cx + rx)} ${fmt(cy)} c`);
    this.emit('h');
  }

  /** Draws one line of text with its baseline origin at (x, y) in y-down user space. */
  textRun(text: string, x: number, y: number, fontSize: number, anchor: string, state: State, opacity: number, colorOverride?: string): void {
    const clean = text.replace(/\s+/g, ' ');
    if (!clean.trim()) return;
    const trimmed = clean.trim();
    const width = estimateTextWidth(trimmed, fontSize);
    const startX = anchor === 'middle' ? x - width / 2 : anchor === 'end' ? x - width : x;
    const fill = parseColor(colorOverride ?? (state.fill === 'currentColor' ? state.color : state.fill));
    if (!fill) return;
    const alpha = fill.a * state.fillOpacity * opacity;
    this.emit('q');
    if (alpha < 1) this.emit(`/${this.gsName(alpha, 1)} gs`);
    this.emit(`${fmt(fill.r)} ${fmt(fill.g)} ${fmt(fill.b)} rg`);
    this.emit('BT');
    this.emit(`/F1 ${fmt(fontSize)} Tf`);
    this.emit(`1 0 0 -1 ${fmt(startX)} ${fmt(y)} Tm`);
    this.emit(`(${winAnsiEscape(trimmed)}) Tj`);
    this.emit('ET');
    this.emit('Q');
  }

  text(node: XmlNode, parent: State, opacity: number): void {
    const decl = { ...node.attrs, ...parseStyleDeclarations(node.attrs.style) } as Record<string, string>;
    const baselineShift = (n: Record<string, string>, fs: number) =>
      n['dominant-baseline'] === 'middle' || n['dominant-baseline'] === 'central' ? 0.35 * fs : n['dominant-baseline'] === 'hanging' ? 0.8 * fs : 0;
    const dyOf = (v: string | undefined, fs: number) => {
      if (!v) return 0;
      const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+))(em)?/.exec(v);
      return m ? parseFloat(m[1]) * (m[2] ? fs : 1) : 0;
    };
    const first = (v: string | undefined) => (v ? num(v.split(/[\s,]+/)[0]) : 0);

    let penX = first(decl.x) + dyOf(decl.dx, parent.fontSize);
    let penY = first(decl.y) + dyOf(decl.dy, parent.fontSize);
    const topFs = this.style(node, parent).state.fontSize;

    const emitNode = (n: XmlNode, st: State, isRoot: boolean) => {
      const { state } = this.style(n, st);
      const d = { ...n.attrs, ...parseStyleDeclarations(n.attrs.style) } as Record<string, string>;
      if (!isRoot) {
        if (d.x !== undefined) penX = first(d.x);
        if (d.y !== undefined) penY = first(d.y);
        penX += dyOf(d.dx, state.fontSize);
        penY += dyOf(d.dy, state.fontSize);
      }
      const shift = baselineShift(d['dominant-baseline'] ? d : decl, state.fontSize);
      for (const part of n.parts) {
        if (typeof part === 'string') {
          this.textRun(part, penX, penY + shift, state.fontSize, state.textAnchor, state, opacity);
          // Advance the pen only for start-anchored runs followed by more text.
          if (state.textAnchor === 'start') penX += estimateTextWidth(part.replace(/\s+/g, ' '), state.fontSize);
        } else if (part.name.toLowerCase() === 'tspan') {
          emitNode(part, state, false);
        }
      }
    };
    void topFs;
    emitNode(node, parent, true);
  }

  foreignObject(node: XmlNode, state: State, opacity: number): void {
    const x = num(node.attrs.x), y = num(node.attrs.y), w = num(node.attrs.width), h = num(node.attrs.height);
    if (w <= 0 || h <= 0) return;
    const lines: Array<{ text: string; color?: string; fontSize?: number }> = [];
    let current = '';
    let color: string | undefined;
    let fs: number | undefined;
    const flush = () => {
      if (current.trim()) lines.push({ text: current, color, fontSize: fs });
      current = '';
    };
    const BLOCK = new Set(['div', 'p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr']);
    const visit = (n: XmlNode) => {
      const name = n.name.toLowerCase().replace(/^.*:/, '');
      const d = parseStyleDeclarations(n.attrs.style);
      if (d.color) color = d.color;
      if (d['font-size']) fs = parseLength(d['font-size']) ?? fs;
      if (name === 'br') {
        flush();
        return;
      }
      const block = BLOCK.has(name);
      if (block) flush();
      for (const part of n.parts) {
        if (typeof part === 'string') current += part;
        else visit(part);
      }
      if (block) flush();
    };
    visit(node);
    flush();
    if (!lines.length) return;

    const baseFs = lines.find((l) => l.fontSize)?.fontSize ?? state.fontSize;
    const lh = baseFs * 1.2;
    const top = y + h / 2 - (lines.length * lh) / 2;
    lines.forEach((l, i) => {
      const lineFs = l.fontSize ?? baseFs;
      const baseline = top + i * lh + lh / 2 + 0.35 * lineFs;
      const text = l.text.replace(/\s+/g, ' ').trim();
      this.textRun(text, x + w / 2, baseline, lineFs, 'middle', state, opacity, l.color ?? (state.fill && state.fill !== 'none' ? undefined : '#000000'));
    });
    this.warnings.add('HTML labels (foreignObject) were flattened to single centred Helvetica lines; long labels are not re-wrapped.');
  }
}

export function svgToPdfContent(svg: string, options: SvgPdfOptions = {}): SvgPdfResult | null {
  const root = findFirstElement(parseXml(svg), 'svg');
  if (!root) return null;

  let vbx = 0, vby = 0, vbw = 0, vbh = 0;
  const vb = (root.attrs.viewBox ?? '').split(/[\s,]+/).filter(Boolean).map(Number);
  const hasVb = vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0;
  if (hasVb) [vbx, vby, vbw, vbh] = vb;

  let w = parseLength(root.attrs.width);
  let h = parseLength(root.attrs.height);
  if (hasVb) {
    if (w === null && h === null) {
      w = vbw;
      h = vbh;
    } else if (w === null) w = (h as number) * (vbw / vbh);
    else if (h === null) h = w * (vbh / vbw);
  }
  if (!w || !h || w <= 0 || h <= 0) return null;

  const conv = new Converter();
  const collect = (n: XmlNode) => {
    if (n.attrs.id) conv.ids.set(n.attrs.id, n);
    n.children.forEach(collect);
  };
  collect(root);
  const initial: State = {
    fill: '#000000',
    stroke: 'none',
    strokeWidth: 1,
    fillOpacity: 1,
    strokeOpacity: 1,
    fontSize: 16,
    textAnchor: 'start',
    fillRule: 'nonzero',
    dash: 'none',
    linecap: 'butt',
    linejoin: 'miter',
    color: '#000000',
    markerStart: 'none',
    markerEnd: 'none',
  };

  conv.baseState = initial;

  // PDF origin is bottom-left; SVG's is top-left, so flip Y once up front.
  conv.emit(`1 0 0 -1 0 ${fmt(h)} cm`);
  if (options.background) {
    const bg = parseColor(options.background);
    if (bg) {
      conv.emit(`q ${fmt(bg.r)} ${fmt(bg.g)} ${fmt(bg.b)} rg 0 0 ${fmt(w)} ${fmt(h)} re f Q`);
    }
  }
  if (hasVb) {
    const sx = w / vbw, sy = h / vbh;
    const m: Matrix = multiplyMatrices(IDENTITY, [sx, 0, 0, sy, -vbx * sx, -vby * sy]);
    if (!isIdentity(m)) conv.emit(`${m.map(fmt).join(' ')} cm`);
  }

  // The root's own style/transform are honoured by the generic walk.
  conv.walk(root, initial, 1);

  return {
    contentStream: conv.out.join('\n'),
    widthPt: w,
    heightPt: h,
    extGStates: conv.gsList,
    warnings: [...conv.warnings],
  };
}
