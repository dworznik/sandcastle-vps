# shellcheck shell=bash
#
# Upsert a single key in a .env file, leaving every other line byte-for-byte
# alone — these files are hand-edited and hold more than the one key we set.
#
#   env_file_upsert <file> <key> <value> <seed|rotate>
#
#     seed   — fill the key in only if it has no value yet; never clobber a
#              value the operator chose. An empty `KEY=` (what `sandcastle
#              init` scaffolds) counts as having no value.
#     rotate — replace whatever is there. For stamping a reissued token.
#
# The file holds a credential, so it is always left readable only by its owner.

env_file_upsert() {
  local file="$1" key="$2" value="$3" mode="${4:-seed}"

  case "$mode" in
    seed | rotate) ;;
    *)
      echo "env_file_upsert: mode must be seed or rotate, got: ${mode}" >&2
      return 1
      ;;
  esac

  mkdir -p "$(dirname "$file")"
  [ -f "$file" ] || (umask 077 && : > "$file")

  local tmp
  tmp="$(umask 077 && mktemp "${file}.XXXXXX")"
  # The temp sits next to the file so the mv is atomic, which means it also
  # sits inside the tree the operator is told to commit — and .gitignore
  # covers `.env`, not `.env.a1B2c3`. Clear it however we leave.
  trap 'rm -f "$tmp"' RETURN

  # The key and value reach awk through the environment, not -v: -v processes
  # backslash escapes, which would mangle a token containing them. Matching is
  # by literal prefix rather than regex for the same reason.
  if ! EF_KEY="$key" EF_VALUE="$value" EF_MODE="$mode" awk '
    BEGIN {
      prefix = ENVIRON["EF_KEY"] "="
      line   = prefix ENVIRON["EF_VALUE"]
      mode   = ENVIRON["EF_MODE"]
      found  = 0
    }
    substr($0, 1, length(prefix)) == prefix {
      found = 1
      # In seed mode an existing value wins; a bare `KEY=` has none to defend.
      print (mode == "rotate" || $0 == prefix) ? line : $0
      next
    }
    { print }
    END { if (!found) print line }
  ' "$file" > "$tmp"; then
    # Without this the mv below would happily install a half-written or empty
    # file over the operator's credentials.
    echo "env_file_upsert: failed to rewrite ${file}; it is unchanged" >&2
    return 1
  fi

  chmod 600 "$tmp"
  mv "$tmp" "$file"
}
