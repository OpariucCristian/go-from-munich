import { describe, expect, it } from 'vitest';
import { pickFeatured } from '../src/featured.ts';

const onTime = [0.8, 0.1, 0.05, 0.02, 0.01, 0.01, 0, 0.01];
const late = [0.2, 0.1, 0.2, 0.2, 0.2, 0.05, 0.03, 0.02];

describe('pickFeatured', () => {
  it('picks the largest expected delay', () => {
    const best = pickFeatured([
      { id: 'a', dist: onTime },
      { id: 'b', dist: late },
    ]);
    expect(best?.id).toBe('b');
    expect(best!.expected).toBeGreaterThan(5);
    expect(best!.lateOver5).toBeCloseTo(0.7, 6);
  });

  it('returns null when there is nothing to feature', () => {
    expect(pickFeatured([])).toBeNull();
  });
});
