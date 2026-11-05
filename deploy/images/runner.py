"""Fixed container entrypoint; code is a file, never a host shell command."""
import base64
import os
import subprocess
import sys
from relay import start_relay

if len(sys.argv) != 3:
    sys.exit(64)
relay = None
try:
    code = base64.b64decode(sys.argv[1], validate=True)
    timeout = min(3600, max(0.001, int(sys.argv[2]) / 1000))
    if not 0 < len(code) <= 131072:
        sys.exit(64)
    filename = "/tmp/sazuz-task.py"
    with open(filename, "xb") as output:
        os.chmod(filename, 0o600)
        output.write(code)
    if os.environ.get("HTTPS_PROXY"):
        relay = start_relay()
    result = subprocess.run([sys.executable, filename], timeout=timeout, check=False)
    sys.exit(result.returncode)
except subprocess.TimeoutExpired:
    print("Sandbox time limit reached.", file=sys.stderr)
    sys.exit(124)
except (ValueError, OSError):
    print("Sandbox entrypoint could not prepare the task.", file=sys.stderr)
    sys.exit(64)
finally:
    if relay:
        relay.shutdown()
        relay.server_close()
