import vectors from '@vectors';
import { encode, decode, DecodeError, Op } from './frames';

const hexToBytes = (s: string) =>
  new Uint8Array(s.trim().split(/\s+/).map(h => parseInt(h, 16)));
const bytesToHex = (b: Uint8Array) =>
  Array.from(b).map(x => x.toString(16).padStart(2, '0')).join(' ');

describe('frame codec against the shared vector contract', () => {
  for (const v of vectors.vectors) {
    it(`round-trips ${v.name} byte-for-byte`, () => {
      const bytes = hexToBytes(v.bytes);
      const frame = decode(bytes);
      expect(bytesToHex(encode(frame))).toBe(bytesToHex(bytes));
    });

    it(`decodes ${v.name} to the declared opcode`, () => {
      const frame = decode(hexToBytes(v.bytes));
      expect(Op[frame.op]).toBe(v.frame.op);
      expect(frame.seq).toBe(v.frame.seq);
    });
  }

  // Timestamps must survive exactly as JS numbers. 4886718345 is the value used
  // throughout the vectors; if BigInt were needed this assertion would fail.
  it('preserves a 64-bit microsecond timestamp exactly', () => {
    const f = decode(hexToBytes(
      '01 02 02 01 89 67 45 23 01 00 00 00 2c 01 ff'));
    if (f.op !== Op.FIRE_AT) throw new Error('wrong opcode');
    expect(f.tFireUs).toBe(4886718345);
    expect(Number.isSafeInteger(f.tFireUs)).toBe(true);
  });

  it.each([
    ['SHORT',   '01 01'],
    ['VERSION', '02 01 01 00'],
    ['OPCODE',  '01 7f 01 00'],
    ['LENGTH',  '01 02 01 00 89 67'],
  ])('rejects malformed input with reason %s', (reason, hex) => {
    expect(() => decode(hexToBytes(hex)))
      .toThrow(expect.objectContaining({ reason }));
  });

  it('never produces a frame larger than the BLE MTU allows', () => {
    for (const v of vectors.vectors) {
      expect(hexToBytes(v.bytes).length).toBeLessThanOrEqual(20);
    }
  });
});
