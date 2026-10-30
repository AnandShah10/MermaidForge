import { buildPreviewHtml } from '../src/webviews/html/previewTemplate';
import { buildStudioHtml } from '../src/webviews/html/studioTemplate';
const fake = { cspSource: 'vscode-resource:' } as never;
(globalThis as any).__tpl = (mode: string) => mode === 'studio' ? buildStudioHtml(fake, 'x.js' as never) : buildPreviewHtml(fake, 'x.js' as never, mode as never);
