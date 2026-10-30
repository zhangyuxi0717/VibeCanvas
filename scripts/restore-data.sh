#!/usr/bin/env bash
# 从备份包恢复本地数据目录。
#
#   bash scripts/restore-data.sh <备份包.tar.gz> <目标目录> [--force]
#
# 默认拒绝写入非空目录，避免把线上正在用的数据盖掉。
# 恢复后要么把 DATA_DIR 指向目标目录，要么把内容搬回线上目录再启动服务。
set -euo pipefail

FILE="${1:-}"
TARGET="${2:-}"
FORCE="${3:-}"

if [ -z "$FILE" ] || [ -z "$TARGET" ]; then
  echo "用法：restore-data.sh <备份包.tar.gz> <目标目录> [--force]" >&2
  exit 2
fi
if [ ! -f "$FILE" ]; then
  echo "备份包不存在：$FILE" >&2
  exit 2
fi
if [ -e "$TARGET" ] && [ -n "$(ls -A "$TARGET" 2>/dev/null)" ] && [ "$FORCE" != "--force" ]; then
  echo "目标目录非空：$TARGET。确认要覆盖请追加 --force。" >&2
  exit 2
fi

mkdir -p "$TARGET"
tar -xzf "$FILE" -C "$TARGET"
# 备份包内层是 data/，解出来会把内容放进 <目标>/data；这里统一摊平到目标目录。
if [ -d "$TARGET/data" ] && [ ! -f "$TARGET/image-tasks.json" ]; then
  (cd "$TARGET/data" && tar -cf - .) | (cd "$TARGET" && tar -xf -)
  rm -rf "$TARGET/data"
fi

echo "已恢复到：$TARGET"
ls -1 "$TARGET"
