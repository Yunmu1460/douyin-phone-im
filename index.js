// douyin-phone-im — DSH host plugin entry
// Registers two agent tools (phone__im_read / phone__im_send) that drive the
// Douyin mobile app over ADB: accessibility-tree navigation + ADB IME input.
// Send includes a rate/repeat gate so an agent cannot spam conversations.
import fs from 'node:fs';
import path from 'node:path';
import z from '@deepseek-ai/schemastery';

export const name = 'douyin-phone-im';
const inject = ['tools'];

export const Config = z.object({
  // 每天全局发送上限（所有会话合计）
  maxPerDay: z.number().default(6),
  // 同一会话每天上限
  maxPerContact: z.number().default(2),
  // 同一会话两次发送最小间隔（分钟）
  minIntervalMin: z.number().default(30),
  // 单条最大字数
  maxTextLen: z.number().default(100),
  // 复读闸：相似度（bigram Jaccard 按短边归一）阈值
  repeatSim: z.number().default(0.7),
  // 复读闸：最长公共子串阈值
  repeatLcs: z.number().default(14),
}).description('douyin-phone-im');

// —— 发送闸账本（与官方 runner/网页端同一文件名，便于共用历史）——
function homeDir() {
  return process.env.DOUYIN_IM_DATA_DIR || path.resolve(import.meta.dirname ?? '.', 'data');
}

function loadStreak(today) {
  const p = path.join(homeDir(), 'im-streak.json');
  try {
    const sk = JSON.parse(fs.readFileSync(p, 'utf8'));
    return sk.date === today ? sk : { date: today, c: {}, at: {}, total: 0 };
  } catch {
    return { date: today, c: {}, at: {}, total: 0 };
  }
}

function saveStreak(sk) {
  const dir = homeDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    // 原子写：tmp + rename（学自 dsh-workbuddy writeStore），进程中途死也不留半截 JSON
    const p = path.join(dir, 'im-streak.json');
    fs.writeFileSync(p + '.' + process.pid + '.tmp', JSON.stringify(sk), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(p + '.' + process.pid + '.tmp', p);
  } catch { /* 账本写失败不阻断返回 */ }
}

const normTxt = (s) => String(s || '').replace(/[\s，。！？、「」『』"'（）()：:；;——…·,.!?\-]/g, '');
const bigramsOf = (s) => {
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
};
const lcsLen = (a, b) => {
  let best = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      let n = 0;
      while (i + n < a.length && j + n < b.length && a[i + n] === b[j + n]) n++;
      if (n > best) best = n;
    }
  }
  return best;
};

function sentHistory(name) {
  try {
    const p = path.join(homeDir(), 'im-sent.jsonl');
    return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .filter((x) => x.name === name)
      .slice(-10);
  } catch {
    return [];
  }
}

function repeatCheck(text, name, cfg) {
  const ntNew = normTxt(text);
  for (const prev of sentHistory(name)) {
    const npOld = normTxt(prev.text);
    if (!npOld || !ntNew) continue;
    if (ntNew.includes(npOld) || npOld.includes(ntNew)) {
      return '这条跟之前发给「' + name + '」的那条说的是同一句话。说了过的就不说了——想接他的话，说点新的。';
    }
    const ga = bigramsOf(ntNew);
    const gb = bigramsOf(npOld);
    let inter = 0;
    for (const g of ga) if (gb.has(g)) inter++;
    const sim = ga.size && gb.size ? inter / Math.min(ga.size, gb.size) : 0;
    const lc = lcsLen(ntNew, npOld);
    if (sim >= cfg.repeatSim || lc >= cfg.repeatLcs) {
      return '这条跟之前发给「' + name + '」的一条几乎一样（重复 ' + Math.round(sim * 100) + '%）。两个出路：想接着他的话说，就用你自己的话接新的内容，别把他刚说的原话再包一遍；真有没说完的事，先放一放，明天再换个说法。';
    }
  }
  return null;
}

