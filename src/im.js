// 手机端抖音私信：读会话/读记录/发消息（ADB 无障碍链路）
// 2026-11-20 探针已验证全链路可行（dry 全通），本文件是产线版。
// 复用 QQ Agent 的 src/device/adb.js（resolveSerial / dumpUi / inputTextViaIme 等）。
import * as adb from './adb.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const HOME = process.env.DOUYIN_IM_DATA_DIR || path.resolve(__dirname, '../data');
let _serial = null;
async function defaultSerial() {
  if (_serial) return _serial;
  const devs = await adb.listDevices().catch(() => []);
  _serial = devs[0]?.serial || '';
  return _serial;
}
const SERIAL = process.env.DOUYIN_PHONE_SERIAL || (await defaultSerial());
// 首次调用时自动解析唯一在线设备；多设备用环境变量指定

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd) => adb.shell(SERIAL, cmd);

// —— sent 留底（与网页端 im.mjs 同一文件 im-sent.jsonl，复读闸/回声共用账本）——
export function rememberSent(name, text) {
  try {
    const p = path.join(HOME, 'im-sent.jsonl');
    const lines = fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean);
    lines.push(JSON.stringify({ at: Date.now(), name, text, via: 'phone' }));
    fs.writeFileSync(p, lines.slice(-80).join('\n') + '\n', 'utf8');
  } catch {}
}

function sentListOf(name) {
  try {
    return fs.readFileSync(path.join(HOME, 'im-sent.jsonl'), 'utf8').trim().split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
      .filter((x) => x.name === name);
  } catch { return []; }
}

// 把我发过的消息在 flatText 里标「（你发的）」——与网页端 markMine 同款（顺序游标）
export function markMine(name, flatText) {
  let t = String(flatText || '');
  const flat = () => t.replace(/\s+/g, '');
  for (const s of sentListOf(name)) {
    const key = String(s.text || '').replace(/\s+/g, '');
    if (!key) continue;
    // 包含匹配（气泡文本可能带前后缀）：先试全等，再试「树节点文本是消息的子串」
    const j0 = t.indexOf(s.text);
    if (j0 >= 0) { t = t.slice(0, j0) + '（你发的）' + s.text + '（你发的）' + t.slice(j0 + s.text.length); continue; }
    // 气泡截断/带省略号：取 key 的前 12 字在扁平文本里找
    const head = key.slice(0, 12);
    const fi = flat().indexOf(head);
    if (fi >= 0 && key.length >= 6) {
      // 在原文（带空白）里找这 12 个字对应的近似起点——逐字滑窗
      const raw = t;
      for (let i = 0; i + 12 <= raw.length; i++) {
        if (raw.slice(i, i + 30).replace(/\s+/g, '').startsWith(head)) {
          t = raw.slice(0, i) + '（你发的）' + raw.slice(i) + '（你发的）';
          break;
        }
      }
    }
  }
  return t;
}

// —— UI 助手 ——
async function dumpTexts() {
  const xml = String(await sh('uiautomator dump /sdcard/_uidump.xml && cat /sdcard/_uidump.xml'));
  const nodes = [...xml.matchAll(/<node[^>]*?(?:text|content-desc)="([^"]{1,120})"[^>]*bounds="(\[[^\]]*\]\[[^\]]*\])"[^>]*>/g)]
    .map((m) => ({ text: m[1], bounds: m[2] }));
  return { xml, nodes };
}

function center(b) {
  const m = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(b);
  return m ? { x: (Number(m[1]) + Number(m[3])) >> 1, y: (Number(m[2]) + Number(m[4])) >> 1 } : null;
}

// 确保在抖音消息 tab
async function ensureImTab() {
  const { nodes } = await dumpTexts();
  if (nodes.some((n) => n.text === '消息') && nodes.some((n) => /暂时没有更多|互动消息|陌生人消息|等 \d+ 人/.test(n.text))) return nodes;
  await sh('input keyevent 3'); await sleep(800);
  await sh('am start -n com.ss.android.ugc.aweme/com.ss.android.ugc.aweme.main.MainActivity'); await sleep(5000);
  await sh('input tap 756 2230'); await sleep(3500);   // 底部「消息」tab
  return (await dumpTexts()).nodes;
}

// —— 读会话列表 ——
export async function phoneImList() {
  try {
    const nodes = await ensureImTab();
    const rows = nodes.filter((n) => /,昨天在线|,刚刚在线|,\d+\/\d+在线|未读\d+条消息/.test(n.text));
    const names = nodes.filter((n) => /,未读\d+条消息/.test(n.text) || /关注了你/.test(n.text));
    const seen = new Set();
    const list = [];
    for (const n of [...rows, ...names]) {
      const nm = String(n.text).split(',')[0];
      if (!nm || seen.has(nm)) continue;
      seen.add(nm);
      list.push(nm + (n.text.includes('关注了你') ? '（新关注/互动）' : ''));
    }
    return { ok: true, note: '会话：' + (list.join(' / ') || '(空)') };
  } catch (e) {
    return { ok: false, note: '手机私信列表读取失败：' + ((e && e.message) || e) };
  }
}

