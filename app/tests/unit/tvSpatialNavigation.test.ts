import { describe, expect, it } from 'vitest';
import { findSpatialCandidate } from '../../src/hooks/useTvSpatialNavigation';

const rect = (left: number, top: number, width = 40, height = 40) => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
  x: left,
  y: top,
  toJSON: () => ({}),
}) as DOMRect;

const element = (name: string) => ({ dataset: { name } }) as unknown as HTMLElement;

describe('Google TV spatial navigation', () => {
  it('selects the nearest candidate in the requested direction', () => {
    const right = element('right');
    const farRight = element('far-right');
    expect(findSpatialCandidate(rect(100, 100), [
      { element: farRight, rect: rect(300, 100) },
      { element: right, rect: rect(170, 105) },
    ], 'ArrowRight')).toBe(right);
  });

  it('prefers an aligned control over a closer diagonal control', () => {
    const aligned = element('aligned');
    const diagonal = element('diagonal');
    expect(findSpatialCandidate(rect(100, 100), [
      { element: diagonal, rect: rect(155, 240) },
      { element: aligned, rect: rect(210, 105) },
    ], 'ArrowRight')).toBe(aligned);
  });

  it('returns null when no control exists in that direction', () => {
    expect(findSpatialCandidate(rect(100, 100), [
      { element: element('left'), rect: rect(20, 100) },
    ], 'ArrowDown')).toBeNull();
  });
});
