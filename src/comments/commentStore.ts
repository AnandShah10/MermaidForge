import { CommentBackend, CommentUpdate, DiagramComment, NewCommentInput } from './types';

/**
 * Storage abstraction the CommentStore reads/writes through — deliberately
 * just "give me the whole map, take the whole map back", so a JSON-file
 * implementation (vscodeFileStore.ts) and an in-memory one (used in tests
 * and as a graceful fallback when there's no workspace folder to write to)
 * both satisfy it trivially.
 */
export interface CommentDataStore {
  read(): Promise<Record<string, DiagramComment[]>>;
  write(data: Record<string, DiagramComment[]>): Promise<void>;
}

let idCounter = 0;
function generateId(): string {
  idCounter += 1;
  return `c_${Date.now().toString(36)}_${idCounter}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The one `CommentBackend` implementation this project ships: local
 * storage via whatever `CommentDataStore` it's given. All the actual
 * add/update/delete/list logic lives here, independent of *where* the data
 * ends up — that's the whole point of the split, and it's what makes this
 * class unit-testable with a plain in-memory store instead of a real
 * workspace file.
 */
export class CommentStore implements CommentBackend {
  constructor(private readonly dataStore: CommentDataStore) {}

  async listComments(documentKey: string): Promise<DiagramComment[]> {
    const data = await this.dataStore.read();
    return data[documentKey] ?? [];
  }

  async addComment(documentKey: string, input: NewCommentInput): Promise<DiagramComment> {
    const comment: DiagramComment = {
      id: generateId(),
      targetType: input.targetType,
      targetId: input.targetId,
      author: input.author,
      text: input.text,
      createdAt: new Date().toISOString(),
      resolved: false,
    };
    const data = await this.dataStore.read();
    const existing = data[documentKey] ?? [];
    data[documentKey] = [...existing, comment];
    await this.dataStore.write(data);
    return comment;
  }

  async updateComment(documentKey: string, commentId: string, patch: CommentUpdate): Promise<DiagramComment | null> {
    const data = await this.dataStore.read();
    const existing = data[documentKey] ?? [];
    const idx = existing.findIndex((c) => c.id === commentId);
    if (idx === -1) return null;
    const updated: DiagramComment = { ...existing[idx], ...patch };
    const newList = [...existing];
    newList[idx] = updated;
    data[documentKey] = newList;
    await this.dataStore.write(data);
    return updated;
  }

  async deleteComment(documentKey: string, commentId: string): Promise<boolean> {
    const data = await this.dataStore.read();
    const existing = data[documentKey] ?? [];
    const filtered = existing.filter((c) => c.id !== commentId);
    if (filtered.length === existing.length) return false;
    data[documentKey] = filtered;
    await this.dataStore.write(data);
    return true;
  }
}

/** In-memory `CommentDataStore` — used directly in tests, and as the runtime fallback when no workspace folder is open to persist a file to (see vscodeFileStore.ts). */
export class InMemoryCommentDataStore implements CommentDataStore {
  private data: Record<string, DiagramComment[]> = {};

  async read(): Promise<Record<string, DiagramComment[]>> {
    // Return a shallow copy so callers mutating the result (as CommentStore
    // does) never corrupts this store's internal state except through write().
    return { ...this.data };
  }

  async write(data: Record<string, DiagramComment[]>): Promise<void> {
    this.data = { ...data };
  }
}
