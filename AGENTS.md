# 在复制的非main分支下，可以自由操作
# 读文件时，使用UTF-8解码，确保中文不乱码。
# 当用户没有特别要求时，给其他模型（例如生图模型）的提示词应尽量简短，只保留必要目标和硬约束，避免用过多细节限制模型发挥。
# 维护两个版本的readme，中文和英文（写在同一个README.md文件中，英文在前中文在后）。每次修改readme的时候，同时修改两个语言的版本
# 用户用中文描述分类目录或上下文模板项时，数据库名称、页面显示名称和URL默认采用对应的英文版本；英文名称有歧义时先确认。
# UI长期约束：全站永远不要使用重点色的“月牙边框”或单侧色条，不得移到顶部、底部或右侧来规避；包括圆角、半圆角和直角的单侧彩色边框、单侧内阴影或伪元素色条。需要强调时使用图标、字重、完整描边、背景对比或无框布局；How it works、Fallback等区域也遵守此规则。中性色的树连接线、面板分隔线不属于重点色装饰。
# 带icon不意味着必须加边框：Beta、Public构成、Discussions等次级入口采用无边框、无背景、无下划线的轻量样式，悬浮时文字和icon同步变色；保留触屏点击范围和键盘焦点提示。主要操作和需要显著区分的添加目标仍可使用背景色。

## Cloud Handoff

- Start with `docs/cloud/HANDOFF.md` and `docs/cloud-runtime.md`. The source handoff branch is `codex/cloud-handoff-20261101`, not the historical `main` branch.
- Use the lockfile and `scripts/cloud/setup.sh`; frontend fixture previews do not require production credentials or a database.
- Private operational material is encrypted in the separate private repository `Q-L-SN/benchpoll-cloud-handoff`. Never commit its decryption key, decrypted files, production `.env`, database dumps, or SSH/TLS private keys.
- Do not treat this repository snapshot as a production deploy manifest. Production has been updated through narrow, hash-checked releases; do not run a blanket `git pull`, copy the whole checkout, replay old migrations, or restore a development schema into production.
- No GitHub Actions operations bridge was authorized for this handoff. Cloud production access still requires separately configured networking and credentials; do not claim that access has been tested from Codex Cloud.
