#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_FILE="${ATRIA_PHONE_LOG:-/tmp/atria-phone-dev.log}"
LAUNCH_LOG_FILE="${ATRIA_PHONE_LAUNCH_LOG:-/tmp/atria-phone-launch.log}"
MAX_WAIT_SECONDS="${ATRIA_PREP_WAIT_SECONDS:-120}"
API_PORT_START="${ATRIA_API_PORT_START:-3000}"
API_PORT_END="${ATRIA_API_PORT_END:-3020}"
EXPO_PORT_START="${ATRIA_EXPO_PORT_START:-8081}"
EXPO_PORT_END="${ATRIA_EXPO_PORT_END:-8100}"

ensure_node22_path() {
  if command -v brew >/dev/null 2>&1; then
    local node22_bin
    node22_bin="$(brew --prefix node@22 2>/dev/null || true)"
    if [[ -n "${node22_bin}" && -d "${node22_bin}/bin" ]]; then
      export PATH="${node22_bin}/bin:${PATH}"
    fi
  fi
}

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

find_healthy_api_port() {
  local port
  for port in $(seq "${API_PORT_START}" "${API_PORT_END}"); do
    if is_atria_api "${port}"; then
      echo "${port}"
      return 0
    fi
  done

  return 1
}

find_expo_port() {
  local port
  for port in $(seq "${EXPO_PORT_START}" "${EXPO_PORT_END}"); do
    if is_expo_server "${port}"; then
      echo "${port}"
      return 0
    fi
  done

  return 1
}

list_healthy_api_ports() {
  local port
  for port in $(seq "${API_PORT_START}" "${API_PORT_END}"); do
    if is_atria_api "${port}"; then
      echo "${port}"
    fi
  done
}

list_expo_ports() {
  local port
  for port in $(seq "${EXPO_PORT_START}" "${EXPO_PORT_END}"); do
    if is_expo_server "${port}"; then
      echo "${port}"
    fi
  done
}

kill_process_tree() {
  local pid="$1"
  local child=""

  if [[ -z "${pid}" || "${pid}" == "$$" || "${pid}" == "$PPID" ]]; then
    return 0
  fi

  if command -v pgrep >/dev/null 2>&1; then
    while IFS= read -r child; do
      kill_process_tree "${child}"
    done < <(pgrep -P "${pid}" 2>/dev/null || true)
  fi

  kill "${pid}" >/dev/null 2>&1 || true
}

list_repo_launcher_pids() {
  python3 - "${ROOT_DIR}" "$$" "$PPID" <<'PY'
import subprocess
import sys

root_dir = sys.argv[1]
self_pid = int(sys.argv[2])
parent_pid = int(sys.argv[3])
patterns = (
    "/node_modules/.bin/next dev",
    "/node_modules/.bin/expo start",
    "/node_modules/.bin/concurrently",
    " expo start --dev-client",
    " next dev -p ",
)

try:
    output = subprocess.check_output(
        ["ps", "-axo", "pid=,ppid=,command="],
        text=True,
    )
except subprocess.CalledProcessError:
    sys.exit(0)

seen = set()
for line in output.splitlines():
    stripped = line.strip()
    if not stripped:
        continue
    parts = stripped.split(None, 2)
    if len(parts) < 3:
        continue

    pid = int(parts[0])
    command = parts[2]

    if pid in (self_pid, parent_pid):
        continue
    if root_dir not in command:
        continue
    if not any(pattern in command for pattern in patterns):
        continue
    if pid in seen:
        continue

    seen.add(pid)
    print(pid)
PY
}

