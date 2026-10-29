import * as vscode from 'vscode';
import { PreviewPanel } from '../webviews/previewPanel';
import { pngDataUrlToPdf } from './pdfExport';
import { svgToPdfContent } from './svg/svgToPdf';
import { buildSinglePageVectorPdf } from './pdfWriter';

const SUPPORTED_FORMATS = ['svg', 'png', 'pdf'] as const;
type SupportedFormat = (typeof SUPPORTED_FORMATS)[number];

/**
 * PDF export is vector-first: the webview inlines computed styles into the
 * rendered SVG, svgToPdf converts it to PDF drawing operators (real paths and
 * selectable Helvetica text), and pdfWriter wraps it. If conversion fails or
 * the SVG is unusable, it falls back to the raster path (PNG embedded in a
 * PDF) with a visible warning. Documented limits: gradients, filters, images,
 * clip paths and non-Helvetica fonts are not carried into the vector PDF.
 */
export async function exportPdf(
  preview: PreviewPanel,
  scale: number,
  background: string,
): Promise<{ bytes: Buffer; mode: 'vector' | 'raster'; warnings: string[] }> {
  const flat = await preview.exportDiagram('svgFlat', scale, background);
  if (flat.ok && flat.svgText) {
    try {
      const converted = svgToPdfContent(flat.svgText, { background });
      if (converted) {
        const bytes = buildSinglePageVectorPdf({
          widthPt: converted.widthPt,
          heightPt: converted.heightPt,
          contentStream: converted.contentStream,
          extGStates: converted.extGStates,
        });
        return { bytes, mode: 'vector', warnings: converted.warnings };
      }
    } catch {
      // fall through to raster
    }
  }
  const png = await preview.exportDiagram('png', scale, background);
  if (!png.ok || !png.dataUrl) {
    throw new Error(png.message ?? flat.message ?? 'unknown error');
  }
  return {
    bytes: pngDataUrlToPdf(png.dataUrl),
    mode: 'raster',
    warnings: ['Vector conversion was not possible for this diagram; the PDF contains a raster image instead.'],
  };
}

export async function runExportCommand(preview: PreviewPanel): Promise<void> {
  const config = vscode.workspace.getConfiguration('mermaidForge');
  const defaultFormat = (config.get<string>('export.defaultFormat') ?? 'svg') as string;

  const pick = await vscode.window.showQuickPick(
    [
      { label: 'SVG', description: 'Vector, best fidelity', value: 'svg' },
      { label: 'PNG', description: 'Raster image', value: 'png' },
      { label: 'PDF', description: 'Single-page vector PDF (raster fallback — see README)', value: 'pdf' },
    ],
    { placeHolder: `Export format (default: ${defaultFormat})` },
  );
  if (!pick) return;

  const format = pick.value as SupportedFormat;
  if (!preview.isOpen) {
    preview.reveal();
    preview.updateNow();
    await new Promise((r) => setTimeout(r, 400)); // let mermaid finish its first render
  }

  const scale = config.get<number>('export.scale') ?? 2;
  const background = config.get<string>('preview.background') ?? 'white';

  let pdf: Awaited<ReturnType<typeof exportPdf>> | undefined;
  let result: Awaited<ReturnType<PreviewPanel['exportDiagram']>> | undefined;
  try {
    if (format === 'pdf') pdf = await exportPdf(preview, scale, background);
    else {
      result = await preview.exportDiagram(format, scale, background);
      if (!result.ok) throw new Error(result.message ?? 'unknown error');
    }
  } catch (err) {
    vscode.window.showErrorMessage(`Export failed: ${(err as Error).message}`);
    return;
  }

  const defaultUri = vscode.workspace.workspaceFolders?.[0]
    ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, `diagram.${format}`)
    : undefined;
  const saveUri = await vscode.window.showSaveDialog({
    defaultUri,
    filters:
      format === 'svg' ? { 'SVG Image': ['svg'] } : format === 'pdf' ? { 'PDF Document': ['pdf'] } : { 'PNG Image': ['png'] },
  });
  if (!saveUri) return;

  try {
    if (pdf) {
      await vscode.workspace.fs.writeFile(saveUri, pdf.bytes);
    } else if (format === 'svg' && result?.svgText) {
      await vscode.workspace.fs.writeFile(saveUri, Buffer.from(result.svgText, 'utf8'));
    } else if (format === 'png' && result?.dataUrl) {
      const base64 = result.dataUrl.split(',')[1] ?? '';
      await vscode.workspace.fs.writeFile(saveUri, Buffer.from(base64, 'base64'));
    } else {
      throw new Error('Export produced no data.');
    }
    const where = vscode.workspace.asRelativePath(saveUri);
    if (pdf && (pdf.mode === 'raster' || pdf.warnings.length)) {
      vscode.window.showWarningMessage(`Exported ${where} (${pdf.mode} PDF). ${pdf.warnings.join(' ')}`);
    } else {
      vscode.window.showInformationMessage(`Exported diagram to ${where}${pdf ? ' (vector PDF)' : ''}.`);
    }
  } catch (err) {
    vscode.window.showErrorMessage(`Could not write export file: ${(err as Error).message}`);
  }
}
