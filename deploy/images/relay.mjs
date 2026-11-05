import { connect, createServer } from 'node:net';

/** Generated code has only loopback networking. This socket is its sole external route. */
export async function startRelay() {
  const sockets = new Set();
  const server = createServer((client) => {
    if (sockets.size >= 16) {
      client.destroy();
      return;
    }
    const upstream = connect('/run/sazuz-egress/proxy.sock');
    sockets.add(client);
    sockets.add(upstream);
    const close = () => {
      sockets.delete(client);
      sockets.delete(upstream);
      client.destroy();
      upstream.destroy();
    };
    for (const socket of [client, upstream]) {
      socket.on('error', close);
      socket.on('close', close);
      socket.setTimeout(30000, close);
    }
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(18888, '127.0.0.1', resolve);
  });
  return () => {
    for (const socket of sockets) socket.destroy();
    server.close();
  };
}
