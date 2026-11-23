#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

mode=build-and-push
case ${1:-} in
  --build-only|--push-only) mode=${1#--}; shift ;;
esac
if (( $# > 2 )); then
  fail "Usage: $0 [--build-only|--push-only] [BUILD_ENV] [MIRROR_DOMAIN]"
fi

build_env=${1:-}
if [[ -n $build_env && $build_env != /* ]]; then
  build_env="$PWD/$build_env"
fi
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
build_env=${build_env:-./local-only/.build.env}
[[ -f $build_env && -r $build_env ]] || fail "Build env file is missing or unreadable: $build_env"
source "$build_env"
# Keep mirror settings in this shell, including the legacy setting name.
export -n MIRROR_DOMAIN BUILD_DOMAIN

: "${BUILD_USERNAME:?Set BUILD_USERNAME in the build env file}"
BUILD_APP_NAME=${BUILD_APP_NAME:-reolink-wui}
: "${BUILD_VERSION:?Set BUILD_VERSION in the build env file}"
[[ $BUILD_VERSION != latest ]] || fail "Use a release version for BUILD_VERSION"

BUILDER_BIN=${BUILDER_BIN:-${BUILD_BUILDER:-podman}}
command -v "$BUILDER_BIN" >/dev/null || fail "Build command not found: $BUILDER_BIN"

version=$(jq -er '.version | strings | select(length > 0)' package.json)
[[ ${BUILD_VERSION#v} == "$version" ]] ||
  fail "package.json reports $version, expected $BUILD_VERSION"

git_sha=$(git rev-parse --verify HEAD)
release_ref="refs/tags/$BUILD_VERSION"
if git show-ref --verify --quiet "$release_ref"; then
  tag_sha=$(git rev-parse --verify "$release_ref^{commit}")
  [[ $tag_sha == "$git_sha" ]] || fail "Release tag $BUILD_VERSION points to a different commit"
fi

build_hash=$(git rev-parse --short=12 "$git_sha")
build_date=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
ci_run_id=${BUILD_CI_RUN_ID:-${CI_RUN_ID:-local}}
git_status=$(git status --porcelain)
git_dirty=false
if [[ -n $git_status ]]; then
  git_dirty=true
fi

commit_tag="$BUILD_VERSION-$build_hash"
tag_pattern='^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$'
[[ $commit_tag =~ $tag_pattern ]] || fail "Invalid commit tag: $commit_tag"

read -r -a custom_tags <<< "${PUSH_TAGS:-}"
for tag in "${custom_tags[@]}"; do
  [[ $tag =~ $tag_pattern ]] || fail "Invalid push tag: $tag"
  if [[ $tag == latest && ! $BUILD_VERSION =~ ^v?[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    fail "Publishing latest requires a stable release version"
  fi
done
tags=("$commit_tag" "$BUILD_VERSION" "${custom_tags[@]}")

image="$BUILD_APP_NAME:$commit_tag"
if [[ $mode != push-only ]]; then
  "$BUILDER_BIN" build -f ./Dockerfile \
    --build-arg "BUILD_HASH=$build_hash" \
    --build-arg "BUILD_VERSION=$BUILD_VERSION" \
    --build-arg "BUILD_DATE=$build_date" \
    --build-arg "GIT_SHA=$git_sha" \
    --build-arg "GIT_DIRTY=$git_dirty" \
    --build-arg "CI_RUN_ID=$ci_run_id" \
    --label "org.opencontainers.image.title=$BUILD_APP_NAME" \
    -t "$image" .
fi

# Resolve the image once so every release tag publishes the inspected content.
image_id=$("$BUILDER_BIN" image inspect --format '{{.Id}}' "$image")
image_revision=$("$BUILDER_BIN" image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_id")
image_version=$("$BUILDER_BIN" image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "$image_id")
[[ $image_revision == "$git_sha" && $image_version == "$BUILD_VERSION" ]] ||
  fail "The local image $image does not match revision $git_sha and version $BUILD_VERSION"
if [[ $mode == build-only ]]; then
  printf 'Built %s (%s)\n' "$image" "$image_id"
  exit 0
fi

primary="docker.io/$BUILD_USERNAME/$BUILD_APP_NAME"
destinations=("$primary")
mirror_domain=${2:-${MIRROR_DOMAIN-${BUILD_DOMAIN:-}}}
if [[ -n $mirror_domain && $mirror_domain != docker.io ]]; then
  destinations+=("$mirror_domain/$BUILD_USERNAME/$BUILD_APP_NAME")
fi

publish_status=0
record_publish_failure() {
  local status=$1
  local message=$2

  printf '%s (exit %d)\n' "$message" "$status" >&2
  if (( publish_status == 0 )); then
    publish_status=$status
  fi
}

for destination in "${destinations[@]}"; do
  for tag in "${tags[@]}"; do
    ref="$destination:$tag"
    "$BUILDER_BIN" tag "$image_id" "$ref" || {
      record_publish_failure "$?" "Failed to tag $ref"
      continue
    }
    "$BUILDER_BIN" push "$ref" ||
      record_publish_failure "$?" "Failed to push $ref"
    if [[ $destination != "$primary" ]]; then
      "$BUILDER_BIN" image rm "$ref" >/dev/null ||
        record_publish_failure "$?" "Failed to remove temporary mirror tag $ref"
    fi
  done
done

exit "$publish_status"
