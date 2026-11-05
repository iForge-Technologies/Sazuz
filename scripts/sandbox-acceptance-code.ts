/** Fixed acceptance programs. These run only in the hardened code images. */
export function sandboxAcceptanceCode(
  language: 'python' | 'node',
  network: boolean,
  peers: string[],
  receipt: string,
) {
  const targets = [
    { host: '93.184.216.34', port: 443 },
    { host: '169.254.169.254', port: 80 },
    ...peers.map((host, index) => ({ host, port: index === 0 ? 5432 : 8080 })),
  ];
  if (language === 'python')
    return `
import json, os, pathlib, socket, urllib.request
targets = ${JSON.stringify(targets)}
admitted = ${network ? 'True' : 'False'}
def blocked(target):
    try:
        connection = socket.create_connection((target["host"], target["port"]), timeout=1)
        connection.close()
        return False
    except OSError:
        return True
assert all(blocked(host) for host in targets), "Direct traffic escaped"
try:
    socket.getaddrinfo("example.com", 443)
    raise AssertionError("External DNS escaped")
except socket.gaierror:
    pass
def fetch(url):
    try:
        with urllib.request.urlopen(url, timeout=10) as response:
            response.read(1024)
            return response.status == 200
    except (OSError, urllib.error.URLError):
        return False
assert fetch("https://example.com/") == admitted, "Allowlist request mismatch"
assert not fetch("https://example.net/"), "Unlisted domain escaped"
assert not fetch("http://169.254.169.254/latest/meta-data/"), "Metadata escaped"
assert pathlib.Path("/run/sazuz-egress/proxy.sock").exists() == admitted
assert not pathlib.Path("/var/run/docker.sock").exists()
assert not pathlib.Path("/data/secrets").exists()
assert os.getuid() == 1000
status = pathlib.Path("/proc/self/status").read_text()
for key, expected in [("CapEff", "0000000000000000"), ("NoNewPrivs", "1"), ("Seccomp", "2")]:
    assert status.split(key + ":", 1)[1].splitlines()[0].strip() == expected, key
try:
    pathlib.Path("/sazuz-write-probe").write_text("denied")
    raise AssertionError("Root filesystem was writable")
except OSError:
    pass
receipt = pathlib.Path("/workspace") / ${JSON.stringify(receipt)}
count = int(receipt.read_text()) + 1 if receipt.exists() else 1
receipt.write_text(str(count))
print(json.dumps({"admitted": admitted, "blockedDirect": len(targets), "receipt": count, "hardened": True}))
`;
  return `
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { lookup } from 'node:dns/promises';
import { readFile, writeFile, access } from 'node:fs/promises';
const targets = ${JSON.stringify(targets)};
const admitted = ${network};
async function blocked(target) {
  return new Promise((resolve) => {
    const socket = connect(target);
    let settled = false;
    const finish = (value) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); resolve(value); };
    const timer = setTimeout(() => finish(true), 1000);
    socket.once('connect', () => finish(false));
    socket.once('error', () => finish(true));
  });
}
for (const host of targets) assert(await blocked(host), 'Direct traffic escaped');
await assert.rejects(lookup('example.com'), 'External DNS escaped');
async function fetchOk(url) {
  try { const response = await fetch(url, { signal: AbortSignal.timeout(10000) }); await response.body?.cancel(); return response.status === 200; }
  catch { return false; }
}
assert.equal(await fetchOk('https://example.com/'), admitted, 'Allowlist request mismatch');
assert.equal(await fetchOk('https://example.net/'), false, 'Unlisted domain escaped');
assert.equal(await fetchOk('http://169.254.169.254/latest/meta-data/'), false, 'Metadata escaped');
async function exists(path) { try { await access(path); return true; } catch { return false; } }
assert.equal(await exists('/run/sazuz-egress/proxy.sock'), admitted);
assert.equal(await exists('/var/run/docker.sock'), false);
assert.equal(await exists('/data/secrets'), false);
assert.equal(process.getuid(), 1000);
const status = await readFile('/proc/self/status', 'utf8');
for (const [key, value] of [['CapEff', '0000000000000000'], ['NoNewPrivs', '1'], ['Seccomp', '2']])
  assert.equal(status.split(key + ':')[1].split('\\n')[0].trim(), value, key);
await assert.rejects(writeFile('/sazuz-write-probe', 'denied'));
const receipt = '/workspace/' + ${JSON.stringify(receipt)};
const count = await exists(receipt) ? Number(await readFile(receipt, 'utf8')) + 1 : 1;
await writeFile(receipt, String(count));
console.log(JSON.stringify({ admitted, blockedDirect: targets.length, receipt: count, hardened: true }));
`;
}