export function apply(ctx, config) {
  const cfg = config;

  const lazyIm = async () => await import('./src/im.js');

  ctx.inject(['tools'], (sctx) => {
    sctx.tools.register({
      name: 'phone__im_read',
      description: '读手机抖音私信（ADB 真机）。不带参数＝只列会话；带 {name:"对方昵称"}＝点进会话读记录。纯只读。手机不在旁边会报错，别硬试。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '对方昵称；不传＝只列会话' },
        },
      },
      async execute(args) {
        try {
          const pim = await lazyIm();
          const r = args && args.name
            ? await pim.phoneImRead({ name: String(args.name) })
            : await pim.phoneImList();
          return { content: `status: ${r.ok ? 'ok' : 'error'}\n${r.note}`, isError: !r.ok };
        } catch (e) {
          return { content: 'status: error\n手机私信读取挂了：' + ((e && e.message) || e), isError: true };
        }
      },
    });

    sctx.tools.register({
      name: 'phone__im_send',
      description: '用手机回抖音私信：{name:"对方昵称", text:"内容", confirm:true}。闸：confirm:true / ≤100字 / 30分钟间隔 / 单会话一天2条 / 全部私信一天6条 / 复读拦截。手机不在旁边会报错，别硬试。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '对方昵称（phone__im_read 列表里的精确名字）' },
          text: { type: 'string', description: '回复内容' },
          confirm: { type: 'boolean', description: '必须 true 才真发' },
        },
        required: ['name', 'text'],
      },
      async execute(args) {
        if (!args || !args.name || !args.text) return { content: 'status: blocked\n缺参数：name 和 text 都要传。', isError: true };
        if (args.confirm !== true) return { content: 'status: blocked\n私信回复必须带 confirm:true——想好了、确认要发这一条，再调一次。', isError: true };
        const text = String(args.text).trim();
        if (text.length > cfg.maxTextLen) return { content: `status: blocked\n回复超过 ${cfg.maxTextLen} 字。私信一句一句说，砍短再发。`, isError: true };
        const nm = String(args.name);
        const today = new Date().toLocaleDateString('sv-SE');
        const sk = loadStreak(today);
        const sent = sk.c[nm] || 0;
        const lastAt = sk.at[nm] || 0;
        if (sent >= cfg.maxPerContact) {
          return { content: `status: blocked\n今天给「${nm}」已经发过 ${sent} 条了（一个会话一天最多 ${cfg.maxPerContact} 条）。想多说先放着，明天再聊。`, isError: true };
        }
        if ((sk.total || 0) >= cfg.maxPerDay) {
          return { content: `status: blocked\n今天所有私信加起来你已经发过 ${sk.total} 条了，到顶了（一天全部私信上限 ${cfg.maxPerDay} 条）。剩下的话明天再说。`, isError: true };
        }
        if (lastAt && Date.now() - lastAt < cfg.minIntervalMin * 60 * 1000) {
          const mins = Math.round((Date.now() - lastAt) / 60000);
          return { content: `status: blocked\n${mins} 分钟前你刚给「${nm}」发过一条。至少隔 ${cfg.minIntervalMin} 分钟再发第二条。想说的先记下来。`, isError: true };
        }
        const rep = repeatCheck(text, nm, cfg);
        if (rep) return { content: 'status: blocked\n' + rep, isError: true };

        try {
          const pim = await lazyIm();
          const r = await pim.phoneImSend({ name: nm, text, confirm: true });
          if (r.ok) {
            const sk2 = loadStreak(today);
            sk2.c[nm] = (sk2.c[nm] || 0) + 1;
            sk2.at[nm] = Date.now();
            sk2.total = (sk2.total || 0) + 1;
            saveStreak(sk2);
          }
          return { content: `status: ${r.ok ? 'ok' : 'error'}\n${r.note}`, isError: !r.ok };
        } catch (e) {
          return { content: 'status: error\n手机私信发送挂了：' + ((e && e.message) || e), isError: true };
        }
      },
    });
  });
}
