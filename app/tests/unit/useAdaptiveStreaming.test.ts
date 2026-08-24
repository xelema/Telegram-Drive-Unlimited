import { describe, expect, it } from 'vitest';
import { extractMoovAtom } from '../../src/hooks/useAdaptiveStreaming';

function writeType(target: Uint8Array, offset: number, type: string): void {
  for (let index = 0; index < 4; index++) {
    target[offset + index] = type.charCodeAt(index);
  }
}

function box(type: string, payload = new Uint8Array(0)): Uint8Array {
  const result = new Uint8Array(8 + payload.byteLength);
  new DataView(result.buffer).setUint32(0, result.byteLength);
  writeType(result, 4, type);
  result.set(payload, 8);
  return result;
}

function extendedBox(type: string, payload: Uint8Array): Uint8Array {
  const result = new Uint8Array(16 + payload.byteLength);
  const view = new DataView(result.buffer);
  view.setUint32(0, 1);
  writeType(result, 4, type);
  view.setBigUint64(8, BigInt(result.byteLength));
  result.set(payload, 16);
  return result;
}

function join(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

describe('MP4 moov atom isolation', () => {
  it('finds a validated moov atom in an unaligned media tail', () => {
    const mediaPayload = new Uint8Array(37).fill(0xa5);
    const moov = box('moov', join(box('free'), box('mvhd', new Uint8Array(12))));
    const tail = join(mediaPayload, moov, new Uint8Array(9));

    const result = extractMoovAtom(tail.buffer, 75_037_900);

    expect(result?.moovOffset).toBe(75_037_900 + mediaPayload.byteLength);
    expect(new Uint8Array(result!.moovData)).toEqual(moov);
  });

  it('ignores moov-like payload bytes and partial candidates', () => {
    const partialCandidate = new Uint8Array(12);
    new DataView(partialCandidate.buffer).setUint32(0, 4096);
    writeType(partialCandidate, 4, 'moov');

    const falseCandidate = box('moov', box('trak', new Uint8Array(4)));
    const validMoov = box('moov', box('mvhd', new Uint8Array(8)));
    const tail = join(partialCandidate, falseCandidate, new Uint8Array(3), validMoov);

    const result = extractMoovAtom(tail.buffer, 1000);

    expect(result?.moovOffset).toBe(1000 + partialCandidate.byteLength + falseCandidate.byteLength + 3);
    expect(new Uint8Array(result!.moovData)).toEqual(validMoov);
  });

  it('supports ISO BMFF extended-size moov atoms', () => {
    const moov = extendedBox('moov', box('mvhd', new Uint8Array(8)));
    const tail = join(new Uint8Array(5), moov);

    const result = extractMoovAtom(tail.buffer, 500);

    expect(result?.moovOffset).toBe(505);
    expect(new Uint8Array(result!.moovData)).toEqual(moov);
  });
});
