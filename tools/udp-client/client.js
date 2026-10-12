#!/usr/bin/env node
// Host-side test client for the SmartCam flash unit over UDP.
//   node client.js status          - request device status
//   node client.js sync            - run the clock-sync handshake
//   node client.js fire-now        - naive immediate fire (the control condition)
//   node client.js fire-at [lead]  - scheduled fire, default 120ms lead
//   node client.js bench [n]       - n scheduled fires, writes CSV
const dgram = require('dgram');

const HOST = '192.168.4.1';
const PORT = 4210;
const VERSION = 0x01;
const OP = { SYNC_REQ:0x01, FIRE_AT:0x02, FIRE_NOW:0x03, CANCEL:0x04, GET_STATUS:0x05,
             SYNC_RESP:0x81, FIRE_ACK:0x82, STATUS:0x83, ERROR:0x84 };

const sock = dgram.createSocket('udp4');
let seq = 1;

function nowUs() { return Math.round(Number(process.hrtime.bigint()) / 1000); }

// Values are microseconds since boot, so they stay under 2^53 and split exactly
// into two 32-bit halves without BigInt.
function writeU64(buf, off, v) {
  buf.writeUInt32LE(v >>> 0, off);
  buf.writeUInt32LE(Math.floor(v / 0x100000000), off + 4);
}
function readU64(buf, off) {
  return buf.readUInt32LE(off) + buf.readUInt32LE(off + 4) * 0x100000000;
}

function header(op) {
  const b = Buffer.alloc(4);
  b[0] = VERSION; b[1] = op; b.writeUInt16LE(seq, 2);
  return b;
}

function decode(buf) {
  const op = buf[1], s = buf.readUInt16LE(2);
  switch (op) {
    case OP.SYNC_RESP:
      return { op:'SYNC_RESP', seq:s, t_dev_us:readU64(buf,4), session_id:buf.readUInt32LE(12) };
    case OP.FIRE_ACK:
      return { op:'FIRE_ACK', seq:s, t_actual_us:readU64(buf,4),
               session_id:buf.readUInt32LE(12), flags:buf[16] };
    case OP.STATUS:
      return { op:'STATUS', seq:s, mode:buf[4], session_id:buf.readUInt32LE(5),
               battery_mv:buf.readUInt16LE(9), flags:buf[11],
               uptime_s:buf.readUInt32LE(12), fw_ver:buf[16] };
    case OP.ERROR:
      return { op:'ERROR', seq:s, code:buf[4] };
    default:
      return { op:`0x${op.toString(16)}`, seq:s, raw:buf.toString('hex') };
  }
}

function request(buf, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const mySeq = seq++;
    buf.writeUInt16LE(mySeq, 2);
    const timer = setTimeout(() => {
      sock.removeListener('message', onMsg);
      reject(new Error(`timeout waiting for seq ${mySeq}`));
    }, timeoutMs);
    function onMsg(msg) {
      const d = decode(msg);
      if (d.seq !== mySeq) return;
      clearTimeout(timer);
      sock.removeListener('message', onMsg);
      resolve(d);
    }
    sock.on('message', onMsg);
    sock.send(buf, PORT, HOST);
  });
}

// Cristian's algorithm: keep the sample with the smallest round trip, because the
// fastest exchange is the least distorted by queuing delay. This is the trick NTP
// uses, and it is materially more robust than averaging.
async function syncClock(rounds = 11) {
  let best = null;
  for (let i = 0; i < rounds; i++) {
    const t0 = nowUs();
    const resp = await request(header(OP.SYNC_REQ));
    const t1 = nowUs();
    const rtt = t1 - t0;
    const offset = resp.t_dev_us - (t0 + rtt / 2);
    if (!best || rtt < best.rtt) best = { rtt, offset, session_id: resp.session_id };
  }
  return best;
}

function fireAtFrame(tFire, durationMs) {
  const b = Buffer.concat([header(OP.FIRE_AT), Buffer.alloc(11)]);
  writeU64(b, 4, tFire);
  b.writeUInt16LE(durationMs, 12);
  b[14] = 255;
  return b;
}

async function main() {
  const cmd = process.argv[2] || 'status';
  sock.bind();
  await new Promise(r => sock.once('listening', r));

  if (cmd === 'status') {
    console.log(await request(header(OP.GET_STATUS)));

  } else if (cmd === 'sync') {
    const s = await syncClock();
    console.log(`best rtt=${s.rtt}us  offset=${Math.round(s.offset)}us  session=0x${s.session_id.toString(16)}`);

  } else if (cmd === 'fire-now') {
    const b = Buffer.concat([header(OP.FIRE_NOW), Buffer.alloc(3)]);
    b.writeUInt16LE(300, 4); b[6] = 255;
    console.log(await request(b, 2000));

  } else if (cmd === 'fire-at') {
    const leadMs = Number(process.argv[3] || 120);
    const s = await syncClock();
    const tFire = nowUs() + s.offset + leadMs * 1000;
    const ack = await request(fireAtFrame(tFire, 300), leadMs + 2500);
    console.log(ack);
    console.log(`sync rtt: ${s.rtt} us`);
    console.log(`scheduling error: ${Math.round(ack.t_actual_us - tFire)} us, flags=0x${ack.flags.toString(16)}`);

  } else if (cmd === 'bench') {
    const n = Number(process.argv[3] || 50);
    const fs = require('fs');
    const path = require('path');
    const rows = ['n,rtt_us,offset_us,sched_error_us,flags'];

    for (let i = 0; i < n; i++) {
      const s = await syncClock(5);
      const tFire = nowUs() + s.offset + 120000;
      try {
        const ack = await request(fireAtFrame(tFire, 100), 3000);
        rows.push(`${i},${s.rtt},${Math.round(s.offset)},${Math.round(ack.t_actual_us - tFire)},${ack.flags}`);
      } catch (e) {
        rows.push(`${i},${s.rtt},${Math.round(s.offset)},,timeout`);
      }
      process.stdout.write(`\r${i + 1}/${n}`);
      // Respect the firmware's 500ms cooldown interlock.
      await new Promise(r => setTimeout(r, 700));
    }

    const outDir = path.join(__dirname, '..', '..', 'docs', 'measurements');
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, `wifi-${Date.now()}.csv`);
    fs.writeFileSync(file, rows.join('\n'));
    console.log(`\nwrote ${n} samples to ${file}`);

  } else {
    console.error('usage: client.js [status|sync|fire-now|fire-at [leadMs]|bench [n]]');
    process.exitCode = 1;
  }
  sock.close();
}

main().catch(e => { console.error(e.message); process.exit(1); });
