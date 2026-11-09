if [[ "${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]}" != "$1" ]]; then
  echo "Shell version mismatch" >&2
  exit 125
fi
shift
