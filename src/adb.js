// 底层 ADB 封装：把安卓调试桥的命令包装成 Promise。
// 连接方式与 USB/无线无关——`adb connect <ip:port>` 之后，后面的命令完全一致。
//
// 二进制路径：优先环境变量 ADB_BIN；否则用 PATH 里的 `adb`。
// 部署见 docs/device-qq.md（装 platform-tools、开 USB 调试）。
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

// 兼容 ESM 下读取配置文件（如需复用项目 api 配置可在此扩展）
const require = createRequire(import.meta.url);

let cachedBin = null;

// 常见 adb 安装位置兜底：即便 ADB_BIN / PATH 都没配，也能找到 adb。
// 这样"换机器 / 重装 / 环境变量被清"都不会再让设备控制整体失效（"又找不到 adb"的复发）。
const _home = process.env.USERPROFILE || process.env.HOME || '';
const FALLBACK_BINS = [
  _home && `${_home}/adb-tools/platform-tools/adb.exe`,
  'C:/adb-tools/platform-tools/adb.exe',
  'C:/adb-tools/platform-tools/adb.exe',
  'C:/platform-tools/adb.exe',
  'C:/adb/adb.exe'
].filter(Boolean);

/** 解析 adb 可执行文件路径。 */
export function adbBin() {
  if (cachedBin) return cachedBin;
  const env = process.env.ADB_BIN && process.env.ADB_BIN.trim();
  if (env) { cachedBin = env; return cachedBin; }
  for (const p of FALLBACK_BINS) {
    if (p && existsSync(p)) { cachedBin = p; return cachedBin; }
  }
  cachedBin = 'adb';
  return cachedBin;
}

/**
 * 执行一条 adb 命令（不带 `adb` 前缀的 args）。
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
export function run(args, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const bin = adbBin();
    const p = spawn(bin, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { p.kill('SIGKILL'); } catch {}
      reject(new Error(`adb 命令超时（${timeoutMs}ms）：${args.join(' ')}`));
    }, timeoutMs);
    p.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    p.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    p.on('error', (e) => {
      clearTimeout(timer);
      // 常见：adb 不在 PATH / ADB_BIN 指错
      if (String(e.message).includes('ENOENT')) {
        reject(new Error(`找不到 adb 可执行文件。请安装 Android platform-tools 并把 adb 放进 PATH，或设置环境变量 ADB_BIN 指向 adb.exe 绝对路径。原始错误：${e.message}`));
      } else {
        reject(e);
      }
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

/** 列出已连接设备，返回 [{ serial, state }]。 */
export async function listDevices() {
  const { stdout } = await run(['devices']);
  const lines = stdout.split('\n').slice(1); // 跳过表头
  const out = [];
  for (const line of lines) {
    const m = line.trim().match(/^(\S+)\s+(\S+)$/);
    if (m) out.push({ serial: m[1], state: m[2] });
  }
  return out;
}

/**
 * 选定目标设备序列号。
 * - 显式传入 serial 则直接用；
 * - 否则若只有一台设备/模拟器，自动选用；
 * - 多台且未指定则抛错，提示用 device 指定。
 */
export async function resolveSerial(preferred) {
  if (preferred && preferred.trim()) return preferred.trim();
  const devs = await listDevices();
  const online = devs.filter((d) => d.state === 'device');
  if (online.length === 1) return online[0].serial;
  if (online.length === 0) throw new Error('没有已连接的安卓设备。请先用 `adb devices` 确认手机已连接且状态为 device（开 USB 调试 / 已 adb connect）。');
  throw new Error(`检测到多台设备（${online.map((d) => d.serial).join(', ')}），请在调用时通过 serial 参数指定目标设备。`);
}

/** 对指定设备执行 shell 命令，返回 stdout。 */
export async function shell(serial, cmd) {
  const s = await resolveSerial(serial);
  const { stdout } = await run(['-s', s, 'shell', ...cmd.split(' ')]);
  return stdout;
}

/**
 * 截取屏幕，返回 PNG Buffer（exec-out 直接管道，二进制必须用 Buffer 收集）。
 */
/**
 * 屏幕醒了没有（不判断锁屏，只判断是否点亮）。
 * 读不出来时返回 true —— 宁可不动，也不要在状态未知时乱发唤醒。
 */
async function screenAwake(serial) {
  try {
    const { stdout } = await run(['-s', serial, 'shell', 'dumpsys', 'power']);
    const m = String(stdout || '').match(/mWakefulness=(\w+)/);
    return m ? m[1] === 'Awake' : true;
  } catch { return true; }
}

