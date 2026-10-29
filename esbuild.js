// Minimal esbuild build script for the extension host bundle.
// The webview UI (media/*.js) is plain JS/CSS and is copied as-is, not bundled,
// to keep the webview lightweight and CSP-friendly (no eval, no dynamic import).
const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

async function main() {
  const extensionCtx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    logLevel: 'info',
  });

  // Separate browser-target bundle for the webview (live preview / Studio).
  // Bundling mermaid here — rather than loading it from a CDN inside the
  // webview — keeps the extension fully functional offline and avoids
  // relaxing the webview's Content-Security-Policy to allow remote scripts.
  const webviewCtx = await esbuild.context({
    entryPoints: ['src/webviews/media/previewMain.ts'],
    bundle: true,
    format: 'iife',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'browser',
    outfile: 'dist/webview/previewMain.js',
    logLevel: 'info',
  });

  if (watch) {
    await extensionCtx.watch();
    await webviewCtx.watch();
  } else {
    await extensionCtx.rebuild();
    await webviewCtx.rebuild();
    await extensionCtx.dispose();
    await webviewCtx.dispose();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
