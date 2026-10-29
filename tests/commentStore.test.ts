import { describe, it, expect } from 'vitest';
import { CommentStore, InMemoryCommentDataStore } from '../src/comments/commentStore';
import { computeDocumentKey, edgeTargetId } from '../src/comments/documentKey';

function makeStore() {
  return new CommentStore(new InMemoryCommentDataStore());
}

describe('CommentStore', () => {
  it('starts with no comments for a document', async () => {
    const store = makeStore();
    expect(await store.listComments('docs/api.md#L0')).toEqual([]);
  });

  it('adds a comment and lists it back', async () => {
    const store = makeStore();
    const comment = await store.addComment('docs/api.md#L0', {
      targetType: 'node',
      targetId: 'PaymentService',
      author: 'Alice',
      text: 'Rename this service.',
    });
    expect(comment.id).toBeTruthy();
    expect(comment.resolved).toBe(false);
    expect(comment.createdAt).toBeTruthy();

    const listed = await store.listComments('docs/api.md#L0');
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ author: 'Alice', text: 'Rename this service.', targetId: 'PaymentService' });
  });

  it('keeps comments for different documents separate', async () => {
    const store = makeStore();
    await store.addComment('a.mmd#L0', { targetType: 'diagram', targetId: null, author: 'Alice', text: 'x' });
    await store.addComment('b.mmd#L0', { targetType: 'diagram', targetId: null, author: 'Bob', text: 'y' });
    expect(await store.listComments('a.mmd#L0')).toHaveLength(1);
    expect(await store.listComments('b.mmd#L0')).toHaveLength(1);
  });

  it('updates a comment (resolve)', async () => {
    const store = makeStore();
    const comment = await store.addComment('a.mmd#L0', { targetType: 'diagram', targetId: null, author: 'Alice', text: 'x' });
    const updated = await store.updateComment('a.mmd#L0', comment.id, { resolved: true });
    expect(updated?.resolved).toBe(true);
    const listed = await store.listComments('a.mmd#L0');
    expect(listed[0].resolved).toBe(true);
  });

  it('updates a comment (edit text)', async () => {
    const store = makeStore();
    const comment = await store.addComment('a.mmd#L0', { targetType: 'diagram', targetId: null, author: 'Alice', text: 'old' });
    await store.updateComment('a.mmd#L0', comment.id, { text: 'new' });
    const listed = await store.listComments('a.mmd#L0');
    expect(listed[0].text).toBe('new');
  });

  it('returns null when updating a comment that does not exist', async () => {
    const store = makeStore();
    expect(await store.updateComment('a.mmd#L0', 'nonexistent', { resolved: true })).toBeNull();
  });

  it('deletes a comment', async () => {
    const store = makeStore();
    const comment = await store.addComment('a.mmd#L0', { targetType: 'diagram', targetId: null, author: 'Alice', text: 'x' });
    const deleted = await store.deleteComment('a.mmd#L0', comment.id);
    expect(deleted).toBe(true);
    expect(await store.listComments('a.mmd#L0')).toEqual([]);
  });

  it('returns false when deleting a comment that does not exist', async () => {
    const store = makeStore();
    expect(await store.deleteComment('a.mmd#L0', 'nonexistent')).toBe(false);
  });

  it('preserves other comments on the same document when one is deleted', async () => {
    const store = makeStore();
    const c1 = await store.addComment('a.mmd#L0', { targetType: 'diagram', targetId: null, author: 'Alice', text: 'first' });
    await store.addComment('a.mmd#L0', { targetType: 'diagram', targetId: null, author: 'Bob', text: 'second' });
    await store.deleteComment('a.mmd#L0', c1.id);
    const listed = await store.listComments('a.mmd#L0');
    expect(listed).toHaveLength(1);
    expect(listed[0].text).toBe('second');
  });
});

describe('computeDocumentKey', () => {
  it('combines a relative path and start line', () => {
    expect(computeDocumentKey('docs/api.md', 12)).toBe('docs/api.md#L12');
  });

  it('normalizes Windows-style path separators', () => {
    expect(computeDocumentKey('docs\\api.md', 0)).toBe('docs/api.md#L0');
  });
});

describe('edgeTargetId', () => {
  it('formats a stable source→target string', () => {
    expect(edgeTargetId('A', 'B')).toBe('A→B');
  });
});
