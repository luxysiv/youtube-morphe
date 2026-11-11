#!/usr/bin/env bash
#
# Patch YouTube via Morphe CLI — pure bash (curl + sed/awk, no Node/Playwright).
#
# Logic tương đương bản Node cũ:
#   1. Tải morphe-desktop (CLI) + morphe-patches mới nhất từ GitHub.
#   2. Bỏ qua nếu đúng version patches đã từng release.
#   3. Lấy danh sách version YouTube tương thích, chọn version mới nhất.
#   4. Tải APK gốc (chưa patch) từ APKMirror (cache theo version).
#   5. Patch APK bằng Morphe CLI.
#   6. Upload APK đã patch + MicroG lên GitHub Release.
#
# Yêu cầu: bash, curl, java (21+), sed, awk, grep, coreutils.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
API="https://api.github.com"
TOKEN="${GITHUB_TOKEN:-}"
REPO="${GITHUB_REPOSITORY:-}"

CACHE_DIR="$ROOT_DIR/downloads"
MIN_APK_SIZE=$((1024 * 1024)) # 1 MB
MIN_FILE_SIZE=1024

TMP_DIR="$(mktemp -d)"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

log() { printf '%s\n' "$*"; }
die() {
  printf '\n❌ ERROR: %s\n' "$*" >&2
  exit 1
}

# ================= UTIL =================

GH_HEADERS=(-H "User-Agent: node" -H "Accept: application/vnd.github+json")
if [ -n "$TOKEN" ]; then
  GH_HEADERS+=(-H "Authorization: Bearer $TOKEN")
fi

# GET GitHub API -> file, in ra HTTP status code.
gh_get() { # url outfile
  curl -sS --retry 5 --retry-delay 2 --retry-all-errors \
    -o "$2" -w '%{http_code}' "${GH_HEADERS[@]}" "$1"
}

# Lấy giá trị string RAW (giữ nguyên escape JSON) của key ở top-level.
json_raw_string() { # key < json
  awk -v key="\"$1\":" '
    {
      i = index($0, key)
      if (!i) next
      rest = substr($0, i + length(key))
      sub(/^[[:space:]]*/, "", rest)
      if (substr(rest, 1, 1) != "\"") exit
      out = ""; esc = 0
      for (j = 2; j <= length(rest); j++) {
        c = substr(rest, j, 1)
        if (esc) { out = out "\\" c; esc = 0 }
        else if (c == "\\") { esc = 1 }
        else if (c == "\"") { break }
        else { out = out c }
      }
      print out
      exit
    }'
}

# Danh sách tên asset trong release JSON (bỏ phần body để tránh nhiễu).
json_asset_names() {
  sed 's/"body":.*//' | grep -o '"name":"[^"]*"' | sed 's/^"name":"//; s/"$//'
}

# URL tải của asset có tên cho trước.
json_asset_url() { # name < json
  local name="$1" url
  while IFS= read -r url; do
    case "$url" in
      */"$name") printf '%s\n' "$url"; return 0 ;;
    esac
  done < <(sed 's/"body":.*//' | grep -o '"browser_download_url":"[^"]*"' | sed 's/^"browser_download_url":"//; s/"$//')
  return 1
}

# Tìm id của asset theo tên trong JSON array của /releases/{id}/assets.
json_asset_id_by_name() { # name < json
  local target="$1"
  awk -v target="$target" '
    {
      s = $0
      pos = 1
      while (1) {
        p = index(substr(s, pos), "\"name\":\"")
        if (p == 0) break
        start = pos + p - 1
        vstart = start + 8
        q = index(substr(s, vstart), "\"")
        if (q == 0) break
        nm = substr(s, vstart, q - 1)
        if (nm == target) {
          pre = substr(s, 1, start - 1)
          lp = 0; pp = 1
          while (1) {
            x = index(substr(pre, pp), "\"id\":")
            if (x == 0) break
            lp = pp + x - 1
            pp = lp + 1
          }
          if (lp > 0) {
            rest = substr(pre, lp + 5)
            num = ""
            for (k = 1; k <= length(rest); k++) {
              c = substr(rest, k, 1)
              if (c ~ /[0-9]/) num = num c
              else break
            }
            if (num != "") { print num; exit }
          }
        }
        pos = vstart + q
      }
    }'
}

