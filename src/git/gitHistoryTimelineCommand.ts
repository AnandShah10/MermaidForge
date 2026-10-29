import * as vscode from 'vscode';
import { getCommitLog } from './gitIntegration';
import { generateTimelineFromCommits, TimelineGrouping } from './gitHistoryTimelineGenerator';

/**
 * A cap on how many commits a single run reads from history — repositories
 * with tens of thousands of commits would otherwise produce both a slow
 * `git log` call and a diagram far too dense to read. Real, not a
 * placeholder: exceeding it truncates to the most recent N commits with a
 * visible note, rather than silently hanging or dumping everything.
 */
const MAX_COMMITS = 500;

export async function runGitHistoryTimelineCommand(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showInformationMessage('Open a folder that is a Git repository first.');
    return;
  }

  const groupingPick = await vscode.window.showQuickPick(
    [
      { label: 'By year', value: 'year' as TimelineGrouping },
      { label: 'By month', value: 'month' as TimelineGrouping },
    ],
    { placeHolder: 'Group commits by…' },
  );
  if (!groupingPick) return;

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Reading commit history…' },
    () => getCommitLog(folders[0].uri, MAX_COMMITS),
  );

  if (!result.ok) {
    vscode.window.showErrorMessage(`Could not build a timeline: ${result.reason}`);
    return;
  }

  const commits = result.commits.map((c) => ({ message: c.message, date: c.authorDate }));
  const mermaid = generateTimelineFromCommits(commits, { title: `${folders[0].name} History`, grouping: groupingPick.value });

  const doc = await vscode.workspace.openTextDocument({ language: 'mermaid', content: mermaid });
  await vscode.window.showTextDocument(doc);

  const truncated = commits.length >= MAX_COMMITS;
  vscode.window.showInformationMessage(
    `Generated a timeline from ${commits.length} commit(s)${truncated ? ` (limited to the most recent ${MAX_COMMITS})` : ''}. Review and save — nothing was written automatically.`,
  );
}
