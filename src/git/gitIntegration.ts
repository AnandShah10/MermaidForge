import * as vscode from 'vscode';

/**
 * Talks to VS Code's built-in Git extension (vscode.git) via its exported
 * API rather than shelling out to `git` directly, so this works with
 * whatever Git VS Code itself is configured to use and respects the same
 * repository discovery. Git is optional: if the extension isn't installed or
 * enabled, callers get a clear "not available" result instead of an error.
 */

type GitApiResult = { ok: true; api: any } | { ok: false; reason: string };

async function getGitApi(): Promise<GitApiResult> {
  const gitExtension = vscode.extensions.getExtension('vscode.git');
  if (!gitExtension) {
    return { ok: false, reason: 'The built-in Git extension is not available.' };
  }
  const api = (gitExtension.isActive ? gitExtension.exports : await gitExtension.activate()).getAPI(1);
  if (!api) {
    return { ok: false, reason: 'Could not access the Git API.' };
  }
  return { ok: true, api };
}

type RepoResult = { ok: true; repo: any } | { ok: false; reason: string };

async function getRepoForUri(uri: vscode.Uri): Promise<RepoResult> {
  const apiResult = await getGitApi();
  if (!apiResult.ok) return apiResult;
  const repo = apiResult.api.repositories.find((r: any) => uri.fsPath.startsWith(r.rootUri.fsPath));
  if (!repo) {
    return { ok: false, reason: 'This location is not inside a Git repository VS Code recognizes.' };
  }
  return { ok: true, repo };
}

export async function getHeadRevisionContent(uri: vscode.Uri): Promise<{ ok: true; content: string } | { ok: false; reason: string }> {
  const repoResult = await getRepoForUri(uri);
  if (!repoResult.ok) return repoResult;

  try {
    const content: string = await repoResult.repo.show('HEAD', uri.fsPath);
    return { ok: true, content };
  } catch (err) {
    return { ok: false, reason: `Could not read HEAD content: ${(err as Error).message}. The file may be untracked or new.` };
  }
}

export interface GitLogCommit {
  message: string;
  authorDate: Date;
}

/**
 * Fetches commit history for the repository containing `uri` via the Git
 * extension's `Repository.log()` — the same API VS Code's own Source
 * Control view uses, so this reflects exactly what the user would see
 * there, with no separate `git` process spawned.
 */
export async function getCommitLog(uri: vscode.Uri, maxEntries: number): Promise<{ ok: true; commits: GitLogCommit[] } | { ok: false; reason: string }> {
  const repoResult = await getRepoForUri(uri);
  if (!repoResult.ok) return repoResult;

  try {
    const rawCommits: any[] = await repoResult.repo.log({ maxEntries });
    const commits: GitLogCommit[] = rawCommits
      .filter((c) => c.authorDate)
      .map((c) => ({ message: String(c.message ?? ''), authorDate: new Date(c.authorDate) }));
    if (commits.length === 0) {
      return { ok: false, reason: 'This repository has no commits yet.' };
    }
    return { ok: true, commits };
  } catch (err) {
    return { ok: false, reason: `Could not read commit history: ${(err as Error).message}` };
  }
}
