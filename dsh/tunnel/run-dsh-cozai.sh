#!/bin/sh
# dsh-cozai cloudflared tunnel 启动包装：清除代理环境变量（Go cloudflared 会读
# http_proxy/https_proxy/all_proxy，本机 Clash 7897 代理会劫持 Cloudflare 隧道连接，
# 简报33 已实证），再 exec cloudflared 直连（TUN 路由，域已真实 IP）。
exec env -u http_proxy -u https_proxy -u all_proxy -u HTTP_PROXY -u HTTPS_PROXY \
  -u ALL_PROXY -u no_proxy -u NO_PROXY \
  /Users/qinshu/.local/bin/cloudflared tunnel run --token "${DSH_COZAI_TOKEN:?DSH_COZAI_TOKEN required}"