cleanup_stale_phone_stack() {
  local primary_api_port="${ATRIA_PRIMARY_API_PORT:-3000}"
  local primary_expo_port="${ATRIA_PRIMARY_EXPO_PORT:-8081}"
  local should_cleanup=0
  local port=""
  local pid=""
  local line=""
  local api_count=0
  local expo_count=0
  local launcher_count=0
  local api_ports=()
  local expo_ports=()
  local launcher_pids=()

  while IFS= read -r line; do
    if [[ -n "${line}" ]]; then
      api_ports+=("${line}")
      api_count=$((api_count + 1))
    fi
  done < <(list_healthy_api_ports)

  while IFS= read -r line; do
    if [[ -n "${line}" ]]; then
      expo_ports+=("${line}")
      expo_count=$((expo_count + 1))
    fi
  done < <(list_expo_ports)

  while IFS= read -r line; do
    if [[ -n "${line}" ]]; then
      launcher_pids+=("${line}")
      launcher_count=$((launcher_count + 1))
    fi
  done < <(list_repo_launcher_pids)

  if (( launcher_count > 1 )); then
    should_cleanup=1
  fi

  if (( launcher_count > 0 )) && (( api_count == 0 || expo_count == 0 )); then
    should_cleanup=1
  fi

  if (( api_count > 0 )); then
    for port in "${api_ports[@]}"; do
      if [[ "${port}" != "${primary_api_port}" ]]; then
        should_cleanup=1
        break
      fi
    done
  fi

  if (( expo_count > 0 )); then
    for port in "${expo_ports[@]}"; do
      if [[ "${port}" != "${primary_expo_port}" ]]; then
        should_cleanup=1
        break
      fi
    done
  fi

  if (( should_cleanup == 0 )); then
    return 0
  fi

  echo "Cleaning up stale Atria phone-dev processes..."

  if (( launcher_count > 0 )); then
    for pid in "${launcher_pids[@]}"; do
      kill_process_tree "${pid}"
    done
  fi

  if (( api_count > 0 )); then
    for port in "${api_ports[@]}"; do
      kill_port_listener "${port}"
    done
  fi

  if (( expo_count > 0 )); then
    for port in "${expo_ports[@]}"; do
      kill_port_listener "${port}"
    done
  fi

  sleep 2
}

start_or_reuse_phone_stack() {
  if find_healthy_api_port >/dev/null 2>&1 && find_expo_port >/dev/null 2>&1; then
    echo "Atria phone-testing services are already healthy; reusing them."
    return 0
  fi

  : > "${LOG_FILE}"
  : > "${LAUNCH_LOG_FILE}"
  "${ROOT_DIR}/scripts/open-phone-dev-terminal.sh" >"${LAUNCH_LOG_FILE}" 2>&1
}

wait_for_stack() {
  local api_port=""
  local expo_port=""
  local attempt

  for attempt in $(seq 1 "${MAX_WAIT_SECONDS}"); do
    api_port="$(find_healthy_api_port || true)"
    expo_port="$(find_expo_port || true)"

    if [[ -n "${api_port}" && -n "${expo_port}" ]]; then
      echo "${api_port}:${expo_port}"
      return 0
    fi

    sleep 1
  done

  return 1
}

kill_port_listener() {
  local port="$1"
  local pids=""

  if ! command -v lsof >/dev/null 2>&1; then
    return 0
  fi

  pids="$(lsof -ti tcp:"${port}" 2>/dev/null || true)"
  if [[ -n "${pids}" ]]; then
    kill ${pids} >/dev/null 2>&1 || true
  fi
}

cleanup_temp_file() {
  local path="$1"
  if [[ -n "${path}" && -f "${path}" ]]; then
    rm -f "${path}"
  fi
}

smoke_check_properties() {
  local api_port="$1"
  local token=""
  local create_body=""
  local list_body=""
  local delete_body=""
  local create_status=""
  local list_status=""
  local delete_status=""
  local property_id=""
  local smoke_name="Automation Smoke $(date +"%Y-%m-%d %H-%M-%S")"

  token="$(cd "${ROOT_DIR}" && node ./scripts/get-access-token.mjs)"
  create_body="$(mktemp)"
  list_body="$(mktemp)"
  delete_body="$(mktemp)"

  create_status="$(
    curl -sS -o "${create_body}" -w "%{http_code}" \
      -X POST "http://127.0.0.1:${api_port}/api/properties" \
      -H "Authorization: Bearer ${token}" \
      -H "Content-Type: application/json" \
      --data "{\"name\":\"${smoke_name}\"}"
  )"

  if [[ "${create_status}" != "201" ]]; then
    echo "Property create smoke check failed with HTTP ${create_status}."
    cat "${create_body}"
    cleanup_temp_file "${create_body}"
    cleanup_temp_file "${list_body}"
    cleanup_temp_file "${delete_body}"
    return 1
  fi

  property_id="$(
    python3 - "${create_body}" <<'PY'
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as handle:
    payload = json.load(handle)

