import { GitBranchEntry, GitCommit, GitCommitType, GitGraphDiagram, ParseIssue, SourceRange } from '../diagram/types';
import { extractFrontmatter } from './detectDiagramType';

const MAIN_BRANCH = 'main';

function stripComment(line: string): { code: string; comment: string | null } {
  const idx = line.indexOf('%%');
  if (idx === -1) return { code: line, comment: null };
  return { code: line.slice(0, idx), comment: line.slice(idx) };
}

function makeRange(lineIdx: number, startCol: number, endCol: number): SourceRange {
  return { startLine: lineIdx, startCol, endLine: lineIdx, endCol };
}

interface CommitOptions {
  id: string | null;
  tag: string | null;
  type: GitCommitType;
}

/** Extracts `id: "..."`, `tag: "..."`, and `type: NORMAL|REVERSE|HIGHLIGHT` options from the tail of a commit/merge/cherry-pick statement. */
function extractOptions(rest: string): CommitOptions {
  const idMatch = /\bid:\s*"([^"]*)"/.exec(rest);
  const tagMatch = /\btag:\s*"([^"]*)"/.exec(rest);
  const typeMatch = /\btype:\s*(NORMAL|REVERSE|HIGHLIGHT)\b/i.exec(rest);
  return {
    id: idMatch ? idMatch[1] : null,
    tag: tagMatch ? tagMatch[1] : null,
    type: (typeMatch?.[1].toUpperCase() as GitCommitType) ?? 'NORMAL',
  };
}

/**
 * Parses `gitGraph` Mermaid source into a structural model: commits (with
 * their branch, parent commit(s), optional id/tag/type), branches, and
 * cherry-picks. `branch X` both creates and checks out the new branch,
 * matching Mermaid's own documented behavior — an explicit `checkout`/
 * `switch` right after a `branch` is harmless (it's already the current
 * branch) rather than a no-op bug in either the source or this parser.
 *
 * Scope note: this models commit ancestry (parent ids, including both
 * parents of a merge commit) well enough for linting and for a future
 * Mermaid-aware feature to reason about branch structure, but it does not
 * attempt to reproduce Mermaid's own visual lane-assignment algorithm —
 * that's a rendering concern Mermaid.js itself owns, not something this
 * model needs to duplicate.
 */
