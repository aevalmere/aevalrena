import { CodeError, compressSdp, expandCode, extractCode, versionHash } from './sdpcode';

/**
 * Long join and answer codes (src/net/sdpcode.ts): SDP -> code -> SDP round trips for a Chrome
 * offer and a Firefox answer, and refusals of damaged codes. The short-code rendezvous has its
 * own test, src/net/signaltest.ts.
 *
 *   npx --yes tsx src/net/sdpcodetest.ts
 */

declare const process: { stdout: { write(text: string): void }; exitCode?: number };

const CHROME_OFFER = [
  'v=0',
  'o=- 4215775240449105457 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'a=extmap-allow-mixed',
  'a=msid-semantic: WMS',
  'm=application 49203 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=candidate:1467250027 1 udp 2122260223 3b6d9c3e-4f1a-4a55-9e0d-7c1b2a3d4e5f.local 49203 typ host generation 0 network-id 1 network-cost 10',
  'a=candidate:2317467187 1 udp 2122194687 192.168.1.23 54400 typ host generation 0 network-id 2',
  'a=candidate:1234 1 udp 2122129151 fe80::1c2b:3d4e:5f60:7182%12 54401 typ host generation 0',
  'a=candidate:4233069003 1 tcp 1518280447 3b6d9c3e-4f1a-4a55-9e0d-7c1b2a3d4e5f.local 9 typ host tcptype active generation 0 network-id 1',
  'a=candidate:99 2 udp 2122260222 192.168.1.23 54402 typ host',
  'a=candidate:100 1 udp 1686052607 203.0.113.9 54403 typ srflx raddr 192.168.1.23 rport 54400',
  'a=ice-ufrag:Wq3x',
  'a=ice-pwd:8fLkQm2nV9pR4sT7uX0yZ1aB',
  'a=ice-options:trickle',
  'a=fingerprint:sha-256 7B:8B:F0:65:5F:78:E2:51:3B:AC:6F:F3:3F:46:1B:35:DC:B8:5F:64:1A:24:C2:43:F0:A1:58:D0:A1:2C:19:08',
  'a=setup:actpass',
  'a=mid:0',
  'a=sctp-port:5000',
  'a=max-message-size:262144',
  '',
].join('\r\n');

const FIREFOX_ANSWER = [
  'v=0',
  'o=mozilla...THIS_IS_SDPARTA-99.0 4906126234290153271 0 IN IP4 0.0.0.0',
  's=-',
  't=0 0',
  'a=sendrecv',
  'a=fingerprint:sha-256 AA:10:2B:3C:4D:5E:6F:70:81:92:A3:B4:C5:D6:E7:F8:09:1A:2B:3C:4D:5E:6F:70:81:92:A3:B4:C5:D6:E7:0F',
  'a=group:BUNDLE 0',
  'a=ice-options:trickle',
  'a=msid-semantic:WMS *',
  'm=application 55555 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 192.168.1.40',
  'a=candidate:0 1 UDP 2122252543 9f8e7d6c-5b4a-4938-8271-605f4e3d2c1b.local 55555 typ host',
  'a=candidate:1 1 TCP 2105524479 9f8e7d6c-5b4a-4938-8271-605f4e3d2c1b.local 9 typ host tcptype active',
  'a=sendrecv',
  'a=end-of-candidates',
  'a=ice-pwd:3e2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c',
  'a=ice-ufrag:5a6b7c8d',
  'a=mid:0',
  'a=setup:active',
  'a=sctp-port:5000',
  'a=max-message-size:1073741823',
  '',
].join('\r\n');

const VERSION = 'p4-0a1b2c3d';

const results: { name: string; pass: boolean; detail: string }[] = [];
function check(name: string, fn: () => string): void {
  try {
    results.push({ name, pass: true, detail: fn() });
  } catch (err) {
    results.push({ name, pass: false, detail: (err as Error).message });
  }
}

function need(sdp: string, lines: string[], absent: string[] = []): void {
  const have = sdp.split('\r\n');
  for (const l of lines) if (!have.includes(l)) throw new Error(`missing "${l}" in:\n${sdp}`);
  for (const a of absent) if (sdp.includes(a)) throw new Error(`unexpected "${a}" in:\n${sdp}`);
}

function candidates(sdp: string): string[] {
  return sdp.split('\r\n').filter((l) => l.startsWith('a=candidate:')).map((l) => {
    const f = l.split(' ');
    return `${f[4]}:${f[5]}`;
  });
}

