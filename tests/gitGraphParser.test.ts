import { describe, it, expect } from 'vitest';
import { parseGitGraph } from '../src/core/parser/gitGraphParser';
import { parseMermaid } from '../src/core/parser/mermaidParser';
import { isGitGraphDiagram } from '../src/core/diagram/types';

describe('parseGitGraph', () => {
  it('starts with an implicit main branch', () => {
    const diagram = parseGitGraph('gitGraph\ncommit');
    expect(diagram.branches.has('main')).toBe(true);
    expect(diagram.commits[0].branch).toBe('main');
  });

  it('chains commit parentage on a single branch', () => {
    const diagram = parseGitGraph('gitGraph\ncommit\ncommit\ncommit');
    expect(diagram.commits).toHaveLength(3);
    expect(diagram.commits[0].parentIds).toEqual([]);
    expect(diagram.commits[1].parentIds).toEqual([diagram.commits[0].id]);
    expect(diagram.commits[2].parentIds).toEqual([diagram.commits[1].id]);
  });

  it('creates and checks out a new branch with "branch"', () => {
    const diagram = parseGitGraph('gitGraph\ncommit\nbranch develop\ncommit');
    expect(diagram.branches.has('develop')).toBe(true);
    expect(diagram.commits[1].branch).toBe('develop');
    // The new branch's first commit descends from main's head at branch time.
    expect(diagram.commits[1].parentIds).toEqual([diagram.commits[0].id]);
  });

  it('switches branches explicitly with checkout/switch', () => {
    const diagram = parseGitGraph('gitGraph\nbranch develop\ncheckout main\ncommit\ncheckout develop\ncommit');
    expect(diagram.commits[0].branch).toBe('main');
    expect(diagram.commits[1].branch).toBe('develop');
  });

  it('parses explicit commit id and tag', () => {
    const diagram = parseGitGraph('gitGraph\ncommit id: "Alpha" tag: "v1.0"');
    expect(diagram.commits[0]).toMatchObject({ id: 'Alpha', displayId: 'Alpha', tag: 'v1.0' });
  });

  it('parses commit type', () => {
    const diagram = parseGitGraph('gitGraph\ncommit type: HIGHLIGHT');
    expect(diagram.commits[0].type).toBe('HIGHLIGHT');
  });

  it('creates a merge commit with two parents', () => {
    const diagram = parseGitGraph('gitGraph\ncommit\nbranch develop\ncommit\ncheckout main\nmerge develop');
    const mergeCommit = diagram.commits[diagram.commits.length - 1];
    expect(mergeCommit.isMerge).toBe(true);
    expect(mergeCommit.parentIds).toHaveLength(2);
  });

  it('parses a cherry-pick referencing a known commit id', () => {
    const diagram = parseGitGraph('gitGraph\ncommit id: "Alpha"\nbranch develop\ncherry-pick id: "Alpha"');
    const picked = diagram.commits[diagram.commits.length - 1];
    expect(picked.cherryPickFrom).toBe('Alpha');
  });

  it('flags a cherry-pick referencing an unknown commit id', () => {
    const diagram = parseGitGraph('gitGraph\ncommit\ncherry-pick id: "Nonexistent"');
    expect(diagram.parseIssues.some((i) => /unknown commit id/.test(i.message))).toBe(true);
  });

  it('flags checkout to an unknown branch', () => {
    const diagram = parseGitGraph('gitGraph\ncommit\ncheckout ghost');
    expect(diagram.parseIssues.some((i) => /unknown branch/.test(i.message))).toBe(true);
  });

  it('flags merging an unknown branch', () => {
    const diagram = parseGitGraph('gitGraph\ncommit\nmerge ghost');
    expect(diagram.parseIssues.some((i) => /unknown branch/.test(i.message))).toBe(true);
  });

  it('flags creating a branch that already exists', () => {
    const diagram = parseGitGraph('gitGraph\nbranch develop\nbranch develop');
    expect(diagram.parseIssues.some((i) => /already exists/.test(i.message))).toBe(true);
  });

  it('flags a duplicate explicit commit id', () => {
    const diagram = parseGitGraph('gitGraph\ncommit id: "A"\ncommit id: "A"');
    expect(diagram.parseIssues.some((i) => /already used/.test(i.message))).toBe(true);
  });

  it('is resilient to malformed input (no throw)', () => {
    expect(() => parseGitGraph('gitGraph\n@@@ garbage @@@\ncommit')).not.toThrow();
  });
});

describe('parseMermaid routes gitGraph to the structural parser', () => {
  it('produces a GitGraphDiagram, not the light fallback', () => {
    const diagram = parseMermaid('gitGraph\ncommit\ncommit');
    expect(isGitGraphDiagram(diagram)).toBe(true);
    if (isGitGraphDiagram(diagram)) {
      expect(diagram.commits).toHaveLength(2);
    }
  });
});
