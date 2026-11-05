/* 本地产出目录 ── 产出物落在用户自己的磁盘上，不占云存储
   ────────────────────────────────────────────────────────────
   为什么要有这一层：员工写文件是在服务端沙箱里写的，沙箱是临时的，
   重新发布 / 重启 / 长时间空闲就会清空。产出物如果只留在那儿，用户过两天回来就没了。
   对话和任务记录本来就存在云端的 ba_tasks / ba_meetings 里，只有「文件」需要另找地方。

   这里用浏览器的 File System Access API 直接写进用户选定的真实文件夹：
     · 在 Finder / 资源管理器里能直接看到、能用别的软件打开
     · 不占平台对象存储
     · 游客态也能用（纯前端能力，不需要登录）

   限制说清楚：
     1. 只有 Chrome / Edge 这类 Chromium 桌面版支持；手机浏览器、Safari 不支持
     2. 句柄存在 IndexedDB 里，但**写入权限**通常只在本浏览器会话内有效，
        新开一次浏览器往往要用户再点一下「授权」——这是浏览器的规矩，绕不过去
     3. 所以对外暴露 ensure(interactive)：非交互只查询，交互才弹授权框
*/
(() => {
  const DB_NAME = 'ba-localfs';
  const STORE = 'kv';
  const KEY = 'outDir';

  let handle = null;
  let loaded = false;

  const supported = () =>
    typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';

  function openDB() {
    return new Promise((res, rej) => {
      if (!window.indexedDB) return rej(new Error('这个浏览器不支持本地存储'));
      const rq = indexedDB.open(DB_NAME, 1);
      rq.onupgradeneeded = () => {
        const db = rq.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error || new Error('本地存储打不开'));
    });
  }

  async function idbGet(k) {
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readonly');
      const rq = tx.objectStore(STORE).get(k);
      rq.onsuccess = () => res(rq.result || null);
      rq.onerror = () => rej(rq.error);
    });
  }

  async function idbSet(k, v) {
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(v, k);
      tx.oncomplete = () => res(true);
      tx.onerror = () => rej(tx.error);
    });
  }

  async function idbDel(k) {
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(k);
      tx.oncomplete = () => res(true);
      tx.onerror = () => rej(tx.error);
    });
  }

  async function load() {
    if (loaded) return handle;
    loaded = true;
    try { handle = await idbGet(KEY); } catch (e) { handle = null; }
    return handle;
  }

  /* 文件 / 文件夹名：去掉路径分隔符和各系统的非法字符，别把用户的盘写坏 */
  function safeSeg(name) {
    const s = String(name || '')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\.+$/, '');
    return s.slice(0, 120) || 'file';
  }

  async function permOf(h) {
    if (!h) return 'none';
    try {
      if (typeof h.queryPermission !== 'function') return 'granted';
      return await h.queryPermission({ mode: 'readwrite' });
    } catch (e) {
      return 'prompt';
    }
  }

  /* interactive=true 必须在点击事件里调用，否则浏览器会直接拒绝弹窗 */
  async function ensure(interactive) {
    const h = await load();
    if (!h) throw new Error('还没选产出文件夹');
    let st = await permOf(h);
    if (st === 'granted') return h;
    if (interactive) {
      try { st = await h.requestPermission({ mode: 'readwrite' }); } catch (e) { st = 'denied'; }
    }
    if (st !== 'granted') {
      const err = new Error(st === 'denied' ? '你拒绝了文件夹权限' : '需要你点一下授权才能写入');
      err.code = st === 'denied' ? 'denied' : 'need-permission';
      throw err;
    }
    return h;
  }

  async function pick() {
    if (!supported()) throw new Error('这个浏览器不支持选择本地文件夹，请用 Chrome / Edge 桌面版');
    const h = await window.showDirectoryPicker({ id: 'ba-out', mode: 'readwrite', startIn: 'documents' });
    handle = h;
    loaded = true;
    await idbSet(KEY, h);
    /* 选完就核一次权限，没拿到就直接说，别等写的时候才报错 */
    const st = await permOf(h);
    if (st !== 'granted') {
      await h.requestPermission({ mode: 'readwrite' }).catch(() => {});
    }
    return { name: h.name, perm: await permOf(h) };
  }

  async function forget() {
    handle = null;
    loaded = true;
    try { await idbDel(KEY); } catch (e) { /* 删不掉也不影响下次重新选 */ }
    return true;
  }

  async function dirFor(rel, create) {
    const h = await ensure(false);
    const parts = String(rel || '').split('/').map(safeSeg).filter(s => s && s !== '.');
    const name = parts.pop();
    let dir = h;
    for (const p of parts) dir = await dir.getDirectoryHandle(p, { create: !!create });
    return { dir, name };
  }

  /* 写一个文件，rel 是相对用户所选文件夹的路径（含子目录），自动建目录 */
  async function write(rel, blob) {
    const { dir, name } = await dirFor(rel, true);
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    try {
      await w.write(blob);
    } finally {
      await w.close();
    }
    return String(rel);
  }

  async function read(rel) {
    const { dir, name } = await dirFor(rel, false);
    const fh = await dir.getFileHandle(name);
    return fh.getFile();
  }

  async function has(rel) {
    try {
      const { dir, name } = await dirFor(rel, false);
      await dir.getFileHandle(name);
      return true;
    } catch (e) {
      return false;
    }
  }

  /* 纯净文本读写，用来放 _index.json（记录「工作区路径 → 本地文件名」） */
  async function writeJSON(rel, obj) {
    return write(rel, new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }));
  }

  async function readJSON(rel) {
    try {
      const f = await read(rel);
      return JSON.parse(await f.text());
    } catch (e) {
      return null;
    }
  }

  async function status() {
    if (!supported()) return { supported: false, has: false, name: '', perm: 'none' };
    const h = await load();
    return { supported: true, has: !!h, name: h ? h.name : '', perm: await permOf(h) };
  }

  window.LOCALFS = {
    supported,
    status,
    pick,
    forget,
    ensure,
    write,
    read,
    has,
    writeJSON,
    readJSON,
    safeSeg,
    rootName: () => (handle ? handle.name : '')
  };
})();