# ================= GITHUB RELEASE ASSETS =================

fetch_latest_release() { # owner repo outfile
  local owner="$1" repo="$2" out="$3" code
  log "📦 Fetch release: $owner/$repo"
  code="$(gh_get "$API/repos/$owner/$repo/releases/latest" "$out")"
  [ "$code" = "200" ] || die "GitHub API error: $code ($owner/$repo)"
  grep -q '"assets":\[' "$out" || die "GitHub API trả về dữ liệu không hợp lệ"
}

select_asset_name() { # jsonfile kind
  local file="$1" kind="$2"
  case "$kind" in
    desktop)
      json_asset_names <"$file" | grep -i 'desktop' | grep '\.jar$' | head -n 1 || true
      ;;
    patches)
      json_asset_names <"$file" | grep '\.mpp$' | head -n 1 || true
      ;;
    apk)
      json_asset_names <"$file" | grep '\.apk$' | head -n 1 || true
      ;;
    *)
      return 1
      ;;
  esac
}

download_asset() { # url name
  local url="$1" name="$2"

  case "$url" in
    https://github.com/* | https://objects.githubusercontent.com/* | https://release-assets.githubusercontent.com/*) ;;
    *) die "❌ Asset host không đáng tin: $url" ;;
  esac

  if [ -f "$name" ] && [ "$(wc -c <"$name")" -ge "$MIN_FILE_SIZE" ]; then
    log "⚡ Skip cached: $name"
    GH_ASSET_PATH="$name"
    return 0
  fi
  rm -f "$name" "$name.part"

  curl -fL --retry 5 --retry-delay 2 --retry-all-errors \
    -A "node" -H "Accept: */*" -C - -o "$name.part" "$url" ||
    die "Download failed: $url"

  [ "$(wc -c <"$name.part")" -ge "$MIN_FILE_SIZE" ] || {
    rm -f "$name.part"
    die "Downloaded file quá nhỏ: $name"
  }

  mv -f "$name.part" "$name"
  log "✅ Done: $name"
  GH_ASSET_PATH="$name"
}

# Tải asset mới nhất khớp `kind`, set GH_ASSET_PATH / GH_TAG / GH_BODY.
download_latest_asset() { # owner repo kind
  local owner="$1" repo="$2" kind="$3"
  local meta="$TMP_DIR/release-$repo.json" name url tag

  fetch_latest_release "$owner" "$repo" "$meta"

  tag="$(json_raw_string tag_name <"$meta")"
  name="$(select_asset_name "$meta" "$kind")"
  [ -n "$name" ] || die "❌ Không tìm thấy asset ($kind) trong $owner/$repo"

  log "🎯 Selected: $name"

  url="$(json_asset_url "$name" <"$meta" || true)"
  if [ -z "$url" ]; then
    url="https://github.com/$owner/$repo/releases/download/$tag/$name"
  fi

  download_asset "$url" "$name"

  GH_TAG="$tag"
  GH_BODY="$(json_raw_string body <"$meta" || true)"
}

# ================= STATE =================

build_patches_marker() { printf '<!-- patches-version: %s -->' "$1"; }

is_patches_version_already_released() { # patchesTag
  local tag="$1" marker json count page

  [ -n "$tag" ] || return 1

  if [ -z "$TOKEN" ] || [ -z "$REPO" ]; then
    log "⚠️ Missing GITHUB_TOKEN/GITHUB_REPOSITORY - bỏ qua kiểm tra patch cũ/mới"
    return 1
  fi

  marker="$(build_patches_marker "$tag")"

  for page in 1 2 3 4 5; do
    json="$TMP_DIR/releases-$page.json"
    gh_get "$API/repos/$REPO/releases?per_page=30&page=$page" "$json" >/dev/null || return 1

    grep -qF "$marker" "$json" && return 0

    count="$(grep -o '"tag_name"' "$json" | wc -l | tr -d ' ')"
    [ "$count" -lt 30 ] && break
  done

  return 1
}

