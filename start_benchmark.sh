#!/usr/bin/env bash

set -euo pipefail

host_address="127.0.0.1"
port="8765"

usage() {
  cat <<'EOF'
Usage: ./start_benchmark.sh [--host HOST] [--port PORT]

Starts the CyberWikiBench server. It listens on 127.0.0.1:8765 by default.

Environment:
  PYTHON  Optional path or command name for Python 3.
EOF
}

require_value() {
  local option="$1"
  local value="${2:-}"
  if [[ -z "$value" || "$value" == --* ]]; then
    printf 'Missing value for %s\n' "$option" >&2
    usage >&2
    exit 2
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)
      require_value "$1" "${2:-}"
      host_address="$2"
      shift 2
      ;;
    --port)
      require_value "$1" "${2:-}"
      port="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! [[ "$port" =~ ^[0-9]+$ ]] || (( port < 1 || port > 65535 )); then
  printf 'Port must be an integer between 1 and 65535.\n' >&2
  exit 2
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
bundled_python="${HOME:-}/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3"

if [[ -n "${PYTHON:-}" ]]; then
  benchmark_python="$PYTHON"
elif [[ -x "$bundled_python" ]]; then
  benchmark_python="$bundled_python"
elif command -v python3 >/dev/null 2>&1; then
  benchmark_python="$(command -v python3)"
elif command -v python >/dev/null 2>&1; then
  benchmark_python="$(command -v python)"
else
  printf 'Python 3 was not found. Install Python 3.11+ or set PYTHON to its path.\n' >&2
  exit 127
fi

cd "$script_dir"
exec "$benchmark_python" -m benchmark.server --host "$host_address" --port "$port"
