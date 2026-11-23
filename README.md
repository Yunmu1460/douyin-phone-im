# douyin-phone-im

抖音**手机端**私信自动化（读会话 / 读记录 / 发消息），走 **ADB + 无障碍树**，不碰抖音内部协议、不需要 root。

与常见的网页端 hook / 协议逆向方案互补：手机原生 IM 是抖音私信**功能最完整、最稳定**的入口（网页版消息抽屉在 Edge 后台冻结、DOM 死树等问题下长期不稳）。

## 它解决了什么

真实生产环境（一个每日自动运营抖音账号的 agent 项目）里踩过的坑，全部内建在这 300 行里：

| 坑 | 方案 |
| --- | --- |
| 裸 `am broadcast` 发中文，标点被 shell 吃掉 | 强制走 `ADBKeyboard` IME（`inputTextViaIme`），发送前校验 IME 已启用 |
| 输入框有残留草稿时点发送，**把上一条残留当成消息发出去了** | 发送前连按 30 次退格清空输入框 |
| 气泡文本在无障碍树里带前后缀/截断，回读全等匹配失败 | 两级匹配：全文包含 → 前 12 字滑窗；发送键已点即记账（回读降级为「可能已发出」） |
| 发出去的话没记账，复读闸/回声块看不到 → 复读 | `rememberSent` 无条件留底 jsonl（cap 80 条），`markMine` 把自己发的标「（你发的）」 |
| 多设备 / 设备序列号硬编码 | `DOUYIN_PHONE_SERIAL` 环境变量，缺省自动取第一台在线设备 |

## 安装

```bash
# 1. 电脑装 adb（Android platform-tools），手机开 USB 调试并插线
# 2. 手机装 ADBKeyboard（输入法）：
#    https://github.com/senzhk/ADBKeyBoard
#    并在系统设置里把它启用为输入法之一
adb install ADBKeyboard.apk   # 如尚未安装

npm i   # 本仓库零运行时依赖，此步可跳过
```

## 用法

```js
import { phoneImList, phoneImRead, phoneImSend } from './src/im.js';

// 1. 列会话
await phoneImList();
// → { ok: true, note: '会话：张三 / 李四（新关注/互动）' }

// 2. 读某会话最近记录（只读，不动手机输入状态）
await phoneImRead({ name: '张三' });
// → { ok: true, note: '…消息全文（自己发的标了「（你发的）」）…' }

// 3. 发消息（必须 confirm:true 才真发；不带 confirm 只校验参数）
await phoneImSend({ name: '张三', text: '你好', confirm: true });
// → { ok: true, note: '已发出（手机端）：「你好」→ 张三（回读坐实）' }
```

环境变量：

| 变量 | 作用 |
| --- | --- |
| `DOUYIN_PHONE_SERIAL` | 多设备时指定序列号（`adb devices` 里那串） |
| `DOUYIN_IM_DATA_DIR` | 发送留底目录（默认 `./data`，文件名 `im-sent.jsonl`） |
| `ADB_BIN` | adb 可执行文件路径（缺省按 PATH 与常见位置自动找） |

## 坐标与控件的脆弱性

抖音 UI 会改版。本库的定位策略尽量抗改版：

- 会话行 / 输入框 / 发送键全部**动态从当次 UI dump 取 bounds**，不写死坐标；
- 输入框用 `resource-id=msg_et`、发送键用 `content-desc="发送"`（这两个 id 长期稳定）；
- 底部「消息」tab：tab 文字节点的 bounds 在新版本抖音里全是 `[0,0]`（MeasureOnce 布局优化），**不能按文本定位**。改用 `content-desc="拍摄，按钮"`（真实 bounds，5 个 tab 槽等宽）作锚点，推导「消息」= 拍摄右邻槽中心；找不到锚点才回落写死坐标 `(756, 2230)`（1080×2400 屏）。

抖音 41.1.0 实测通过。改版后通常只需要修锚点规则和一个正则。

## 频率与风控（重要）

- 发送之间留足间隔（生产里用 30 分钟/次 + 单会话每天 2 条的额度闸，本项目不含这部分，留给你按自己节奏包一层）；
- 短时间高频私信会触发抖音风控——这个库不替你做风控对策，请自律；
- 只跟**已有会话**的人聊，`phoneImList` 里标「（新关注/互动）」的新会话建议先人工看一眼再回。

## License

MIT