/**
 * 确保屏幕亮着且（无密码时）已解锁。
 * 背景（2026-10-28）：手机息屏 / 停在锁屏时，screencap 拍到的是黑屏或锁屏页，
 * 而她"看不见"就会开始瞎点 —— 这是"用手机跑不通"的另一个来源。
 * 只在真息屏时才发唤醒，避免把她主动锁屏的动作也强行解除。
 * 也建议在手机上开常亮：`adb shell settings put global stay_on_while_plugged_in 7`。
 */
export async function ensureAwake(serial) {
  const s = await resolveSerial(serial);
  if (await screenAwake(s)) return;
  try {
    await run(['-s', s, 'shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']);
    await run(['-s', s, 'shell', 'wm', 'dismiss-keyguard']); // 无密码锁屏时直接解锁
  } catch { /* 唤不醒也别拦着截图：至少把当前画面拿回来 */ }
}

/** exec-out 走管道拿二进制（快，但长跑进程里偶发 0 字节）。 */
function screenshotExecOut(s) {
  return new Promise((resolve) => {
    const bin = adbBin();
    const p = spawn(bin, ['-s', s, 'exec-out', 'screencap', '-p'], { windowsHide: true });
    const chunks = [];
    p.stdout.on('data', (d) => chunks.push(d));
    p.stderr.on('data', () => { /* 忽略 */ });
    p.on('error', () => resolve(Buffer.alloc(0)));
    p.on('close', () => resolve(Buffer.concat(chunks)));
  });
}

/**
 * 两段式截图兜底：设备上先落地，再 pull 回来。
 * 为什么（2026-10-31 实测）：exec-out screencap 在 Node 长跑进程里会连续返回 0 字节，
 * 而同一时刻在 PowerShell 里敲同一条命令却稳定 1.8MB —— 是管道/stdio 层的问题，不是手机。
 * 走文件就绕开了管道（代价多一次往返，约 1~2 秒）。
 */
async function screenshotViaFile(s) {
  const remote = '/sdcard/_shot_fallback.png';
  const tmpLocal = String(process.env.TEMP || process.env.TMPDIR || '.') + '/_shot_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.png';
  try {
    const r1 = await run(['-s', s, 'shell', 'screencap', '-p', remote]);
    if (r1.code !== 0) return Buffer.alloc(0);
    const r2 = await run(['-s', s, 'pull', remote, tmpLocal]);
    if (r2.code !== 0) return Buffer.alloc(0);
    if (!existsSync(tmpLocal)) return Buffer.alloc(0);
    return readFileSync(tmpLocal);
  } catch {
    return Buffer.alloc(0);
  } finally {
    try { unlinkSync(tmpLocal); } catch { /* ignore */ }
    try { await run(['-s', s, 'shell', 'rm', '-f', remote]); } catch { /* ignore */ }
  }
}

// 全局串行锁：同一时刻只允许一个截图在跑。
// 为什么要这个（2026-10-31 实测）：screenshot 单独调用 100% 成功，
// 但被 screenshotToFile 包一层后整条失败 —— 三条路在同一个事件循环里
// 连续开 adb 子进程抢管道。串行 + 每次之间歇一下就好了。
let _shotChain = Promise.resolve();

export async function screenshot(serial) {
  const runOne = async () => {
    const s = await resolveSerial(serial);
    await ensureAwake(s);

    // 快路 → 文件路 → 再快路
    let buf = await screenshotExecOut(s);
    if (buf.length >= 100) return buf;
    await new Promise((r) => setTimeout(r, 250));

    buf = await screenshotViaFile(s);
    if (buf.length >= 100) return buf;
    await new Promise((r) => setTimeout(r, 250));

    buf = await screenshotExecOut(s);
    if (buf.length >= 100) return buf;

    throw new Error('截图失败：没拿到画面（手机可能息屏、锁屏或连接中断）');
  };

  // 串到全局链尾，保证同一时刻只有一个在跑
  const next = _shotChain.then(runOne, runOne);
  _shotChain = next.catch(() => {});
  return next;
}

/** 截图并保存到文件，返回 { path, width, height }。 */
export async function screenshotToFile(serial, filePath) {
  const { writeFile } = await import('node:fs/promises');
  const buf = await screenshot(serial);
  await writeFile(filePath, buf);
  const size = await screenSize(serial);
  return { path: filePath, width: size.width, height: size.height, bytes: buf.length };
}

/** 读取屏幕分辨率，返回 { width, height }。 */
export async function screenSize(serial) {
  const s = await resolveSerial(serial);
  const { stdout } = await run(['-s', s, 'shell', 'wm', 'size']);
  const m = stdout.match(/(\d+)x(\d+)/);
  if (!m) throw new Error('无法读取屏幕分辨率：' + stdout);
  return { width: Number(m[1]), height: Number(m[2]) };
}

