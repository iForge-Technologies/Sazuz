# Sourced by the trusted host wrapper; all Docker vectors below are fixed.
write_override() {
  local target="$1" image="$2" temporary role
  [[ "$image" =~ ^(sha256:[a-f0-9]{64}|[a-z0-9][a-z0-9./:_-]+@sha256:[a-f0-9]{64})$ ]] || return 1
  [[ ! -L "$target" ]] || return 1
  temporary="$(mktemp "$target.XXXXXX")" || return 1
  { printf 'services:\n'; for role in bootstrap migrate server worker web docker-socket-proxy egress-proxy; do printf "  %s:\n    image: '%s'\n" "$role" "$image"; done; } > "$temporary"
  mv -- "$temporary" "$target"
}
update_local() { "${compose[@]}" --file "$previous" run --rm --no-deps --entrypoint node server /app/dist/cli.js update-local "$1"; }
recover_update() {
  local state image
  [[ -f "$previous" && ! -L "$previous" ]] || return 1
  state="$(update_local state)" || return 1
  if [[ "$state" == none ]]; then printf '%s\n' 'No update needs recovery.'; return 0; fi
  if [[ "$state" == activation-intent ]]; then state="$(update_local reconcile)" || return 1; fi
  if [[ "$state" == done ]]; then
    update_local reconcile >/dev/null || return 1
    image="$(update_local candidate)" || return 1
    write_override "$active" "$image" || return 1
    printf '%s\n' 'The healthy update is active.'; return 0
  fi
  if [[ "$state" == preparing || "$state" == aborted ]]; then
    update_local abort >/dev/null || return 1
    printf '%s\n' 'Update preparation was cancelled before image changes.'; return 0
  fi
  "${compose[@]}" stop --timeout 30 "${services[@]}" || return 1
  update_local rollback >/dev/null || return 1
  cp -- "$previous" "$active" || return 1
  "${compose[@]}" --file "$previous" up --detach --no-deps --no-build --pull never --wait --wait-timeout 120 "${services[@]}" || return 1
  update_local finish-rollback >/dev/null || return 1
  printf '%s\n' 'Previous image and snapshot restored. Review stopped work before resuming.'
}
perform_update() {
  local manifest="$1" container image next_image prior_state
  if [[ -f "$previous" ]]; then
    prior_state="$(update_local state)" || return 1
    [[ "$prior_state" == none || "$prior_state" == done || "$prior_state" == rolled-back || "$prior_state" == aborted ]] || return 1
  fi
  [[ -f "$manifest" && ! -L "$manifest" ]] || return 1
  [[ "$(wc -c < "$manifest")" -le 32768 ]] || return 1
  # Absolute local paths cannot be confused with a Compose service:path source.
  manifest="$(cd -- "$(dirname -- "$manifest")" && pwd -P)/$(basename -- "$manifest")" || return 1
  container="$("${compose[@]}" ps --quiet server)" || return 1
  [[ "$container" =~ ^[a-f0-9]{12,64}$ ]] || return 1
  image="$(docker inspect --format '{{.Image}}' "$container")" || return 1
  write_override "$previous" "$image" || return 1
  prepared=true
  next_image="$("${compose[@]}" exec -T server node /app/dist/cli.js update-prepare --stdin "$image" < "$manifest")" || return 1
  write_override "$candidate" "$next_image" || return 1
  update_local pulling >/dev/null || return 1
  docker pull "$next_image" || return 1
  "${compose[@]}" stop --timeout 30 "${services[@]}" || return 1
  update_local migrating >/dev/null || return 1
  "${compose[@]}" --file "$candidate" run --rm --no-deps migrate || return 1
  update_local checking >/dev/null || return 1
  "${compose[@]}" --file "$candidate" up --detach --no-deps --no-build --pull never --wait --wait-timeout 120 "${services[@]}" || return 1
  activating=true
  "${compose[@]}" exec -T server node /app/dist/cli.js update-activate >/dev/null || return 1
  write_override "$active" "$next_image" || return 1
  printf '%s\n' 'Update is healthy and active. Release notes are in Settings > Advanced > Updates.'
}
sazuz_operation() {
  umask 077
  [[ "$#" == 2 ]] || { printf '%s\n' 'Usage: sazuz backup file.sazuz | restore file.sazuz | update release.json | update recover' >&2; return 1; }
  local operation="$1" argument="$2" temporary id owner
  if [[ "$operation" == backup ]]; then
    [[ ! -e "$argument" && ! -L "$argument" ]] || return 1
    temporary="$(mktemp "$argument.XXXXXX")" || return 1
    if "${compose[@]}" exec -T server node /app/dist/cli.js backup --stream > "$temporary"; then
      # noclobber publication; an existing destination is never overwritten.
      if ln -- "$temporary" "$argument"; then rm -- "$temporary"; printf 'Encrypted backup saved to %s\n' "$argument"; return 0; fi
    fi
    rm -- "$temporary"; return 1
  fi
  if [[ "$operation" == restore ]]; then
    [[ -f "$argument" && ! -L "$argument" && "$(wc -c < "$argument")" -le 134283264 ]] || return 1
    id="$("${compose[@]}" exec -T server node /app/dist/cli.js restore-upload < "$argument")" || return 1
    [[ "$id" =~ ^op_[0-9A-HJKMNP-TV-Z]{26}$ ]] || return 1
    "${compose[@]}" exec server node /app/dist/cli.js restore-complete "$id"
    return $?
  fi
  [[ -d "$root/data" && ! -L "$root/data" ]] || return 1
  previous="$root/data/compose.update.previous.yaml"
  candidate="$root/data/compose.update.candidate.yaml"
  active="$root/data/compose.release.yaml"
  lock="$root/data/update.lock.d"
  services=(server worker web docker-socket-proxy egress-proxy)
  for temporary in "$previous" "$candidate" "$active" "$lock"; do [[ ! -L "$temporary" ]] || return 1; done
  if ! mkdir "$lock" 2>/dev/null; then
    [[ "$argument" == recover && -f "$lock/pid" && ! -L "$lock/pid" ]] || return 1
    owner="$(cat "$lock/pid")"
    [[ "$owner" =~ ^[0-9]+$ ]] || return 1
    if kill -0 "$owner" 2>/dev/null; then printf '%s\n' 'An updater is still running.' >&2; return 1; fi
    rm -- "$lock/pid" && rmdir -- "$lock" && mkdir "$lock" || return 1
  fi
  printf '%s\n' "$$" > "$lock/pid"
  trap 'rm -- "$lock/pid"; rmdir -- "$lock"' EXIT
  prepared=false; activating=false
  if [[ "$argument" == recover ]]; then recover_update; return $?; fi
  if perform_update "$argument"; then return 0; fi
  if [[ "$prepared" == true && "$activating" == false ]]; then recover_update || printf '%s\n' 'Recovery needs attention; retain the operation journal.' >&2; fi
  printf '%s\n' 'Update stopped. Use sazuz update recover for an interrupted operation.' >&2
  return 1
}