# ================= VERSIONS =================

extract_youtube_versions() { # file -> "version patches" mỗi dòng
  local file="$1" out

  out="$(sed -n '/Most common compatible versions/,/^[[:space:]]*$/p' "$file" |
    sed -nE 's/^[[:space:]]*([0-9]+\.[0-9]+\.[0-9]+)[[:space:]]+\(([0-9]+)[[:space:]]+patches\).*/\1 \2/p')"

  if [ -z "$out" ]; then
    out="$(grep -oE '[0-9]+\.[0-9]+\.[0-9]+' "$file" | awk '{ print $1, 0 }' | sort -u)"
  fi

  printf '%s\n' "$out"
}

pick_latest_version() { # stdin: "version patches"
  awk '
    NF >= 2 {
      split($1, a, ".")
      score = a[1] * 1000000 + a[2] * 1000 + a[3]
      if ($2 > bestPatches || ($2 == bestPatches && score > bestScore)) {
        bestPatches = $2
        bestScore = score
        best = $1
      }
    }
    END { if (best != "") print best }'
}

to_apkmirror_version() { printf '%s' "$1" | tr '.' '-'; }

# ================= APKMIRROR =================

is_valid_apk() { # path
  [ -f "$1" ] && [ "$(wc -c <"$1")" -ge "$MIN_APK_SIZE" ]
}

get_apk_cache_path() { printf '%s/youtube-%s-universal.apk' "$CACHE_DIR" "$1"; }

