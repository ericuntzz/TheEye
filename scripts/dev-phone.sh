#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_PORT="${API_PORT:-3000}"
EXPO_PORT="${EXPO_PORT:-8081}"
EXPO_MODE="${EXPO_MODE:-lan}" # lan | tunnel
EXPO_CLEAR="${EXPO_CLEAR:-0}"
EXPO_DEV_CLIENT="${EXPO_DEV_CLIENT:-1}"

resolve_lan_ip() {
  local iface=""
  local ip=""

  if command -v route >/dev/null 2>&1; then
    iface="$(route -n get default 2>/dev/null | awk '/interface:/{print $2; exit}')"
  fi

  if [[ -n "${iface}" ]] && command -v ipconfig >/dev/null 2>&1; then
    ip="$(ipconfig getifaddr "${iface}" 2>/dev/null || true)"
  fi

  if [[ -z "${ip}" ]] && command -v ipconfig >/dev/null 2>&1; then
    ip="$(ipconfig getifaddr en0 2>/dev/null || true)"
  fi

  if [[ -z "${ip}" ]] && command -v ipconfig >/dev/null 2>&1; then
    ip="$(ipconfig getifaddr en1 2>/dev/null || true)"
  fi

  if [[ -z "${ip}" ]] && command -v ifconfig >/dev/null 2>&1; then
    ip="$(ifconfig | awk '/inet / && $2 != "127.0.0.1" && $2 !~ /^169\.254\./ {print $2; exit}')"
  fi

  if [[ -n "${ip}" ]]; then
    echo "${ip}"
    return 0
  fi

  return 1
}

pick_available_port() {
  local preferred="$1"
  local candidate="$preferred"

  if ! command -v lsof >/dev/null 2>&1; then
    echo "${candidate}"
    return 0
  fi

  for offset in $(seq 0 20); do
    candidate=$((preferred + offset))
    if ! lsof -ti tcp:"${candidate}" >/dev/null 2>&1; then
      echo "${candidate}"
      return 0
    fi
  done

  return 1
}

is_port_in_use() {
  local port="$1"
  if ! command -v lsof >/dev/null 2>&1; then
    return 1
  fi

  lsof -ti tcp:"${port}" >/dev/null 2>&1
}

is_atria_api() {
  local port="$1"
  local health

  health="$(curl -fsS --max-time 2 "http://127.0.0.1:${port}/api/health" 2>/dev/null || true)"
  [[ "${health}" == *"\"status\":\"ok\""* ]]
}

is_expo_server() {
  local port="$1"
  local page

  page="$(curl -fsS --max-time 2 "http://127.0.0.1:${port}" 2>/dev/null || true)"
  [[ "${page}" == *"id=\"expo-reset\""* || "${page}" == *"index.ts.bundle?platform=web"* ]]
}

if [[ "${EXPO_MODE}" != "lan" && "${EXPO_MODE}" != "tunnel" ]]; then
  echo "EXPO_MODE must be 'lan' or 'tunnel' (received: ${EXPO_MODE})."
  exit 1
fi

REUSE_API_SERVER=0
if is_port_in_use "${API_PORT}"; then
  if is_atria_api "${API_PORT}"; then
    REUSE_API_SERVER=1
    echo "API port ${API_PORT} already has a healthy Atria server; reusing it."
  else
    if ! RESOLVED_API_PORT="$(pick_available_port "${API_PORT}")"; then
      echo "Unable to find a free API port near ${API_PORT}."
      exit 1
    fi

    if [[ "${RESOLVED_API_PORT}" != "${API_PORT}" ]]; then
      echo "API port ${API_PORT} is busy; using ${RESOLVED_API_PORT} instead."
    fi

    API_PORT="${RESOLVED_API_PORT}"
  fi
fi

API_URL="${EXPO_PUBLIC_API_URL:-}"
if [[ -z "${API_URL}" ]]; then
  DETECTED_IP="${LAN_IP:-}"
  if [[ -z "${DETECTED_IP}" ]]; then
    DETECTED_IP="$(resolve_lan_ip || true)"
  fi

  if [[ -z "${DETECTED_IP}" ]]; then
    echo "Unable to detect LAN IP."
    echo "Set LAN_IP manually, for example:"
    echo "  LAN_IP=10.0.0.202 npm run dev:phone"
    exit 1
  fi

  API_URL="http://${DETECTED_IP}:${API_PORT}"
fi

if [[ "${API_URL}" == *"localhost"* || "${API_URL}" == *"127.0.0.1"* ]]; then
  echo "Warning: EXPO_PUBLIC_API_URL=${API_URL} uses localhost."
  echo "On a physical phone, localhost points to the phone itself."
fi

EXPO_TRANSPORT_FLAG="--lan"
if [[ "${EXPO_MODE}" == "tunnel" ]]; then
  EXPO_TRANSPORT_FLAG="--tunnel"
fi

EXPO_CLEAR_FLAG=""
if [[ "${EXPO_CLEAR}" == "1" ]]; then
  EXPO_CLEAR_FLAG="--clear"
fi

EXPO_CLIENT_FLAG=""
if [[ "${EXPO_DEV_CLIENT}" == "1" ]]; then
  EXPO_CLIENT_FLAG="--dev-client"
fi

REUSE_EXPO_SERVER=0
if [[ "${REUSE_API_SERVER}" == "1" ]] && is_port_in_use "${EXPO_PORT}" && is_expo_server "${EXPO_PORT}"; then
  REUSE_EXPO_SERVER=1
  echo "Expo port ${EXPO_PORT} already has a Metro server; reusing it."
else
  if ! RESOLVED_EXPO_PORT="$(pick_available_port "${EXPO_PORT}")"; then
    echo "Unable to find a free Expo port near ${EXPO_PORT}."
    exit 1
  fi

  if [[ "${RESOLVED_EXPO_PORT}" != "${EXPO_PORT}" ]]; then
    echo "Expo port ${EXPO_PORT} is busy; using ${RESOLVED_EXPO_PORT} instead."
  fi

  EXPO_PORT="${RESOLVED_EXPO_PORT}"
fi

echo "Starting Atria phone dev..."
echo "API server: http://0.0.0.0:${API_PORT}"
echo "Expo API URL: ${API_URL}"
echo "Expo port: ${EXPO_PORT}"
echo "Expo transport: ${EXPO_MODE}"
echo "Health check URL (phone browser): ${API_URL}/api/health"
echo "If you see MIME text/html errors, reopen the latest Expo QR/deep-link (stale bundle URL)."
echo ""

cd "${ROOT_DIR}"

EXPO_COMMAND="cd mobile && EXPO_PUBLIC_API_URL=${API_URL} npx expo start ${EXPO_CLIENT_FLAG} --port ${EXPO_PORT} ${EXPO_TRANSPORT_FLAG} ${EXPO_CLEAR_FLAG}"

if [[ "${REUSE_API_SERVER}" == "1" && "${REUSE_EXPO_SERVER}" == "1" ]]; then
  echo "API and Expo are already running. Reusing existing phone-dev services."
  exit 0
fi

if [[ "${REUSE_API_SERVER}" == "1" ]]; then
  bash -lc "${EXPO_COMMAND}"
  exit $?
fi

npx concurrently --restart-tries 2 --restart-after 2000 -n api,expo -c blue,magenta \
  "HOSTNAME=0.0.0.0 PORT=${API_PORT} npm run dev" \
  "${EXPO_COMMAND}"