let chromeCode = '';
check('Chrome offer: keeps only UDP host candidates for component 1, round trips', () => {
  chromeCode = compressSdp(CHROME_OFFER, 'offer', 3, VERSION);
  const x = expandCode(chromeCode);
  if (x.kind !== 'offer' || x.invite !== 3 || x.versionHash !== versionHash(VERSION)) throw new Error(JSON.stringify({ ...x, sdp: '' }));
  need(x.sdp, [
    'a=ice-ufrag:Wq3x', 'a=ice-pwd:8fLkQm2nV9pR4sT7uX0yZ1aB',
    'a=fingerprint:sha-256 7B:8B:F0:65:5F:78:E2:51:3B:AC:6F:F3:3F:46:1B:35:DC:B8:5F:64:1A:24:C2:43:F0:A1:58:D0:A1:2C:19:08',
    'a=setup:actpass', 'a=mid:0', 'a=sctp-port:5000', 'a=group:BUNDLE 0', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  ], ['tcp', 'srflx', '203.0.113.9', '54402']);
  const c = candidates(x.sdp).join(' ');
  const want = '3b6d9c3e-4f1a-4a55-9e0d-7c1b2a3d4e5f.local:49203 192.168.1.23:54400 fe80:0:0:0:1c2b:3d4e:5f60:7182:54401';
  if (c !== want) throw new Error(`candidates ${c}`);
  const again = compressSdp(x.sdp, 'offer', 3, VERSION);
  if (again !== chromeCode) throw new Error('expanding and packing again changed the code');
  return `${CHROME_OFFER.length} chars of SDP -> ${chromeCode.length} char code; candidates ${c}`;
});

check('Firefox answer: session-level fingerprint, uppercase UDP, setup active, round trips', () => {
  const code = compressSdp(FIREFOX_ANSWER, 'answer', 3, VERSION);
  const x = expandCode(code);
  if (x.kind !== 'answer' || x.invite !== 3) throw new Error(`kind ${x.kind} invite ${x.invite}`);
  need(x.sdp, [
    'a=ice-ufrag:5a6b7c8d', 'a=ice-pwd:3e2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c', 'a=setup:active', 'a=mid:0',
    'a=fingerprint:sha-256 AA:10:2B:3C:4D:5E:6F:70:81:92:A3:B4:C5:D6:E7:F8:09:1A:2B:3C:4D:5E:6F:70:81:92:A3:B4:C5:D6:E7:0F',
  ], ['TCP']);
  if (candidates(x.sdp).join(' ') !== '9f8e7d6c-5b4a-4938-8271-605f4e3d2c1b.local:55555') throw new Error(candidates(x.sdp).join(' '));
  if (compressSdp(x.sdp, 'answer', 3, VERSION) !== code) throw new Error('not stable');
  return `${FIREFOX_ANSWER.length} chars of SDP -> ${code.length} char code`;
});

check('a link carrying the code (#join=) is accepted as the code', () => {
  const x = expandCode(`  https://example.org/aevalrena/#join=${chromeCode}\n`);
  if (extractCode(`https://h/#answer=${chromeCode}`) !== chromeCode || x.invite !== 3) throw new Error('not extracted');
  return 'link and surrounding whitespace ignored';
});

check('damaged codes are refused with a readable message, never a crash', () => {
  const cases: [string, string][] = [
    ['cut short', chromeCode.slice(0, 40)],
    ['extra characters', `${chromeCode}AAAA`],
    ['not base64url', 'hello world!'],
    ['wrong magic', `B${chromeCode.slice(1)}`],
    ['empty', ''],
  ];
  const out: string[] = [];
  for (const [label, text] of cases) {
    try {
      expandCode(text);
      throw new Error(`${label}: accepted`);
    } catch (err) {
      if (!(err instanceof CodeError)) throw new Error(`${label}: ${(err as Error).message}`);
      out.push(`${label}: "${err.message}"`);
    }
  }
  try {
    compressSdp(CHROME_OFFER.replace(/^a=candidate:.*\r\n/gm, ''), 'offer', 1, VERSION);
    throw new Error('an SDP with no candidates made a code');
  } catch (err) {
    if (!(err instanceof CodeError)) throw err;
    out.push(`no candidates: "${err.message}"`);
  }
  return out.join('; ');
});

let ok = true;
for (const r of results) {
  ok = ok && r.pass;
  process.stdout.write(`${r.pass ? 'PASS' : 'FAIL'} ${r.name}: ${r.detail}\n`);
}
process.stdout.write(ok ? 'sdpcodetest: PASS\n' : 'sdpcodetest: FAIL\n');
if (!ok) process.exitCode = 1;