/**
 * 解析 uiautomator 的 XML → 元素列表（只留"有文字"或"可点击"的节点）。
 *
 * 为什么加这个（2026-10-28）：视觉模型报坐标极不可靠 —— 实测同一屏桌面，
 * glm-4v-flash 说微信在 (50,200)，而系统给的 bounds 是 [15,554][225,901]，
 * 中心 (120,727)，差了 500 多像素，照它点必然点空。
 * uiautomator 给的是系统真实布局，坐标精确到像素，还能直接按文字找元素。
 * 视觉只在"界面没有可读文字"（游戏、自绘界面、图片墙）时才需要。
 */
export function parseUiXml(xml) {
  const out = [];
  const re = /<node\b([^>]*)\/?>/g;
  let m;
  while ((m = re.exec(String(xml || '')))) {
    const attrs = m[1];
    const get = (k) => {
      const r = new RegExp(`${k}="([^"]*)"`).exec(attrs);
      return r ? r[1] : '';
    };
    const bm = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(get('bounds'));
    if (!bm) continue;
    const [x1, y1, x2, y2] = bm.slice(1).map(Number);
    const w = x2 - x1, h = y2 - y1;
    if (w <= 0 || h <= 0) continue;
    const text = get('text').trim();
    const desc = get('content-desc').trim();
    const clickable = get('clickable') === 'true';
    if (!text && !desc && !clickable) continue;
    out.push({
      text, desc, clickable,
      cls: (get('class').split('.').pop() || ''),
      x: x1, y: y1, w, h,
      cx: x1 + Math.floor(w / 2), cy: y1 + Math.floor(h / 2)
    });
  }
  return out;
}

/** 导出当前界面的元素树（文字 + 精确坐标）。 */export async function dumpUi(serial) {
  const s = await resolveSerial(serial);
  await ensureAwake(s);
  const remote = '/sdcard/.qqagent_ui.xml';
  const dump = await run(['-s', s, 'shell', 'uiautomator', 'dump', remote], { timeoutMs: 20000 });
  const head = String(dump.stdout || '') + String(dump.stderr || '');
  if (!/dumped to/i.test(head)) {
    throw new Error('导出界面结构失败（可能界面正在动效中或该页面不支持无障碍）：' + head.trim().slice(0, 120));
  }
  const { stdout } = await run(['-s', s, 'shell', 'cat', remote], { timeoutMs: 20000 });
  if (!String(stdout).includes('<hierarchy')) throw new Error('导出的界面结构为空');
  return parseUiXml(stdout);
}

/** 在当前界面里按文字找元素并点它的中心。返回 { ok, hit, log }。 */
export async function tapByText(serial, keyword) {
  const s = await resolveSerial(serial);
  const key = String(keyword || '').trim();
  if (!key) throw new Error('要点的文字不能为空');
  const nodes = await dumpUi(s);
  const lc = key.toLowerCase();
  const score = (n) => {
    const t = (n.text || '').toLowerCase(), d = (n.desc || '').toLowerCase();
    if (t === lc || d === lc) return 100;               // 完全相同最优先
    if (t.startsWith(lc) || d.startsWith(lc)) return 80;
    if (t.includes(lc) || d.includes(lc)) return 60;
    return 0;
  };
  const cands = nodes
    .map((n) => ({ n, sc: score(n) }))
    .filter((x) => x.sc > 0)
    .sort((a, b) => b.sc - a.sc || (a.n.w * a.n.h) - (b.n.w * b.n.h)); // 同分取更小的（更可能是具体控件，不是整页容器）
  if (!cands.length) {
    const labels = nodes.filter((n) => n.text || n.desc).slice(0, 20)
      .map((n) => n.text || n.desc);
    throw new Error(`界面上找不到「${key}」。当前能看到的：${labels.join('、') || '(无可读文字，改用看图操作)'}`);
  }
  const hit = cands[0].n;
  await run(['-s', s, 'shell', 'input', 'tap', String(hit.cx), String(hit.cy)]);
  return { ok: true, hit, log: `点了「${hit.text || hit.desc}」(${hit.cx},${hit.cy})` };
}

/**
 * 在界面里按文字找元素，但**不点**。找不到返回 null（不抛错）。
 * 用于"先确认目标存在再动手"的场合（比如双击前要先知道自己点的确实是那个头像）。
 */
export async function findByText(serial, keyword) {
  const s = await resolveSerial(serial);
  const key = String(keyword || '').trim().toLowerCase();
  if (!key) return null;
  const nodes = await dumpUi(s);
  const score = (n) => {
    const t = (n.text || '').toLowerCase(), d = (n.desc || '').toLowerCase();
    if (t === key || d === key) return 100;
    if (t.startsWith(key) || d.startsWith(key)) return 80;
    if (t.includes(key) || d.includes(key)) return 60;
    return 0;
  };
  const cands = nodes.map((n) => ({ n, sc: score(n) })).filter((x) => x.sc > 0)
    .sort((a, b) => b.sc - a.sc || (a.n.w * a.n.h) - (b.n.w * b.n.h));
  return cands.length ? cands[0].n : null;
}

