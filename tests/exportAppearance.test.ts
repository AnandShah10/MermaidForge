import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { resolveExportAppearance } from '../src/rendering/exporter';

describe('resolveExportAppearance', () => {
  it('turns the "auto" settings into a light theme on white for exported files', () => {
    expect(resolveExportAppearance('auto', 'auto')).toEqual({ theme: 'default', background: 'white' });
    expect(resolveExportAppearance(undefined, undefined)).toEqual({ theme: 'default', background: 'white' });
  });
  it('honours explicit settings', () => {
    expect(resolveExportAppearance('dark', 'transparent')).toEqual({ theme: 'dark', background: 'transparent' });
  });
});
