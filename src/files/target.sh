#!/usr/bin/env bash
set -Eeuo pipefail
export LC_ALL=C
umask 077
temporary=''
owns_temporary=false
temporary_identity=''
copy_pid=''
published=false
failure=''
emit() { printf 'PFT1 %s\n' "$1" >&2; }
fail() { failure=$1; exit 1; }
cleanup() {
    local status=$? cleanup_failed=false
    trap - EXIT ERR HUP INT TERM
    if [[ -n "${copy_pid}" ]]; then
        kill "${copy_pid}" 2>/dev/null || true
        wait "${copy_pid}" 2>/dev/null || true
    fi
    if [[ "${owns_temporary}" == true && ( -e "${temporary}" || -L "${temporary}" ) ]]; then
        if [[ ! -L "${temporary}" && -f "${temporary}" && "$(stat -c '%d:%i' -- "${temporary}" 2>/dev/null)" == "${temporary_identity}" ]] && rm -- "${temporary}" 2>/dev/null; then :; else cleanup_failed=true; fi
    fi
    if (( status != 0 )) || [[ "${cleanup_failed}" == true ]]; then
        [[ -n "${failure}" ]] || failure=io_failed
        emit "{\"event\":\"error\",\"code\":\"${failure}\",\"published\":${published},\"cleanupFailed\":${cleanup_failed}}"
        exit 1
    fi
}
trap cleanup EXIT
trap 'fail io_failed' ERR
trap 'fail cancelled' HUP INT TERM
IFS= read -r -n 8193 header || fail truncated
(( ${#header} <= 8192 )) || fail invalid_input
IFS=$'\t' read -r version operation encoded size expected_hash identifier extra <<<"${header}"
[[ "${version}" == PFT1 && ( "${operation}" == put || "${operation}" == get ) && -z "${extra}" && "${identifier}" =~ ^[a-f0-9-]{36}$ ]] || fail invalid_input
[[ "${encoded}" =~ ^[A-Za-z0-9+/=]+$ ]] || fail invalid_input
target=$(printf '%s' "${encoded}" | base64 --decode; printf '.')
target=${target%.}
[[ "$(printf '%s' "${target}" | base64 -w0)" == "${encoded}" && ! "${target}" =~ [[:cntrl:]] ]] || fail invalid_input
[[ "${target}" == /* && "${target}" != *$'\n'* && "${target}" != *$'\r'* && "${target}" != / ]] || fail invalid_input
(( ${#target} <= 4096 )) || fail invalid_input
parent=$(dirname -- "${target}")
leaf=$(basename -- "${target}")
[[ "${leaf}" != . && "${leaf}" != .. ]] || fail invalid_input
[[ -d "${parent}" ]] || fail parent_missing
canonical=$(realpath -e -- "${parent}" 2>/dev/null) || fail parent_missing
lexical=$(realpath -ms -- "${parent}" 2>/dev/null) || fail invalid_input
[[ "${canonical}" == "${lexical}" && ! -L "${target}" ]] || fail path_link
parent_identity=$(stat -Lc '%d:%i' -- "${parent}")
cd -P -- "${canonical}"
[[ "$(stat -Lc '%d:%i' .)" == "${parent_identity}" ]] || fail source_changed
check_parent() {
    [[ ! -L "${target}" && "$(realpath -e -- "${parent}" 2>/dev/null)" == "${canonical}" && "$(stat -Lc '%d:%i' -- "${parent}" 2>/dev/null)" == "${parent_identity}" ]] || fail source_changed
}
if [[ "${operation}" == put ]]; then
    [[ "${size}" =~ ^(0|[1-9][0-9]{0,8})$ && "${expected_hash}" =~ ^[a-f0-9]{64}$ ]] || fail invalid_input
    (( size <= 104857600 )) || fail too_large
    [[ ! -e "${leaf}" ]] || fail conflict
    temporary=".project-file-${identifier}.part"
    (set -o noclobber; : >"${temporary}") 2>/dev/null || fail conflict
    owns_temporary=true
    temporary_identity=$(stat -c '%d:%i' -- "${temporary}")
    emit "{\"event\":\"ready\",\"size\":${size}}"
    emit '{"event":"phase","phase":"transferring"}'
    dd bs=65536 iflag=count_bytes,fullblock count="${size}" of="${temporary}" status=none <&0 2>/dev/null &
    copy_pid=$!
    while kill -0 "${copy_pid}" 2>/dev/null; do
        actual=$(stat -c '%s' -- "${temporary}")
        emit "{\"event\":\"progress\",\"bytes\":${actual}}"
        sleep 0.2
    done
    wait "${copy_pid}" || fail io_failed
    copy_pid=''
    actual=$(stat -c '%s' -- "${temporary}")
    (( actual == size )) || fail truncated
    emit "{\"event\":\"progress\",\"bytes\":${actual}}"
    emit '{"event":"phase","phase":"verifying"}'
    hash=$(sha256sum -- "${temporary}")
    hash=${hash%% *}
    [[ "${hash}" == "${expected_hash}" ]] || fail hash_mismatch
    emit "{\"event\":\"verified\",\"bytes\":${actual},\"sha256\":\"${hash}\"}"
    emit '{"event":"phase","phase":"awaiting_commit"}'
    IFS= read -r -n 17 commit || fail truncated
    [[ "${commit}" == COMMIT ]] || fail protocol_error
    emit '{"event":"phase","phase":"publishing"}'
    check_parent
    [[ ! -L "${temporary}" && -f "${temporary}" && "$(stat -c '%d:%i' -- "${temporary}")" == "${temporary_identity}" ]] || fail path_link
    ln -T -- "${temporary}" "${leaf}" 2>/dev/null || fail conflict
    published=true
    rm -- "${temporary}"
    owns_temporary=false
    temporary=''
else
    [[ "${size}" == - && "${expected_hash}" == - ]] || fail invalid_input
    [[ -f "${leaf}" ]] || fail source_missing
    before=$(stat -Lc '%d:%i:%s:%y:%z' -- "${leaf}")
    exec {source_fd}<"${leaf}"
    check_parent
    held="/proc/$$/fd/${source_fd}"
    [[ "$(stat -Lc '%d:%i:%s:%y:%z' -- "${held}")" == "${before}" ]] || fail source_changed
    size=$(stat -Lc '%s' -- "${held}")
    (( size <= 104857600 )) || fail too_large
    emit '{"event":"phase","phase":"verifying"}'
    hash=$(sha256sum -- "${held}")
    hash=${hash%% *}
    emit "{\"event\":\"ready\",\"size\":${size},\"sha256\":\"${hash}\"}"
    emit '{"event":"phase","phase":"transferring"}'
    dd bs=65536 iflag=count_bytes,fullblock count="${size}" status=none <"${held}" 2>/dev/null
    [[ "$(stat -Lc '%d:%i:%s:%y:%z' -- "${held}")" == "${before}" ]] || fail source_changed
    check_parent
    actual=${size}
fi
emit "{\"event\":\"complete\",\"bytes\":${actual:-${size}},\"sha256\":\"${hash}\"}"
