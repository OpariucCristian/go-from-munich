import { describe, expect, it } from 'vitest';
import { getCity } from '@gfm/core';
import { stationGroup, trainTypesFor } from '../src/explore.ts';

const muc = getCity('muc');

describe('explore helpers', () => {
  it('treats München Hbf and its Gl.27-36 EVA as one station', () => {
    expect(stationGroup(muc, '8000261')).toEqual(['8000261', '8098261']);
    expect(stationGroup(muc, '8098261')).toEqual(['8000261', '8098261']);
    expect(stationGroup(muc, '8000262')).toEqual(['8000262']);
    expect(stationGroup(muc, '8000096')).toEqual(['8000096']);
  });

  it('splits train types into long-distance and regional', () => {
    expect(trainTypesFor(muc, 'long')).toEqual(['ICE', 'IC', 'EC', 'ECE', 'RJ', 'RJX', 'NJ', 'EN', 'TGV']);
    expect(trainTypesFor(muc, 'regional')).toEqual(['RE', 'RB', 'BRB', 'ARV', 'ALX']);
    expect(trainTypesFor(muc)).toEqual(muc.trainTypes);
  });
});