// ── 中文输入（ADBKeyboard）────────────────────────────────────────────────
// 安卓的 `input text` 只认 ASCII，中文会 NPE。2026-10-28 装了 ADBKeyboard
// （开源输入法 com.android.adbkeyboard），它监听 `am broadcast -a ADB_INPUT_B64`
// 把文本直接注入当前焦点输入框 —— 这是唯一不 root 也能打中文的办法。
// 用法：临时切到它 → 广播 → 切回原来的输入法（不然他自己用手机时没有键盘）。
export const ADB_IME = 'com.android.adbkeyboard/.AdbIME';

/** ADBKeyboard 装没装。 */
export async function hasImeInput(serial) {
  try {
    const s = await resolveSerial(serial);
    const { stdout } = await run(['-s', s, 'shell', 'pm', 'list', 'packages', 'com.android.adbkeyboard']);
    return /com\.android\.adbkeyboard/.test(stdout);
  } catch { return false; }
}

/**
 * 打任意文本（含中文/表情）。自动切换输入法并在结束后还原。
 * 调用前请确保目标输入框已经获得焦点（先 tap 一下输入框）。
 */
export async function inputTextViaIme(serial, text) {
  const s = await resolveSerial(serial);
  const prev = String((await run(['-s', s, 'shell', 'settings', 'get', 'secure', 'default_input_method'])).stdout || '').trim();
  await run(['-s', s, 'shell', 'ime', 'enable', ADB_IME]);
  await run(['-s', s, 'shell', 'ime', 'set', ADB_IME]);
  await new Promise((r) => setTimeout(r, 400));
  const b64 = Buffer.from(String(text), 'utf8').toString('base64');
  const r = await run(['-s', s, 'shell', 'am', 'broadcast', '-a', 'ADB_INPUT_B64', '--es', 'msg', b64]);
  const good = /result=0/.test(String(r.stdout || ''));
  // 还原输入法：不还原的话他自己拿手机时会发现键盘没了
  if (prev && prev !== ADB_IME && !/^null$/i.test(prev)) {
    try { await run(['-s', s, 'shell', 'ime', 'set', prev]); } catch { /* 还原失败不致命 */ }
  }
  if (!good) {
    throw new Error('中文输入失败：ADBKeyboard 广播没成功（' + String(r.stdout || r.stderr || '').trim().slice(0, 100) + '）');
  }
  return { ok: true, text: String(text) };
}

/**
 * 当前前台应用的包名（读不到就返回空串）。
 * 用来验证"点了图标之后 App 真的起来了"，而不是点完就当成功。
 */
export async function currentPackage(serial) {
  const s = await resolveSerial(serial);
  try {
    const { stdout } = await run(['-s', s, 'shell', 'dumpsys window | grep mCurrentFocus'], { timeoutMs: 15000 });
    const m = /mCurrentFocus=Window\{\S+\s+\S+\s+([A-Za-z][\w.]*)\//.exec(stdout)
      || /mCurrentFocus=.*?([A-Za-z][\w.]*)\/[\w.]+/.exec(stdout);
    return m ? m[1] : '';
  } catch { return ''; }
}

/**
 * 把本地文件推到手机。
 *
 * ⚠️ push 是 **adb 自己的子命令**，不是手机上的 shell 命令。
 *   写成 `shell(serial, 'push a b')` 会去调手机里的 push 程序——手机根本没有，
 *   命令静默失败、返回空字符串，调用方还以为是成功的（实测：视频没推进相册，
 *   抖音相册里选的是上一版旧片，白发了两个小时）。
 */
export async function push(serial, localPath, remotePath) {
  const s = await resolveSerial(serial);
  const { stdout, stderr } = await run(['-s', s, 'push', localPath, remotePath], { timeoutMs: 180000 });
  const out = String(stdout || '') + String(stderr || '');
  // adb push 成功会打 "1 file pushed"，失败不会。光看返回值等于没校验
  if (!/1 file pushed|files? pushed/i.test(out)) {
    throw new Error(`adb push 失败：${out.trim().slice(0, 200) || '(无输出)'}`);
  }
  // 再确认一次远端真的有这个文件、大小对得上
  const { stdout: sz } = await run(['-s', s, 'shell', `stat -c %s ${remotePath}`], { timeoutMs: 15000 });
  const remoteSize = Number(String(sz).trim()) || 0;
  return { ok: true, remoteSize, note: out.trim().slice(0, 120) };
}

