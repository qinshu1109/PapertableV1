# 素材库：Bilibili 视频与评论

本目录收录了 3 个 Bilibili 视频素材，包含完整 720P MP4 视频文件、视频元数据、评论列表（JSON / JSONL 结构）以及中文字幕（SRT / VTT / TXT / JSON 格式）。

| BVID | 标题 | UP 主 | 视频体积 | 播放量 | 点赞 | 评论数 | 字幕句数 | 目录 |
|---|---|---|---|---|---|---|---|---|
| [BV1RttR6SE4M](https://www.bilibili.com/video/BV1RttR6SE4M) | 飞书 CLI 才是个人工作台的最优解 | oil欧呦 | 26.90 MB | 3996 | 89 | 21 | 263 句 | [`BV1RttR6SE4M`](./BV1RttR6SE4M/README.md) |
| [BV173tN6EEXD](https://www.bilibili.com/video/BV173tN6EEXD) | 独立开发做社媒不知道发什么怎么办？ | oil欧呦 | 10.33 MB | 1423 | 47 | 3 | 141 句 | [`BV173tN6EEXD`](./BV173tN6EEXD/README.md) |
| [BV1rX8H63EUQ](https://www.bilibili.com/video/BV1rX8H63EUQ) | DeepSeek Harness 内容创作工作台开源啦 | oil欧呦 | 31.14 MB | 6088 | 230 | 25 | 225 句 | [`BV1rX8H63EUQ`](./BV1rX8H63EUQ/README.md) |

| [BV1jv3c6tEbJ](https://www.bilibili.com/video/BV1jv3c6tEbJ) | 一个agent搞定手绘动画3.0。一键从字幕到成片，整个手绘过程，一个token都没烧。 | 江哥是老登啊 | 14.80 MB | 30546 | 1477 | 941 | - | [`BV1jv3c6tEbJ`](./BV1jv3c6tEbJ/README.md) |

## 目录结构
```
materials/
├── README.md
├── BV1RttR6SE4M/
│   ├── video.mp4
│   ├── meta.json
│   ├── comments.json
│   ├── comments.jsonl
│   ├── subtitle.srt      # 标准 SRT 字幕
│   ├── subtitle.vtt      # WebVTT 字幕
│   ├── subtitle.txt      # 纯文本转录
│   ├── subtitle.json     # 原始带时间戳的 JSON 字幕
│   └── README.md
├── BV173tN6EEXD/
│   ├── video.mp4
│   ├── meta.json
│   ├── comments.json
│   ├── comments.jsonl
│   ├── subtitle.srt
│   ├── subtitle.vtt
│   ├── subtitle.txt
│   ├── subtitle.json
│   └── README.md
└── BV1rX8H63EUQ/
    ├── video.mp4
    ├── meta.json
    ├── comments.json
    ├── comments.jsonl
    ├── subtitle.srt
    ├── subtitle.vtt
    ├── subtitle.txt
    ├── subtitle.json
    └── README.md
```
