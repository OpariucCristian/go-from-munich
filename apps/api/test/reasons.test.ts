import { describe, expect, it } from 'vitest';
import { reasonsOf, type MessageRow } from '../src/predict/service.ts';

const row = (over: Partial<MessageRow>): MessageRow => ({
  trip_id: '1',
  eva: '8000261',
  name: 'München Hbf',
  type: 'd',
  code: 43,
  category: null,
  at: new Date('2026-09-29T15:00:00Z'),
  ...over,
});

describe('reasonsOf', () => {
  it('keeps one entry per cause, from where it was reported last, latest first', () => {
    const r = reasonsOf([
      row({ eva: '8000013', name: 'Augsburg Hbf', at: new Date('2026-09-29T14:40:00Z') }),
      row({ at: new Date('2026-09-29T15:05:00Z') }),
      row({ code: 36, eva: '8000013', name: 'Augsburg Hbf', at: new Date('2026-09-29T14:30:00Z') }),
    ]);
    expect(r).toEqual([
      { kind: 'cause', text: 'delay of a train ahead', station: 'München Hbf', reportedAt: '2026-09-29T15:05:00.000Z', stops: 2 },
      { kind: 'cause', text: 'repairs to the train', station: 'Augsburg Hbf', reportedAt: '2026-09-29T14:30:00.000Z', stops: 1 },
    ]);
  });

  it('shows disruption and construction announcements, not plain information or unknown codes', () => {
    const r = reasonsOf([
      row({ type: 'h', code: null, category: 'Bauarbeiten' }),
      row({ type: 'h', code: null, category: 'Information' }),
      row({ code: 1 }),
    ]);
    expect(r.map((x) => [x.kind, x.text])).toEqual([['announcement', 'construction work on the line']]);
  });
});
