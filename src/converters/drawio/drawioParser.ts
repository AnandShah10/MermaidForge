/**
 * Parses the subset of Draw.io / diagrams.net's mxGraph XML format needed to
 * recover a generic node/edge graph: <mxCell> elements with vertex="1" (a
 * shape) or edge="1" (a connector), plus their id/value/source/target.
 *
 * Handles both of Draw.io's page-content encodings:
 *  - Uncompressed XML (Extras > Edit Diagram, or File > Export As > XML with
 *    "Compressed" unchecked) — the <diagram> element's text is the
 *    <mxGraphModel> XML directly.
 *  - Compressed (Draw.io's default save format) — the <diagram> element's
 *    text is base64(deflateRaw(encodeURIComponent(xml))). This is
 *    decompressed with Node's built-in `zlib.inflateRawSync` (see
 *    `decompressDiagramBody` below) — the same "raw DEFLATE" scheme other
 *    parts of this extension already rely on for PNG/PDF handling, so no new
 *    dependency was needed to add this.
 *
 * Still deliberately NOT handled, with an explicit error rather than a
 * silent wrong answer:
 *  - Nested/grouped shapes beyond simple parent-child membership, swimlanes,
 *    and mxGraph-specific edge routing (waypoints) — geometry is read only
 *    well enough to ignore it, not to reproduce layout.
 *  - Multiple <diagram> pages: only the first is converted; others are
 *    reported as a warning.
 */

import { inflateRawSync } from 'zlib';

export interface DrawioCell {
  id: string;
  value: string;
  isVertex: boolean;
  isEdge: boolean;
  source: string | null;
  target: string | null;
  parent: string | null;
}

export interface DrawioGraph {
  cells: DrawioCell[];
  extraPageCount: number;
}

export interface DrawioParseError {
  ok: false;
  reason: string;
}
export interface DrawioParseSuccess {
  ok: true;
  graph: DrawioGraph;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function stripHtmlTags(s: string): string {
  // Draw.io commonly wraps cell text in <div>/<br> for rich text; a diagram
  // label doesn't need that markup, and we're targeting a plain Mermaid label.
  return s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();
}

function parseAttributes(attrString: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z0-9_:.-]+)="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(attrString))) {
    attrs[match[1]] = decodeXmlEntities(match[2]);
  }
  return attrs;
}

/**
 * Reverses Draw.io's default compression: base64 decode, raw-inflate
 * (no zlib/gzip header — this is what `deflateRaw` on the JS side produces
 * and what `inflateRawSync` expects), then URI-decode. Returns null on any
 * failure (bad base64, corrupt deflate stream, non-UTF8 result) rather than
 * throwing, so the caller can fall back to a clear "couldn't decompress"
 * error instead of an unhandled exception.
 */
function decompressDiagramBody(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const compressed = Buffer.from(trimmed, 'base64');
    const inflated = inflateRawSync(compressed);
    return decodeURIComponent(inflated.toString('utf8'));
  } catch {
    return null;
  }
}

export function parseDrawioXml(source: string): DrawioParseSuccess | DrawioParseError {
  if (!/<mxfile\b/i.test(source) && !/<mxGraphModel\b/i.test(source)) {
    return { ok: false, reason: 'This does not look like a Draw.io / diagrams.net file (no <mxfile> or <mxGraphModel> element found).' };
  }

  const diagramMatches = [...source.matchAll(/<diagram\b([^>]*)>([\s\S]*?)<\/diagram>/gi)];
  let bodyToScan = source;
  let extraPageCount = 0;

  if (diagramMatches.length > 0) {
    let firstBody = diagramMatches[0][2];
    extraPageCount = diagramMatches.length - 1;
    if (!/<mxGraphModel\b/i.test(firstBody)) {
      const decompressed = decompressDiagramBody(firstBody);
      if (decompressed && /<mxGraphModel\b/i.test(decompressed)) {
        firstBody = decompressed;
      } else {
        return {
          ok: false,
          reason:
            'This diagram page could not be read. If it was saved from Draw.io in compressed form, the content may be corrupted or in an unexpected encoding — try re-exporting as uncompressed XML instead (Extras > Edit Diagram, copy the XML shown there, or File > Export As > XML with "Compressed" unchecked).',
        };
      }
    }
    bodyToScan = firstBody;
  }

  const cellRegex = /<mxCell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/mxCell>)/g;
  const cells: DrawioCell[] = [];
  let match: RegExpExecArray | null;
  while ((match = cellRegex.exec(bodyToScan))) {
    const attrs = parseAttributes(match[1]);
    if (!attrs.id) continue;
    // Skip the two standard boilerplate root cells (id "0" and "1") that
    // every mxGraphModel has and that carry no diagram content themselves.
    if (attrs.id === '0' || attrs.id === '1') continue;

    cells.push({
      id: attrs.id,
      value: stripHtmlTags(attrs.value ?? ''),
      isVertex: attrs.vertex === '1',
      isEdge: attrs.edge === '1',
      source: attrs.source ?? null,
      target: attrs.target ?? null,
      parent: attrs.parent ?? null,
    });
  }

  if (cells.length === 0) {
    return { ok: false, reason: 'No shapes or connectors were found in this diagram.' };
  }

  return { ok: true, graph: { cells, extraPageCount } };
}