export function parseGitGraph(source: string): GitGraphDiagram {
  const { frontmatter, body } = extractFrontmatter(source);
  const lines = body.split(/\r?\n/);

  const commits: GitCommit[] = [];
  const branches = new Map<string, GitBranchEntry>();
  const declarationOrder: GitGraphDiagram['declarationOrder'] = [];
  const comments: GitGraphDiagram['comments'] = [];
  const parseIssues: ParseIssue[] = [];

  let headerFound = false;
  let currentBranch = MAIN_BRANCH;
  const branchHeads = new Map<string, string | null>([[MAIN_BRANCH, null]]);
  const knownCommitIds = new Set<string>();
  let commitCounter = 0;

  branches.set(MAIN_BRANCH, { name: MAIN_BRANCH, parentBranch: null, sourceRange: null });

  function addCommit(input: {
    branch: string;
    parentIds: string[];
    options: CommitOptions;
    isMerge: boolean;
    cherryPickFrom: string | null;
    lineIdx: number;
  }): GitCommit {
    const id = input.options.id ?? `c${++commitCounter}`;
    const commit: GitCommit = {
      id,
      displayId: input.options.id,
      branch: input.branch,
      parentIds: input.parentIds,
      tag: input.options.tag,
      type: input.options.type,
      isMerge: input.isMerge,
      cherryPickFrom: input.cherryPickFrom,
      sourceRange: makeRange(input.lineIdx, 0, 0),
    };
    commits.push(commit);
    knownCommitIds.add(id);
    branchHeads.set(input.branch, id);
    declarationOrder.push({ kind: input.isMerge ? 'merge' : 'commit', id });
    return commit;
  }

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const rawLine = lines[lineIdx];
    const { code, comment } = stripComment(rawLine);
    if (comment) {
      comments.push({ text: comment.trim(), sourceRange: makeRange(lineIdx, rawLine.indexOf('%%'), rawLine.length) });
    }
    const trimmed = code.trim();
    if (trimmed.length === 0) continue;

    if (!headerFound) {
      if (/^gitGraph\b/i.test(trimmed)) {
        headerFound = true;
        continue;
      }
      if (!trimmed.startsWith('%%{')) {
        parseIssues.push({ message: 'Expected a "gitGraph" header before diagram content.', severity: 'error', range: makeRange(lineIdx, 0, trimmed.length) });
      }
      continue;
    }

    const commitMatch = /^commit\b(.*)$/i.exec(trimmed);
    if (commitMatch) {
      const options = extractOptions(commitMatch[1]);
      if (options.id && knownCommitIds.has(options.id)) {
        parseIssues.push({ message: `Commit id "${options.id}" is already used by another commit.`, severity: 'error', range: makeRange(lineIdx, 0, trimmed.length) });
        continue;
      }
      const parent = branchHeads.get(currentBranch) ?? null;
      addCommit({ branch: currentBranch, parentIds: parent ? [parent] : [], options, isMerge: false, cherryPickFrom: null, lineIdx });
      continue;
    }

    const branchMatch = /^branch\s+([A-Za-z0-9_\-./]+)/i.exec(trimmed);
    if (branchMatch) {
      const name = branchMatch[1];
      if (branches.has(name)) {
        parseIssues.push({ message: `Branch "${name}" already exists.`, severity: 'error', range: makeRange(lineIdx, 0, trimmed.length) });
        continue;
      }
      branches.set(name, { name, parentBranch: currentBranch, sourceRange: makeRange(lineIdx, 0, trimmed.length) });
      branchHeads.set(name, branchHeads.get(currentBranch) ?? null);
      currentBranch = name; // `branch` also checks it out — see module comment
      declarationOrder.push({ kind: 'branch', id: name });
      continue;
    }

    const checkoutMatch = /^(?:checkout|switch)\s+([A-Za-z0-9_\-./]+)\s*$/i.exec(trimmed);
    if (checkoutMatch) {
      const name = checkoutMatch[1];
      if (!branches.has(name)) {
        parseIssues.push({ message: `Cannot checkout unknown branch "${name}".`, severity: 'error', range: makeRange(lineIdx, 0, trimmed.length) });
        continue;
      }
      currentBranch = name;
      declarationOrder.push({ kind: 'checkout', id: name });
      continue;
    }

    const mergeMatch = /^merge\s+([A-Za-z0-9_\-./]+)(.*)$/i.exec(trimmed);
    if (mergeMatch) {
      const [, sourceBranch, rest] = mergeMatch;
      if (!branches.has(sourceBranch)) {
        parseIssues.push({ message: `Cannot merge unknown branch "${sourceBranch}".`, severity: 'error', range: makeRange(lineIdx, 0, trimmed.length) });
        continue;
      }
      const options = extractOptions(rest);
      const ownHead = branchHeads.get(currentBranch) ?? null;
      const otherHead = branchHeads.get(sourceBranch) ?? null;
      const parents = [ownHead, otherHead].filter((p): p is string => p !== null);
      addCommit({ branch: currentBranch, parentIds: parents, options, isMerge: true, cherryPickFrom: null, lineIdx });
      continue;
    }

    const cherryPickMatch = /^cherry-pick\s+(.*)$/i.exec(trimmed);
    if (cherryPickMatch) {
      const options = extractOptions(cherryPickMatch[1]);
      if (!options.id) {
        parseIssues.push({ message: 'cherry-pick requires an id: "..." naming the commit to pick.', severity: 'error', range: makeRange(lineIdx, 0, trimmed.length) });
        continue;
      }
      if (!knownCommitIds.has(options.id)) {
        parseIssues.push({ message: `cherry-pick references unknown commit id "${options.id}".`, severity: 'error', range: makeRange(lineIdx, 0, trimmed.length) });
        continue;
      }
      const parent = branchHeads.get(currentBranch) ?? null;
      addCommit({
        branch: currentBranch,
        parentIds: parent ? [parent] : [],
        options: { id: null, tag: options.tag, type: options.type },
        isMerge: false,
        cherryPickFrom: options.id,
        lineIdx,
      });
      declarationOrder[declarationOrder.length - 1] = { kind: 'cherryPick', id: declarationOrder[declarationOrder.length - 1].id };
      continue;
    }

    parseIssues.push({ message: `Unrecognized statement: "${trimmed}"`, severity: 'warning', range: makeRange(lineIdx, 0, trimmed.length) });
  }

  if (!headerFound) {
    parseIssues.push({ message: 'No "gitGraph" header found.', severity: 'error', range: makeRange(0, 0, 0) });
  }

  return { kind: 'gitGraph', commits, branches, declarationOrder, comments, frontmatter, parseIssues, sourceText: source };
}