find_cached_apk() { # version
  local version="$1" canonical f n
  canonical="$(get_apk_cache_path "$version")"

  if is_valid_apk "$canonical"; then
    printf '%s\n' "$canonical"
    return 0
  fi

  [ -d "$CACHE_DIR" ] || return 1

  for f in "$CACHE_DIR"/*.apk; do
    [ -e "$f" ] || continue
    n="$(basename "$f")"
    case "$n" in
      "youtube-${version}-"* | "com.google.android.youtube_${version}"* | "YouTube_${version}"*)
        if is_valid_apk "$f"; then
          printf '%s\n' "$f"
          return 0
        fi
        ;;
    esac
  done

  return 1
}

prune_apk_cache() { # keepPath
  local keep="$1" f n
  [ -d "$CACHE_DIR" ] || return 0
  keep="$(cd "$(dirname "$keep")" && pwd)/$(basename "$keep")"

  for f in "$CACHE_DIR"/*.apk "$CACHE_DIR"/*.part; do
    [ -e "$f" ] || continue
    f="$(cd "$(dirname "$f")" && pwd)/$(basename "$f")"
    [ "$f" = "$keep" ] && continue
    n="$(basename "$f")"
    rm -f "$f" && log "🧹 Pruned cached APK: $n"
  done
}

fetch_html() { # url outfile [referer]
  local url="$1" out="$2" ref="${3:-}"
  if [ -n "$ref" ]; then
    curl -fsSL --retry 3 --retry-delay 2 --retry-all-errors -A "$UA" -e "$ref" -o "$out" "$url" ||
      return 1
  else
    curl -fsSL --retry 3 --retry-delay 2 --retry-all-errors -A "$UA" -o "$out" "$url" ||
      return 1
  fi
}

# Tìm URL variant "APK / universal / nodpi" trong trang release của APKMirror.
parse_apkmirror_variant() { # htmlfile
  awk -v RS='<div class="table-row' 'BEGIN { ORS = "\n" }
    NR > 1 {
      block = substr($0, 1, 3000)
      text = tolower(block)
      gsub(/<[^>]*>/, " ", text)
      if (text ~ /apk/ && text !~ /bundle/ && text ~ /universal/ && text ~ /nodpi/) {
        if (match(block, /<a class="accent_color" href="[^"]+"/)) {
          h = substr(block, RSTART, RLENGTH)
          sub(/.*href="/, "", h)
          sub(/"$/, "", h)
          print h
          exit
        }
      }
    }' "$1"
}

# Lấy href của nút download trên trang variant.
parse_download_button() { # htmlfile
  awk '
    {
      if (index($0, "downloadButton") == 0) next
      if (match($0, /href="[^"]+"/)) {
        h = substr($0, RSTART, RLENGTH)
        sub(/^href="/, "", h)
        sub(/"$/, "", h)
        print h
        exit
      }
    }' "$1"
}

# Lấy href của link tải cuối cùng (#download-link) trên trang download.
parse_download_link() { # htmlfile
  awk '
    {
      if (index($0, "id=\"download-link\"") == 0) next
      if (match($0, /href="[^"]+"/)) {
        h = substr($0, RSTART, RLENGTH)
        sub(/^href="/, "", h)
        sub(/"$/, "", h)
        print h
        exit
      }
    }' "$1"
}

download_apk() { # version -> in ra path
  local version="$1" cached slug list_url rel_html variant variant_url var_html
  local dl_page dl_html dl_link cache_path temp_path

  if cached="$(find_cached_apk "$version")"; then
    log "⚡ Cache hit: reuse APK $version"
    log "📦 CACHED APK: $cached"
    prune_apk_cache "$cached"
    APK_PATH="$cached"
    return 0
  fi

  log "📥 Cache miss: download APK $version"

  mkdir -p "$CACHE_DIR"

  slug="$(to_apkmirror_version "$version")"
  list_url="https://www.apkmirror.com/apk/google-inc/youtube/youtube-${slug}-release/"

  log "🌐 LIST: $list_url"

  rel_html="$TMP_DIR/apkmirror-list.html"
  fetch_html "$list_url" "$rel_html" || die "Không tải được trang APKMirror: $list_url"

  variant="$(parse_apkmirror_variant "$rel_html")"
  [ -n "$variant" ] || die "No variant found"

  variant_url="https://www.apkmirror.com$variant"
  log "➡️ VARIANT: $variant_url"

  var_html="$TMP_DIR/apkmirror-variant.html"
  fetch_html "$variant_url" "$var_html" || die "Không tải được trang variant: $variant_url"

  local button
  button="$(parse_download_button "$var_html")"
  [ -n "$button" ] || die "Không tìm thấy nút download"

  dl_page="https://www.apkmirror.com$button"
  dl_html="$TMP_DIR/apkmirror-download.html"
  fetch_html "$dl_page" "$dl_html" "$variant_url" || die "Không tải được trang download: $dl_page"

  dl_link="$(parse_download_link "$dl_html")"
  [ -n "$dl_link" ] || die "Không tìm thấy link tải APK"

  cache_path="$(get_apk_cache_path "$version")"
  temp_path="$cache_path.part"

  log "⬇️ Downloading APK..."
  if ! curl -fL --retry 5 --retry-delay 2 --retry-all-errors \
    -A "$UA" -e "$dl_page" -o "$temp_path" "https://www.apkmirror.com$dl_link"; then
    rm -f "$temp_path"
    die "Download APK thất bại"
  fi

  if ! is_valid_apk "$temp_path"; then
    rm -f "$temp_path"
    die "Downloaded APK is invalid/too small: $temp_path"
  fi

  mv -f "$temp_path" "$cache_path"
  log "💾 Cached APK: $cache_path"

  prune_apk_cache "$cache_path"
  APK_PATH="$cache_path"
}

# ================= PATCH =================

patch_apk() { # desktop patches apk -> PATCHED_APK
  local desktop="$1" patches="$2" apk="$3" logfile="$TMP_DIR/patch.log" code out
  local out_file="$TMP_DIR/patched.apk"

  log ""
  log "🛠️ Patching APK..."
  log ""

  rm -f "$out_file"

  set +e
  java -jar "$desktop" patch --patches="$patches" --out="$out_file" "$apk" 2>&1 | tee "$logfile"
  code="${PIPESTATUS[0]}"
  set -e

  [ "$code" -eq 0 ] || die "Patch failed with exit code $code"

  if [ -f "$out_file" ]; then
    out="$out_file"
  else
    out="$(sed -E 's/\x1B\[[0-9;]*[A-Za-z]//g' "$logfile" | tr -d '\r' |
      sed -n 's/.*INFO:[[:space:]]*Saved to[[:space:]]*\(.*\.apk\).*/\1/p' | tail -n 1)"
  fi

  [ -n "$out" ] || die "Cannot find patched APK path in output"
  [ -f "$out" ] || die "Patched APK does not exist: $out"

  log ""
  log "✅ Patch done"
  log "📦 Output: $out"

  PATCHED_APK="$out"
}

