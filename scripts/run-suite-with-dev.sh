#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-integration}"
PORT="${2:-3010}"
BASE_URL="http://127.0.0.1:${PORT}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${MODE}" != "integration" && "${MODE}" != "stress" && "${MODE}" != "health" ]]; then
  echo "Usage: ./scripts/run-suite-with-dev.sh <integration|stress|health> [port]"
  exit 1
fi

cd "${ROOT_DIR}"

pick_available_port() {
  local preferred="$1"

  if ! command -v lsof >/dev/null 2>&1; then
    echo "${preferred}"
    return 0
  fi

  # Wider scan window to avoid false NO-GO when local dev services occupy default ports.
  for offset in $(seq 0 200); do
    local candidate=$((preferred + offset))
    if ! lsof -ti tcp:"${candidate}" >/dev/null 2>&1; then
      echo "${candidate}"
      return 0
    fi
  done

  # Final fallback: ask Node to allocate an ephemeral free port.
  local fallback
  fallback="$(node -e 'const net=require("net");const s=net.createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;console.log(p);s.close();});s.on("error",()=>process.exit(1));' 2>/dev/null || true)"
  if [[ -n "${fallback}" ]]; then
    echo "${fallback}"
    return 0
  fi

  return 1
}

if ! RESOLVED_PORT="$(pick_available_port "${PORT}")"; then
  echo "Unable to find a free port for requested base ${PORT}."
  exit 1
fi

if [[ "${RESOLVED_PORT}" != "${PORT}" ]]; then
  echo "Port ${PORT} busy; using ${RESOLVED_PORT} instead."
fi

PORT="${RESOLVED_PORT}"
BASE_URL="http://127.0.0.1:${PORT}"

LOG_FILE="/tmp/atria-suite-${MODE}-${PORT}.log"
SERVER_PID=""

cleanup() {
  if [[ -n "${SERVER_PID}" ]] && kill -0 "${SERVER_PID}" >/dev/null 2>&1; then
    kill "${SERVER_PID}" >/dev/null 2>&1 || true
    wait "${SERVER_PID}" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

# Keep gate checks deterministic by running against a temporary production server.
# Health mode always forces a fresh production build because concurrent gate runs
# can invalidate .next between checks.
if [[ "${MODE}" == "health" ]]; then
  npm run build >/tmp/atria-suite-build.log 2>&1
elif [[ ! -f ".next/BUILD_ID" ]]; then
  npm run build >/tmp/atria-suite-build.log 2>&1
fi

PORT="${PORT}" npm run start >"${LOG_FILE}" 2>&1 &
SERVER_PID=$!

READY=0
for _ in $(seq 1 60); do
  if curl -fsS "${BASE_URL}/api/health" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 1
done

if [[ "${READY}" -ne 1 ]]; then
  echo "Production server did not become healthy on ${BASE_URL}."
  echo "Recent log output:"
  tail -n 80 "${LOG_FILE}" || true
  exit 1
fi

if [[ "${MODE}" == "health" ]]; then
  curl -fsS "${BASE_URL}/api/health" >/dev/null
  echo "Atria health endpoint is healthy at ${BASE_URL}."
  exit 0
fi

TOKEN="$(node ./scripts/get-access-token.mjs)"

if [[ "${MODE}" == "integration" ]]; then
  BASE_URL="${BASE_URL}" ./test-api.sh "${TOKEN}"
  exit $?
fi

BASE_URL="${BASE_URL}" ./test-stress.sh "${TOKEN}"
