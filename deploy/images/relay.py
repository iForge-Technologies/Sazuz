"""Loopback-only byte relay to the read-only authenticated egress socket."""
import selectors
import socket
import socketserver
import threading


class Relay(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = False
    slots = threading.BoundedSemaphore(8)


class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        if not self.server.slots.acquire(blocking=False):
            return
        upstream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            upstream.settimeout(10)
            self.request.settimeout(10)
            upstream.connect("/run/sazuz-egress/proxy.sock")
            with selectors.DefaultSelector() as watch:
                watch.register(self.request, selectors.EVENT_READ, upstream)
                watch.register(upstream, selectors.EVENT_READ, self.request)
                while True:
                    ready = watch.select(timeout=30)
                    if not ready:
                        return
                    for source, _ in ready:
                        data = source.fileobj.recv(65536)
                        if not data:
                            return
                        source.data.sendall(data)
        except OSError:
            # Closing both endpoints communicates failure without echoing proxy credentials.
            self.request.close()
        finally:
            upstream.close()
            self.server.slots.release()


def start_relay():
    relay = Relay(("127.0.0.1", 18888), Handler)
    threading.Thread(target=relay.serve_forever, daemon=True).start()
    return relay
