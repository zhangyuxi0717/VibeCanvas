#!/usr/bin/env bash
# 备份本地数据目录：配图任务记录、生成的图片、产品事件、反馈。
#
#   bash scripts/backup-data.sh [输出目录]      # 默认 ./backups
#   DATA_DIR=/var/lib/vibecanvas/data bash scripts/backup-data.sh /vol/backups
#
# 只备份文件，不停服务。配图任务写入是「整文件重写 + 原子替换」，
# 压缩包里最多丢正在写的那一条，不会得到半个 JSON。
set -euo pipefail

DATA_DIR="${DATA_DIR:-./data}"
OUT_DIR="${1:-./backups}"

if [ ! -d "$DATA_DIR" ]; then
  echo "数据目录不存在：$DATA_DIR" >&2
  exit 2
fi

DATA_DIR="$(cd "$DATA_DIR" && pwd)"
PARENT="$(dirname "$DATA_DIR")"
NAME="$(basename "$DATA_DIR")"
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$OUT_DIR/vibecanvas-data-$STAMP.tar.gz"

tar -czf "$FILE" -C "$PARENT" "$NAME"
SIZE="$(du -h "$FILE" | cut -f1)"
COUNT="$(tar -tzf "$FILE" | wc -l | tr -d ' ')"

echo "备份完成：$FILE（$SIZE，$COUNT 个条目）"
echo "恢复：bash scripts/restore-data.sh \"$FILE\" <目标目录>"
