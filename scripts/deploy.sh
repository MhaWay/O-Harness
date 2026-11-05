#!/usr/bin/env bash
# One-shot deploy to the host machine (see README Production section).
# Raw tar, NO -h: workspace symlinks under node_modules/@o-harness/* are load-bearing.
set -euo pipefail
cd "$(dirname "$0")/.."
TAR=$(mktemp /tmp/oh-repo-XXXX.tar)
trap 'rm -f "$TAR"' EXIT
tar --exclude=.git -cf "$TAR" .
echo "tar $(stat -c %s "$TAR") bytes"
docker rm -f o-harness 2>/dev/null || true
cat "$TAR" | docker run -i --rm --privileged -v /:/host alpine sh -c '
  rm -rf /tmp/oh-ex /host/opt/o-harness
  mkdir -p /tmp/oh-ex /host/opt
  tar -xf - -C /tmp/oh-ex && mv /tmp/oh-ex /host/opt/o-harness && echo EXTRACT-OK
  # kill stray gateway processes on the host (e.g. manual test runs) so the port is free
  chroot /host sh -c "pkill -f packages/gateway/src/bin.ts 2>/dev/null" || true
  exit 0
' 2>&1 | tail -1
docker run -d --name o-harness --restart=unless-stopped --net=host -v /:/host \
  --health-cmd 'wget -q -T3 -O /dev/null http://127.0.0.1:18711/health' --health-interval 30s --health-timeout 5s --health-retries 3 \
  alpine sh -c \
  'exec chroot /host env HOME=/root node --experimental-strip-types --no-warnings /opt/o-harness/packages/gateway/src/bin.ts --host 0.0.0.0 --port 18711' >/dev/null
# Poll up to 60s: container cold start can take ~20s+ (node strips TS at startup).
# Use host curl when available (cheap); fall back to one docker run per poll.
for i in $(seq 1 60); do
  sleep 1
  if command -v curl >/dev/null 2>&1; then
    ok=$(curl -s -m 2 http://127.0.0.1:18711/health 2>/dev/null || true)
  else
    ok=$(docker run --rm --net=host alpine sh -c 'wget -q -T3 -O- http://127.0.0.1:18711/health' 2>/dev/null || true)
  fi
  if echo "$ok" | grep -q '"ok":true'; then
    echo DEPLOY-OK "(healthy after ${i}s)"; exit 0
  fi
done
echo DEPLOY-FAIL; docker logs --tail 15 o-harness 2>&1 | tail -15; exit 1