// —— 读某会话完整记录 ——
export async function phoneImRead({ name }) {
  try {
    const nm = String(name || '').trim();
    if (!nm) return { ok: false, note: '缺 name' };
    await ensureImTab();
    const { nodes } = await dumpTexts();
    const row = nodes.find((n) => String(n.text).split(',')[0] === nm || String(n.text).split(',')[0].includes(nm));
    if (!row) return { ok: false, note: `会话列表里没找到「${nm}」。先不带参数调一次看列表里的精确名字。` };
    const c = center(row.bounds);
    await sh(`input tap ${c.x} ${c.y - 40}`); await sleep(3500);
    // 关掉「打个招呼吧」浮层（若有）
    const { nodes: n2 } = await dumpTexts();
    const closeBtn = n2.find((n) => n.text === '关闭' || n.text === '×');
    if (closeBtn && n2.some((n) => n.text === '打个招呼吧')) { const c2 = center(closeBtn.bounds); await sh(`input tap ${c2.x} ${c2.y}`); await sleep(1000); }
    const { nodes: n3 } = await dumpTexts();
    // 聊天记录在消息页下半部分的 text 节点里；排除底部按钮/系统文案
    const skip = /^(语音|表情|发消息|发送|返回|更多面板|侧边栏|关闭|打开|首页|朋友|拍摄，按钮|消息，按钮|我，按钮|智能助手|打个招呼吧|去 看看|去看看)$/;
    const msgs = n3.map((n) => n.text).filter((t) => t && !skip.test(t) && !/^打开朋友通知/.test(t));
    // 只保留会话区域（「你们已互相关注」之后的内容）
    const startIdx = msgs.findIndex((t) => /互相关注|开始聊天/.test(t));
    const conv = startIdx >= 0 ? msgs.slice(startIdx) : msgs;
    return { ok: true, note: markMine(nm, conv.join('\n')).slice(0, 1500) };
  } catch (e) {
    return { ok: false, note: '手机私信读取失败：' + ((e && e.message) || e) };
  }
}

// —— 发消息 ——
export async function phoneImSend({ name, text, confirm }) {
  try {
    const nm = String(name || '').trim();
    const tx = String(text || '').trim();
    if (!nm || !tx) return { ok: false, note: '缺 name 或 text' };
    if (!confirm) return { ok: false, note: '必须 confirm:true 才真发（dry 不做）' };
    // 进会话
    const rd = await phoneImRead({ name: nm });
    if (!rd.ok) return rd;
    // 键盘弹起态下找输入框（resource-id=msg_et，坐标动态拿）
    const { xml } = await dumpTexts();
    const mBox = /<node[^>]*resource-id="com\.ss\.android\.ugc\.aweme:id\/msg_et"[^>]*bounds="(\[[^\]]*\]\[[^\]]*\])"/.exec(xml);
    if (!mBox) return { ok: false, note: '没找到输入框 msg_et' };
    const c = center(mBox[1]);
    await sh(`input tap ${c.x} ${c.y}`); await sleep(2000);
    if (!(await adb.hasImeInput(SERIAL))) return { ok: false, note: 'ADBKeyboard 没装/没启用，中文输入不了' };
    // 先清残留（上一条没发出去的草稿会跟着新文本一起被发出去——真事故）
    for (let i = 0; i < 30; i++) await sh('input keyevent 67');
    await sleep(400);
    await adb.inputTextViaIme(SERIAL, tx); await sleep(1200);
    // 找发送键（有文字后出现）
    const { xml: xml2 } = await dumpTexts();
    const sendM = [...xml2.matchAll(/<node[^>]*content-desc="发送"[^>]*bounds="(\[[^\]]*\]\[[^\]]*\])"/g)];
    const sendM2 = [...xml2.matchAll(/<node[^>]*text="发送"[^>]*bounds="(\[[^\]]*\]\[[^\]]*\])"/g)];
    const sb = sendM[0]?.[1] || sendM2[0]?.[1];
    if (!sb) {
      for (let i = 0; i < 24; i++) await sh('input keyevent 67');
      return { ok: false, note: '输入了但没找到发送键，已清空未发送' };
    }
    const sc = center(sb);
    await sh(`input tap ${sc.x} ${sc.y}`); await sleep(2500);
    // 回读验证（气泡文本在树里可能带前后缀 → 包含匹配而非全等）
    const { nodes: n4 } = await dumpTexts();
    const norm = (s) => String(s || '').replace(/\s+/g, '');
    const sentEcho = n4.some((n) => { const t = norm(n.text); return t && norm(tx).includes(t) && t.length >= 6; }) || n4.some((n) => norm(n.text).includes(norm(tx)));
    // 无论回读是否坐实，发送键已点 = 记账（复读闸/回声依赖这份账本，漏记=闸失效）
    rememberSent(nm, tx);
    if (sentEcho) return { ok: true, note: `已发出（手机端）：「${tx}」→ ${nm}（回读坐实）` };
    return { ok: true, note: `已点发送（回读未见原文，可能已发出）：「${tx}」→ ${nm}` };
  } catch (e) {
    return { ok: false, note: '手机私信发送失败：' + ((e && e.message) || e) };
  }
}
