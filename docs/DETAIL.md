# douyin-phone-im（DSH 插件）

让 DeepSeek Harness 的 agent 通过 ADB 操作**真实安卓手机上的抖音私信**：读会话、读记录、回复消息。无障碍树定位控件 + ADB IME 输入中文，全程不需要 root、不碰非官方接口。

## 提供的工具

| 工具 | 说明 |
| --- | --- |
| `phone__im_read` | 读手机抖音私信。不带参数＝列会话；带 `{name}`＝点进会话读记录。纯只读。 |
| `phone__im_send` | 回私信 `{name, text, confirm:true}`。带完整发送闸。 |

## 发送闸（防刷屏 / 防复读）

- 必须显式 `confirm: true` 才真发；
- 单条最长 100 字（可配 `maxTextLen`）；
- 同一会话每天最多 2 条（`maxPerContact`）、全部私信每天最多 6 条（`maxPerDay`）；
- 同一会话两次发送至少间隔 30 分钟（`minIntervalMin`）；
- **复读闸**：与该会话历史发送记录（`im-sent.jsonl` 留底）做归一化比对——整句重复直接拦；bigram 相似度 ≥0.7 或最长公共子串 ≥14 也拦，防止「同一件事换措辞隔天再发」。

以上阈值都能在插件的 Plugins 页配置里改。

## 前置条件

1. 电脑装有 adb（`ADB_BIN` 环境变量或 PATH；找不到时按常见位置兜底）。
2. 手机开 USB 调试并连接；多台设备用 `DOUYIN_PHONE_SERIAL` 指定。
3. 手机装有 ADB Keyboard（`com.android.adbkeyboard`），否则中文输入不了（工具会明确报错）。
4. 数据目录：默认 `<插件目录>/data`，可用 `DOUYIN_IM_DATA_DIR` 覆盖。

## 与本仓库其它部分的关系

- `src/im.js` / `src/adb.js` 是纯函数库（零依赖），可以不带插件壳直接用（见 `example/basic.js`）。
- 本入口 `index.js` 只做一件事：把库里的 `phoneImList / phoneImRead / phoneImSend` 注册成 DSH agent 工具，并在外面套发送闸。

## 隐私与脱敏

本仓库不含任何真实账号信息：联系人白名单、设备序列号、数据路径全部参数化。发送留底 `im-sent.jsonl` / 额度账本 `im-streak.json` 只存于本机数据目录。