# ================= RELEASE UPLOAD =================

build_release_body() { # patchesTag rawBody -> body (JSON-escaped)
  local tag="${1:-unknown}" notes="${2:-}" marker
  marker="$(build_patches_marker "$tag")"
  [ -n "$notes" ] || notes="_Không có ghi chú release._"

  printf '## 📦 Morphe Patches\\n**Version:** `%s`\\n\\n%s\\n\\n%s' "$tag" "$notes" "$marker"
}

get_or_create_release() { # tag body
  local tag="$1" body="$2" resp="$TMP_DIR/release-target.json" code payload

  code="$(gh_get "$API/repos/$REPO/releases/tags/$tag" "$resp")"

  if [ "$code" = "404" ]; then
    log "🆕 Creating release: $tag"
    payload="$TMP_DIR/release-payload.json"
    printf '{"tag_name":"%s","name":"%s","body":"%s","draft":false,"prerelease":false}' \
      "$tag" "$tag" "$body" >"$payload"

    code="$(curl -sS -o "$resp" -w '%{http_code}' --retry 5 --retry-delay 2 --retry-all-errors \
      -X POST "${GH_HEADERS[@]}" -H "Content-Type: application/json" \
      --data-binary @"$payload" "$API/repos/$REPO/releases")"
    [ "$code" = "201" ] || die "Tạo release thất bại (HTTP $code)"
  elif [ "$code" = "200" ]; then
    local id
    id="$(grep -o '"id":[0-9]*' "$resp" | head -n 1 | cut -d: -f2)"
    [ -n "$id" ] || die "Không lấy được release id"

    log "📝 Updating release body: $tag"
    payload="$TMP_DIR/release-payload.json"
    printf '{"body":"%s"}' "$body" >"$payload"

    code="$(curl -sS -o "$resp" -w '%{http_code}' --retry 5 --retry-delay 2 --retry-all-errors \
      -X PATCH "${GH_HEADERS[@]}" -H "Content-Type: application/json" \
      --data-binary @"$payload" "$API/repos/$REPO/releases/$id")"
    [ "$code" = "200" ] || die "Cập nhật release thất bại (HTTP $code)"
  else
    die "GitHub API error: $code (release $tag)"
  fi

  RELEASE_ID="$(grep -o '"id":[0-9]*' "$resp" | head -n 1 | cut -d: -f2)"
  UPLOAD_URL="$(json_raw_string upload_url <"$resp" | sed 's/{?name,label}$//')"
  [ -n "$RELEASE_ID" ] || die "Không lấy được release id"
  [ -n "$UPLOAD_URL" ] || die "Không lấy được upload_url"
}

urlencode_name() {
  printf '%s' "$1" | sed -e 's/%/%25/g' -e 's/ /%20/g'
}

upload_with_replace() { # file
  local file="$1" name assets aid
  name="$(basename "$file")"

  assets="$TMP_DIR/release-assets.json"
  gh_get "$API/repos/$REPO/releases/$RELEASE_ID/assets" "$assets" >/dev/null ||
    die "Không lấy được danh sách asset"

  aid="$(json_asset_id_by_name "$name" <"$assets" || true)"
  if [ -n "$aid" ]; then
    log "♻️ Replace: $name"
    curl -fsS -X DELETE "${GH_HEADERS[@]}" "$API/repos/$REPO/releases/assets/$aid" >/dev/null ||
      die "Xoá asset cũ thất bại: $name"
  fi

  log "📤 Upload: $name"
  curl -fsS -X POST --retry 5 --retry-delay 2 --retry-all-errors \
    "${GH_HEADERS[@]}" \
    -H "Content-Type: application/vnd.android.package-archive" \
    -T "$file" \
    "$UPLOAD_URL?name=$(urlencode_name "$name")" >/dev/null ||
    die "Upload thất bại: $name"
}

