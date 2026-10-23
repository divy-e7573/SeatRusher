import { describe, expect, it } from 'vitest';
import { seatLayoutKey, showDetailKey } from '../../src/lib/redis-keys.js';

/** Pure unit test: the AGENTS.md key naming convention, locked in. */
describe('redis key naming', () => {
  it('builds the documented keys', () => {
    expect(seatLayoutKey('show-1')).toBe('seat:layout:show-1');
    expect(showDetailKey('show-1')).toBe('show:detail:show-1');
  });
});
