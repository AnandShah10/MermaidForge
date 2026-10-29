import { describe, it, expect } from 'vitest';
import { generateTimelineFromCommits } from '../src/git/gitHistoryTimelineGenerator';
import { parseTimelineDiagram } from '../src/core/parser/timelineParser';

function commit(message: string, isoDate: string) {
  return { message, date: new Date(isoDate) };
}

describe('generateTimelineFromCommits', () => {
  it('groups commits by year and produces valid, parseable Mermaid', () => {
    const mermaid = generateTimelineFromCommits([
      commit('Initial release', '2025-03-01'),
      commit('Authentication', '2026-01-15'),
      commit('Dashboard', '2026-06-01'),
    ]);
    const diagram = parseTimelineDiagram(mermaid);
    expect(diagram.parseIssues.filter((i) => i.severity === 'error')).toHaveLength(0);
    expect(diagram.periods.map((p) => p.period)).toEqual(['2025', '2026']);
    expect(diagram.periods[1].events).toEqual(['Authentication', 'Dashboard']);
  });

  it('orders periods chronologically regardless of input order', () => {
    const mermaid = generateTimelineFromCommits([commit('Later', '2026-01-01'), commit('Earlier', '2024-01-01')]);
    const diagram = parseTimelineDiagram(mermaid);
    expect(diagram.periods.map((p) => p.period)).toEqual(['2024', '2026']);
  });

  it('orders events within a period oldest-first even when commits arrive newest-first', () => {
    // Callers typically fetch commits newest-first (git log default order);
    // this function sorts by actual date, so input order doesn't matter.
    const mermaid = generateTimelineFromCommits([commit('Second', '2025-06-01'), commit('First', '2025-01-01')]);
    const diagram = parseTimelineDiagram(mermaid);
    expect(diagram.periods[0].events).toEqual(['First', 'Second']);
  });

  it('groups by month when requested', () => {
    const mermaid = generateTimelineFromCommits([commit('A', '2025-01-15'), commit('B', '2025-02-15')], { grouping: 'month' });
    const diagram = parseTimelineDiagram(mermaid);
    expect(diagram.periods.map((p) => p.period)).toEqual(['Jan 2025', 'Feb 2025']);
  });

  it('includes the title', () => {
    const mermaid = generateTimelineFromCommits([commit('X', '2025-01-01')], { title: 'My Repo History' });
    const diagram = parseTimelineDiagram(mermaid);
    expect(diagram.title).toBe('My Repo History');
  });

  it('only uses the first line of a multi-line commit message', () => {
    const mermaid = generateTimelineFromCommits([commit('Fix bug\n\nLonger description here', '2025-01-01')]);
    const diagram = parseTimelineDiagram(mermaid);
    expect(diagram.periods[0].events).toEqual(['Fix bug']);
  });

  it('skips commits with an empty message rather than emitting a blank event', () => {
    const mermaid = generateTimelineFromCommits([commit('   ', '2025-01-01'), commit('Real commit', '2025-02-01')]);
    const diagram = parseTimelineDiagram(mermaid);
    expect(diagram.periods[0].events).toEqual(['Real commit']);
  });

  it('caps events per period and summarizes the overflow', () => {
    const commits = Array.from({ length: 15 }, (_, i) => commit(`Commit ${i}`, `2025-01-${String(i + 1).padStart(2, '0')}`));
    const mermaid = generateTimelineFromCommits(commits, { maxEventsPerPeriod: 5 });
    const diagram = parseTimelineDiagram(mermaid);
    expect(diagram.periods[0].events).toHaveLength(6); // 5 shown + 1 overflow summary line
    expect(diagram.periods[0].events[5]).toMatch(/\+10 more/);
  });

  it('handles a commit message containing a colon without corrupting the period/event split', () => {
    const mermaid = generateTimelineFromCommits([commit('fix: parser edge case', '2025-01-01')]);
    const diagram = parseTimelineDiagram(mermaid);
    expect(diagram.periods[0].period).toBe('2025');
    expect(diagram.periods[0].events).toEqual(['fix: parser edge case']);
  });

  it('handles a commit message containing "%%" without it being misread as a comment', () => {
    const mermaid = generateTimelineFromCommits([commit('Improve throughput by 50%% in hot path', '2025-01-01')]);
    const diagram = parseTimelineDiagram(mermaid);
    expect(diagram.periods[0].events[0]).toContain('50');
    expect(diagram.periods[0].events[0]).toContain('hot path');
  });

  it('produces an empty-but-valid diagram for no commits', () => {
    const mermaid = generateTimelineFromCommits([]);
    const diagram = parseTimelineDiagram(mermaid);
    expect(diagram.parseIssues.filter((i) => i.severity === 'error')).toHaveLength(0);
    expect(diagram.periods).toHaveLength(0);
  });
});
