#!/usr/bin/env bash
# 一键发布：./release.sh 1.10.8
# 自动改版本号 → 语法校验 → commit → 打 tag → push →（可选）创建 GitHub Release
set -euo pipefail
cd "$(dirname "$0")"

NEW="${1:-}"
if [[ -z "$NEW" ]]; then
  echo "用法：./release.sh <新版本号>，例如 ./release.sh 1.10.8"
  exit 1
fi
if ! [[ "$NEW" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "版本号必须是 x.y.z，例如 1.10.8"
  exit 1
fi
if [[ -n "$(git status --porcelain)" ]]; then
  echo "工作区有未提交的改动，请先 commit 或 stash："
  git status --short
  exit 1
fi
if git rev-parse "$NEW" >/dev/null 2>&1; then
  echo "tag $NEW 已存在，换一个版本号"
  exit 1
fi

python3 - "$NEW" <<'PY'
import json, sys
new = sys.argv[1]
m = json.load(open('manifest.json', encoding='utf-8'))
old = m['version']
m['version'] = new
open('manifest.json', 'w', encoding='utf-8').write(
    json.dumps(m, ensure_ascii=False, indent=2) + '\n')

min_app = json.load(open('versions.json', encoding='utf-8')).get(old, '1.14.0')
open('versions.json', 'w', encoding='utf-8').write(
    json.dumps({new: min_app}, ensure_ascii=False, indent=2) + '\n')

s = open('main.js', encoding='utf-8').read()
s = s.replace('v' + old, 'v' + new)
open('main.js', 'w', encoding='utf-8').write(s)
print(f'版本：{old} → {new}（minAppVersion {min_app}）')
PY

node --check main.js
echo "语法校验通过"

git add -A
git commit -m "Release v$NEW"
git tag -a "$NEW" -m "$NEW"
git push origin main
git push origin "$NEW"
echo "已推送 main 与 tag $NEW"

if command -v gh >/dev/null 2>&1; then
  gh release create "$NEW" main.js manifest.json styles.css \
    --title "$NEW" --notes "Release $NEW"
  echo "GitHub Release $NEW 已创建"
else
  echo ""
  echo "未安装 gh，请打开下面链接创建 Release，并上传 main.js / manifest.json / styles.css："
  echo "https://github.com/tmdt5217/external-vault/releases/new?tag=$NEW"
fi

# macOS：在 Finder 中选中三个待上传文件，方便直接拖进 Release 页面
if [[ "$(uname)" == "Darwin" ]]; then
  osascript <<APPLESCRIPT >/dev/null 2>&1 || true
tell application "Finder"
  activate
  reveal {POSIX file "$PWD/main.js", POSIX file "$PWD/manifest.json", POSIX file "$PWD/styles.css"}
end tell
APPLESCRIPT
fi
