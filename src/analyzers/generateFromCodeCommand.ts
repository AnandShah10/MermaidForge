import * as vscode from 'vscode';
import { SourceFileInput } from './analyzer';
import { AnalysisDef, LANGUAGES, LanguageDef, globForLanguage, runAnalysis } from './registry';

/**
 * A hard cap on how many files a single "generate from code" run will read
 * and parse. This is a real, deliberately small limit — not a
 * soon-to-be-removed placeholder — because this command reads whole file
 * contents into memory and parses each one; an unbounded scan on a large
 * repository would be slow and produce a diagram far too dense to read
 * anyway. If a folder has more matching files than this, the command tells
 * the user rather than silently truncating.
 */
const MAX_FILES = 300;
const EXCLUDE_GLOB = '**/{node_modules,dist,out,build,target,.git,.venv,venv,__pycache__,vendor,third_party}/**';

export async function runGenerateFromCodeCommand(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showInformationMessage('Open a folder or workspace first — code analysis needs somewhere to scan.');
    return;
  }

  const langPick = await vscode.window.showQuickPick(
    LANGUAGES.map((l) => ({ label: l.label, description: `.${l.extensions.join(' .')}`, value: l })),
    { placeHolder: 'Which language should MermaidForge analyze?' },
  );
  if (!langPick) return;
  const lang: LanguageDef = langPick.value;

  const analysisPick = await vscode.window.showQuickPick(
    lang.analyses.map((a) => ({ label: a.label, description: a.description, value: a })),
    { placeHolder: 'What should the diagram show?' },
  );
  if (!analysisPick) return;
  const analysis: AnalysisDef = analysisPick.value;

  const scopePick = await vscode.window.showQuickPick(
    [
      { label: 'Entire workspace', description: `up to ${MAX_FILES} files`, value: 'workspace' as const },
      { label: 'Choose a folder…', value: 'folder' as const },
    ],
    { placeHolder: 'What should MermaidForge scan?' },
  );
  if (!scopePick) return;

  const glob = globForLanguage(lang);
  let searchPattern = new vscode.RelativePattern(folders[0], glob);
  if (scopePick.value === 'folder') {
    const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Scan this folder' });
    if (!picked || picked.length === 0) return;
    searchPattern = new vscode.RelativePattern(picked[0], glob);
  }

  const uris = await vscode.workspace.findFiles(searchPattern, EXCLUDE_GLOB, MAX_FILES + 1);
  if (uris.length === 0) {
    vscode.window.showInformationMessage(`No ${lang.label} files (.${lang.extensions.join(' .')}) were found in that scope.`);
    return;
  }
  if (uris.length > MAX_FILES) {
    vscode.window.showWarningMessage(
      `Found more than ${MAX_FILES} matching files. Pick a smaller folder — scanning an entire large repository at once would be slow and produce an unreadable diagram.`,
    );
    return;
  }

  const files: SourceFileInput[] = [];
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Reading source files…' }, async () => {
    for (const uri of uris) {
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        files.push({ path: vscode.workspace.asRelativePath(uri, false), text: Buffer.from(bytes).toString('utf8') });
      } catch {
        // Unreadable file (permissions, binary, etc.) — skip it rather than failing the whole scan.
      }
    }
  });
  if (files.length === 0) {
    vscode.window.showWarningMessage('None of the matched files could be read.');
    return;
  }

  let outcome;
  try {
    outcome = runAnalysis(lang.id, analysis.kind, files);
  } catch (err) {
    vscode.window.showErrorMessage(`Analysis failed: ${(err as Error).message}`);
    return;
  }
  if (!outcome.mermaid) {
    vscode.window.showInformationMessage(outcome.note ?? 'Nothing to draw.');
    return;
  }
  if (outcome.note) vscode.window.showInformationMessage(outcome.note);

  const doc = await vscode.workspace.openTextDocument({ language: 'mermaid', content: outcome.mermaid });
  await vscode.window.showTextDocument(doc);
  vscode.window.showInformationMessage(`Generated from ${files.length} file(s). Review and save — nothing was written automatically.`);
}