print(payload.get("id", ""))
PY
  )"

  if [[ -z "${property_id}" ]]; then
    echo "Property create smoke check did not return an id."
    cat "${create_body}"
    cleanup_temp_file "${create_body}"
    cleanup_temp_file "${list_body}"
    cleanup_temp_file "${delete_body}"
    return 1
  fi

  list_status="$(
    curl -sS -o "${list_body}" -w "%{http_code}" \
      "http://127.0.0.1:${api_port}/api/properties" \
      -H "Authorization: Bearer ${token}"
  )"

  if [[ "${list_status}" != "200" ]]; then
    echo "Property list smoke check failed with HTTP ${list_status}."
    cat "${list_body}"
    cleanup_temp_file "${create_body}"
    cleanup_temp_file "${list_body}"
    cleanup_temp_file "${delete_body}"
    return 1
  fi

  delete_status="$(
    curl -sS -o "${delete_body}" -w "%{http_code}" \
      -X DELETE "http://127.0.0.1:${api_port}/api/properties/${property_id}" \
      -H "Authorization: Bearer ${token}"
  )"

  if [[ "${delete_status}" != "200" ]]; then
    echo "Warning: smoke property cleanup failed with HTTP ${delete_status}."
    cat "${delete_body}"
  fi

  cleanup_temp_file "${create_body}"
  cleanup_temp_file "${list_body}"
  cleanup_temp_file "${delete_body}"

  echo "Property smoke checks passed (create/list/delete)."
  return 0
}

restart_once_and_recheck() {
  local api_port="$1"
  local expo_port="$2"
  local restarted_ports=""

  echo "Smoke check failed; restarting the phone-testing stack once..."
  kill_port_listener "${api_port}"
  kill_port_listener "${expo_port}"
  sleep 2
  start_or_reuse_phone_stack

  if ! restarted_ports="$(wait_for_stack)"; then
    echo "Restarted stack did not become ready within ${MAX_WAIT_SECONDS}s."
    return 1
  fi

  IFS=":" read -r api_port expo_port <<<"${restarted_ports}"
  smoke_check_properties "${api_port}" >/dev/stderr
  printf '%s\n' "${restarted_ports}"
}

main() {
  local ports=""
  local api_port=""
  local expo_port=""
  local lan_ip=""
  local api_url=""
  local expo_link=""

  ensure_node22_path
  cd "${ROOT_DIR}"
  npm run check:node >/dev/null

  cleanup_stale_phone_stack

  echo "Starting or reusing the Atria phone-testing stack..."
  start_or_reuse_phone_stack

  if ! ports="$(wait_for_stack)"; then
    echo "Atria phone-testing stack did not become ready within ${MAX_WAIT_SECONDS}s."
    echo "Recent launch stderr:"
    tail -n 40 "${LAUNCH_LOG_FILE}" || true
    echo "Recent dev log:"
    tail -n 80 "${LOG_FILE}" || true
    exit 1
  fi

  IFS=":" read -r api_port expo_port <<<"${ports}"

  if ! smoke_check_properties "${api_port}"; then
    if ! ports="$(restart_once_and_recheck "${api_port}" "${expo_port}")"; then
      echo "Phone-testing prep failed after one restart attempt."
      echo "Recent dev log:"
      tail -n 80 "${LOG_FILE}" || true
      exit 1
    fi
    IFS=":" read -r api_port expo_port <<<"${ports}"
  fi

  lan_ip="$(resolve_lan_ip || true)"
  if [[ -n "${lan_ip}" ]]; then
    api_url="http://${lan_ip}:${api_port}"
  else
    api_url="http://127.0.0.1:${api_port}"
  fi

  expo_link="$(grep -Eo 'exp://[^[:space:]]+' "${LOG_FILE}" | tail -n 1 || true)"

  echo "READY: yes"
  echo "API URL: ${api_url}"
  echo "Expo port: ${expo_port}"
  if [[ -n "${expo_link}" ]]; then
    echo "Expo link: ${expo_link}"
  fi
  echo "Health check: ${api_url}/api/health"
  echo "Log file: ${LOG_FILE}"
}

main "$@"