upload_apk_release() { # version apkPath patchesTag patchesBody
  local version="$1" apk_path="$2" patches_tag="$3" patches_body="$4"
  local tag body microg

  [ -n "$TOKEN" ] || die "Missing GITHUB_TOKEN"
  [ -n "$REPO" ] || die "Missing GITHUB_REPOSITORY"

  tag="youtube-$version"
  body="$(build_release_body "$patches_tag" "$patches_body")"

  get_or_create_release "$tag" "$body"

  upload_with_replace "$apk_path"

  log "📦 Fetch MicroG..."
  download_latest_asset "MorpheApp" "MicroG-RE" "apk"
  microg="$GH_ASSET_PATH"

  upload_with_replace "$microg"

  log "✅ Release done"
}

# ================= MAIN =================

main() {
  local desktop patches patches_tag patches_body versions selected apk final_name final_path

  log "🚀 START"
  log ""

  # 1. Desktop CLI
  log "🌐 FETCH: morphe-desktop"
  download_latest_asset "MorpheApp" "morphe-desktop" "desktop"
  desktop="$GH_ASSET_PATH"
  log "📦 desktop: $desktop"

  # 2. Patches (kèm metadata release)
  log "🌐 FETCH: morphe-patches"
  download_latest_asset "MorpheApp" "morphe-patches" "patches"
  patches="$GH_ASSET_PATH"
  patches_tag="$GH_TAG"
  patches_body="$GH_BODY"

  log "📦 PATCHES: $patches"
  log "🏷️ Patches version: ${patches_tag:-unknown}"

  # 2b. Bỏ qua nếu version patches này đã release
  if is_patches_version_already_released "$patches_tag"; then
    log ""
    log "⏭️ SKIP: patches $patches_tag patched, skip."
    log "──────────────"
    return 0
  fi

  # 3. Extract versions
  log "⬇️ Extract versions (list-versions)..."

  local versions_file="$TMP_DIR/versions.txt"
  java -jar "$desktop" list-versions -f com.google.android.youtube --patches="$patches" \
    >"$versions_file" 2>&1 || {
    cat "$versions_file" >&2
    die "list-versions thất bại"
  }

  versions="$(extract_youtube_versions "$versions_file")"
  [ -n "$versions" ] || die "No versions found from desktop"

  log "📋 ALL VERSIONS:"
  printf '%s\n' "$versions" | awk '{ print " -", $1 }'

  selected="$(printf '%s\n' "$versions" | pick_latest_version)"
  [ -n "$selected" ] || die "Failed to pick latest version"

  log ""
  log "➡️ TARGET: $selected"

  # 4. Download APK
  log "🌐 SOURCE: APKMirror"
  download_apk "$selected"
  apk="$APK_PATH"
  log "📦 APK: $apk"

  # 5. Patch
  log "⬇️ PATCHING..."
  patch_apk "$desktop" "$patches" "$apk"
  log "📦 PATCHED: $PATCHED_APK"

  # 6. Rename / copy
  final_name="youtube-${selected}-morphe.apk"
  final_path="$ROOT_DIR/$final_name"
  cp -f "$PATCHED_APK" "$final_path"
  log "📝 FINAL: $final_path"

  # 7. Upload release
  log "🚀 UPLOAD RELEASE..."
  upload_apk_release "$selected" "$final_path" "$patches_tag" "$patches_body"

  # 8. Done
  log ""
  log "🎉 DONE"
  log "──────────────"
  log "➡️ VERSION: $selected"
  log "📦 desktop-cli: $desktop"
  log "📦 PATCHES: $patches"
  log "📦 ORIGINAL: $apk"
  log "📦 PATCHED: $PATCHED_APK"
  log "📦 OUTPUT: $final_path"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
