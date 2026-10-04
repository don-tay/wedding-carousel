import { describe, expect, it } from 'vitest';
import { adopt, CONFLICT_COPY, mergeConfigs, parseConfig, serializeConfig } from '../../src/config';
import { DEFAULTS } from '../../src/settings';

describe('settings file', () => {
  it('round-trips settings and photo choices', () => {
    const s = { ...DEFAULTS, title: 'Don & Pamela', font: 'flowing' as const, seed: 99, titleColor: '#aa8877' };
    const text = serializeConfig(s, { 'a.jpg|10': { featured: true }, 'b.jpg|20': { hidden: true }, 'c.jpg|1': {} });
    const back = parseConfig(text);
    expect(back.settings).toEqual(s);
    expect(back.photos).toEqual({ 'a.jpg|10': { featured: true }, 'b.jpg|20': { hidden: true } });
  });

  it('ignores invalid or unknown values instead of failing', () => {
    const back = parseConfig(
      JSON.stringify({ settings: { title: 5, font: 'comic', secondsPerScreen: 30, evil: 1 }, photos: { 'x|1': { featured: 'yes', hidden: true } } }),
    );
    expect(back.settings).toEqual({ ...DEFAULTS, secondsPerScreen: 30 });
    expect(back.photos).toEqual({ 'x|1': { hidden: true } });
  });

  it('rejects files that are not settings files', () => {
    expect(() => parseConfig('{nope')).toThrow();
    expect(() => parseConfig('{"hello": 1}')).toThrow(/not a wedding-carousel/);
  });

  it('merges: first file sets the look, photo choices combine', () => {
    const a = { settings: { ...DEFAULTS, title: 'A' }, photos: { 'p|1': { featured: true } } };
    const b = { settings: { ...DEFAULTS, title: 'B' }, photos: { 'p|1': { hidden: true }, 'q|2': { hidden: true } } };
    const m = mergeConfigs([a, b]);
    expect(m.settings.title).toBe('A');
    expect(m.photos).toEqual({ 'p|1': { featured: true }, 'q|2': { hidden: true } });
  });

  it('matches by name + size, then by name alone, and keeps leftovers', () => {
    const { matched, rest } = adopt(
      { 'a.jpg|10': { featured: true }, 'b.jpg|999': { hidden: true }, 'gone.jpg|5': { hidden: true }, 'odd|name.jpg|7': { featured: true } },
      ['a.jpg|10', 'b.jpg|20', 'odd|name.jpg|8'],
    );
    expect(matched).toEqual({ 'a.jpg|10': { featured: true }, 'b.jpg|20': { hidden: true }, 'odd|name.jpg|8': { featured: true } });
    expect(rest).toEqual({ 'gone.jpg|5': { hidden: true } });
  });

  it('recognises conflict copies', () => {
    for (const n of ['wedding-carousel 2.json', 'wedding-carousel (1).json', 'wedding-carousel-3.json']) expect(CONFLICT_COPY.test(n)).toBe(true);
    expect(CONFLICT_COPY.test('wedding-carousel.json')).toBe(false);
  });
});
