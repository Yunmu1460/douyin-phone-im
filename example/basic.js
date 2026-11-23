// 最小可跑示例：读一次会话列表（只读，不发送任何消息）
// 前置：手机插线 + USB 调试开 + ADBKeyboard 已启用
import { phoneImList, phoneImRead } from '../src/im.js';

const list = await phoneImList();
console.log(list.note);

// 想读某个会话的全文，把名字改进去：
// const rd = await phoneImRead({ name: '某好友' });
// console.log(rd.note);
