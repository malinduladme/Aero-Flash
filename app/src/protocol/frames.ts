export enum Op {
  SYNC_REQ = 0x01, FIRE_AT = 0x02, FIRE_NOW = 0x03, CANCEL = 0x04,
  GET_STATUS = 0x05, SET_CONFIG = 0x06, SET_MODE = 0x07,
  SYNC_RESP = 0x81, FIRE_ACK = 0x82, STATUS = 0x83, ERROR = 0x84,
}

export const ACK_LATE = 1;
export const ACK_DURATION_CLAMPED = 2;
export const ACK_COOLDOWN_REJECTED = 4;
export const ACK_FIRED = 8;

export const PROTO_VERSION = 0x01;
export const HDR_LEN = 4;
export const MAX_FRAME = 20;

export type Frame =
  | { op: Op.SYNC_REQ;   seq: number }
  | { op: Op.CANCEL;     seq: number }
  | { op: Op.GET_STATUS; seq: number }
  | { op: Op.FIRE_AT;    seq: number; tFireUs: number; durationMs: number; brightness: number }
  | { op: Op.FIRE_NOW;   seq: number; durationMs: number; brightness: number }
  | { op: Op.SET_CONFIG; seq: number; defaultDurationMs: number; brightness: number }
  | { op: Op.SET_MODE;   seq: number; mode: number }
  | { op: Op.SYNC_RESP;  seq: number; tDevUs: number; sessionId: number }
  | { op: Op.FIRE_ACK;   seq: number; tActualUs: number; sessionId: number; flags: number }
  | { op: Op.STATUS;     seq: number; mode: number; sessionId: number; batteryMv: number;
                         flags: number; uptimeS: number; fwVer: number }
  | { op: Op.ERROR;      seq: number; code: number };

export class DecodeError extends Error {
  constructor(public reason: 'SHORT' | 'VERSION' | 'OPCODE' | 'LENGTH') {
    super(`decode failed: ${reason}`);
    this.name = 'DecodeError';
  }
}

// Microseconds since boot stay under 2^53, so a 64-bit field splits exactly into
// two 32-bit halves and round-trips through `number` without loss. BigInt is
// deliberately avoided: it would spread through every arithmetic site for no gain.
const rdU16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const rdU32 = (b: Uint8Array, o: number) =>
  (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000;
const rdU64 = (b: Uint8Array, o: number) => rdU32(b, o) + rdU32(b, o + 4) * 0x100000000;

const wrU16 = (b: Uint8Array, o: number, v: number) => {
  b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff;
};
const wrU32 = (b: Uint8Array, o: number, v: number) => {
  b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff;
  b[o + 2] = (v >>> 16) & 0xff; b[o + 3] = Math.floor(v / 0x1000000) & 0xff;
};
const wrU64 = (b: Uint8Array, o: number, v: number) => {
  wrU32(b, o, v >>> 0);
  wrU32(b, o + 4, Math.floor(v / 0x100000000));
};

function payloadLen(op: number): number {
  switch (op) {
    case Op.SYNC_REQ: case Op.CANCEL: case Op.GET_STATUS: return 0;
    case Op.FIRE_AT:    return 11;
    case Op.FIRE_NOW:   return 3;
    case Op.SET_CONFIG: return 3;
    case Op.SET_MODE:   return 1;
    case Op.SYNC_RESP:  return 12;
    case Op.FIRE_ACK:   return 13;
    case Op.STATUS:     return 13;
    case Op.ERROR:      return 1;
    default:            return -1;
  }
}

export function decode(b: Uint8Array): Frame {
  if (b.length < HDR_LEN) throw new DecodeError('SHORT');
  if (b[0] !== PROTO_VERSION) throw new DecodeError('VERSION');

  const op = b[1];
  const plen = payloadLen(op);
  if (plen < 0) throw new DecodeError('OPCODE');
  if (b.length !== HDR_LEN + plen) throw new DecodeError('LENGTH');

  const seq = rdU16(b, 2);
  const p = HDR_LEN;

  switch (op) {
    case Op.SYNC_REQ:   return { op, seq };
    case Op.CANCEL:     return { op, seq };
    case Op.GET_STATUS: return { op, seq };
    case Op.FIRE_AT:
      return { op, seq, tFireUs: rdU64(b, p), durationMs: rdU16(b, p + 8), brightness: b[p + 10] };
    case Op.FIRE_NOW:
      return { op, seq, durationMs: rdU16(b, p), brightness: b[p + 2] };
    case Op.SET_CONFIG:
      return { op, seq, defaultDurationMs: rdU16(b, p), brightness: b[p + 2] };
    case Op.SET_MODE:
      return { op, seq, mode: b[p] };
    case Op.SYNC_RESP:
      return { op, seq, tDevUs: rdU64(b, p), sessionId: rdU32(b, p + 8) };
    case Op.FIRE_ACK:
      return { op, seq, tActualUs: rdU64(b, p), sessionId: rdU32(b, p + 8), flags: b[p + 12] };
    case Op.STATUS:
      return {
        op, seq, mode: b[p], sessionId: rdU32(b, p + 1), batteryMv: rdU16(b, p + 5),
        flags: b[p + 7], uptimeS: rdU32(b, p + 8), fwVer: b[p + 12],
      };
    case Op.ERROR:
      return { op, seq, code: b[p] };
    default:
      throw new DecodeError('OPCODE');
  }
}

export function encode(f: Frame): Uint8Array {
  const plen = payloadLen(f.op);
  if (plen < 0) throw new DecodeError('OPCODE');
  const b = new Uint8Array(HDR_LEN + plen);
  b[0] = PROTO_VERSION;
  b[1] = f.op;
  wrU16(b, 2, f.seq);
  const p = HDR_LEN;

  switch (f.op) {
    case Op.FIRE_AT:
      wrU64(b, p, f.tFireUs); wrU16(b, p + 8, f.durationMs); b[p + 10] = f.brightness; break;
    case Op.FIRE_NOW:
      wrU16(b, p, f.durationMs); b[p + 2] = f.brightness; break;
    case Op.SET_CONFIG:
      wrU16(b, p, f.defaultDurationMs); b[p + 2] = f.brightness; break;
    case Op.SET_MODE:
      b[p] = f.mode; break;
    case Op.SYNC_RESP:
      wrU64(b, p, f.tDevUs); wrU32(b, p + 8, f.sessionId); break;
    case Op.FIRE_ACK:
      wrU64(b, p, f.tActualUs); wrU32(b, p + 8, f.sessionId); b[p + 12] = f.flags; break;
    case Op.STATUS:
      b[p] = f.mode; wrU32(b, p + 1, f.sessionId); wrU16(b, p + 5, f.batteryMv);
      b[p + 7] = f.flags; wrU32(b, p + 8, f.uptimeS); b[p + 12] = f.fwVer; break;
    case Op.ERROR:
      b[p] = f.code; break;
    default:
      break;
  }
  return b;
}
