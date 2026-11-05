#!/usr/bin/env bash
set -euo pipefail
umask 077
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$root"
command -v docker >/dev/null 2>&1 || { printf '%s\n' 'Install Docker Engine/Desktop and Compose from https://docs.docker.com/get-docker/ then rerun this installer.' >&2; exit 1; }
docker compose version >/dev/null
docker info >/dev/null 2>&1 || { printf '%s\n' 'Start Docker, then rerun this installer.' >&2; exit 1; }
[[ -f deploy/compose.yaml ]] || { printf '%s\n' 'Run the installer from a complete Sazuz source distribution.' >&2; exit 1; }
[[ ! -L data ]] || { printf '%s\n' 'The data directory must not be a symbolic link.' >&2; exit 1; }
mkdir -p data
chmod 700 data
config="$root/data/compose.install.yaml"
[[ ! -L "$config" ]] || { printf '%s\n' 'Unsafe install configuration.' >&2; exit 1; }
if [[ ! -e "$config" ]]; then
  port=7777
  # Bash's local TCP probe avoids requiring an additional runtime or network utility.
  while (exec 3<>/dev/tcp/127.0.0.1/"$port") 2>/dev/null; do
    port=$((port + 1))
    [[ "$port" -le 7797 ]] || { printf '%s\n' 'No available port in 7777-7797.' >&2; exit 1; }
  done
  [[ "$port" -ge 7777 && "$port" -le 7797 ]] || exit 1
  printf 'services:\n  web:\n    ports: !override\n      - "127.0.0.1:%s:7777"\n  server:\n    environment:\n      SAZUZ_WEB_PORT: "%s"\n' "$port" "$port" > "$config"
else
  [[ -f "$config" && ! -L "$config" ]] || exit 1
  port="$(sed -n 's/.*SAZUZ_WEB_PORT: "\([0-9]*\)"/\1/p' "$config")"
  [[ "$port" =~ ^[0-9]+$ && "$port" -ge 7777 && "$port" -le 7797 ]] || { printf '%s\n' 'Generated install configuration is invalid.' >&2; exit 1; }
fi
compose=(docker compose --project-name sazuz --file "$root/deploy/compose.yaml")
bundle="$root/deploy/compose.release.yaml"
if [[ -e "$bundle" ]]; then
  [[ -f "$bundle" && ! -L "$bundle" ]] || exit 1
  compose+=(--file "$bundle")
fi
compose+=(--file "$config")
if [[ -e "$root/data/compose.release.yaml" ]]; then
  [[ -f "$root/data/compose.release.yaml" && ! -L "$root/data/compose.release.yaml" ]] || exit 1
  compose+=(--file "$root/data/compose.release.yaml")
  "${compose[@]}" up --detach --no-build --pull never --wait --wait-timeout 240
elif [[ -f "$bundle" ]]; then
  "${compose[@]}" up --detach --no-build --pull missing --wait --wait-timeout 240
else
  "${compose[@]}" up --detach --build --wait --wait-timeout 240
fi
"${compose[@]}" exec -T server node /app/dist/cli.js setup-token
mkdir -p "$HOME/.local/bin"
printf '#!/usr/bin/env bash\nexec bash %q "$@"\n' "$root/sazuz" > "$HOME/.local/bin/sazuz"
chmod 700 "$HOME/.local/bin/sazuz"
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) printf '\n# Sazuz command-line tools\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$HOME/.profile" ;;
esac
url="http://localhost:$port/setup"
printf '\nOpen %s\nCLI: %s doctor\n' "$url" "$HOME/.local/bin/sazuz"
if [[ "${1:-}" != '--no-open' ]]; then
  if command -v xdg-open >/dev/null 2>&1; then xdg-open "$url" >/dev/null 2>&1 || printf '%s\n' 'Open the setup URL in your browser.'
  elif command -v open >/dev/null 2>&1; then open "$url" || printf '%s\n' 'Open the setup URL in your browser.'; fi
fi
