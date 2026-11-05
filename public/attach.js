/* 附件：选文件 / 拖进来 / 粘贴截图 → 传到工作区 uploads/ → 变成 chip
 *
 * 关键约定：
 *   - 文档类（PDF/Word/Excel/PPT/CSV）传上去只是落盘，内容由员工用 read_doc 现读
 *   - 图片在内存里留一份 dataURL，直接交给支持视觉的模型看；持久化只存路径
 *   - 上传是「发送前」完成的（选完就传），所以点执行时附件已经在工作区里了
 */
(function () {
  const OK_EXT = /\.(pdf|docx?|xlsx?|pptx?|csv|tsv|txt|md|png|jpe?g|webp|gif|bmp)$/i;
  const IMG_EXT = /\.(png|jpe?g|webp|gif|bmp)$/i;
  const MAX = 20 * 1024 * 1024;

  const sizeText = n => (n > 1048576 ? (n / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(n / 1024)) + 'KB');
  const kindOf = name => {
    const m = /\.([a-z0-9]+)$/i.exec(name || '');
    return (m ? m[1] : '?').toUpperCase();
  };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function readAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ''));
      fr.onerror = () => reject(new Error('读不了这个文件'));
      fr.readAsDataURL(file);
    });
  }

  /* 图片压一下再传：手机截图动辄 4-6MB，模型看 1400px 已经足够 */
  async function shrinkImage(file, maxSide = 1400, quality = 0.82) {
    const url = await readAsDataURL(file);
    if (!/^data:image\/(png|jpeg|webp)/i.test(url)) return { dataUrl: url, name: file.name, size: file.size };
    try {
      const img = await new Promise((res, rej) => {
        const im = new Image();
        im.onload = () => res(im);
        im.onerror = () => rej(new Error('图片打不开'));
        im.src = url;
      });
      const side = Math.max(img.width, img.height);
      if (side <= maxSide && file.size <= 1.2 * 1024 * 1024) return { dataUrl: url, name: file.name, size: file.size };
      const k = Math.min(1, maxSide / side);
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * k);
      cv.height = Math.round(img.height * k);
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.drawImage(img, 0, 0, cv.width, cv.height);
      const out = cv.toDataURL('image/jpeg', quality);
      return { dataUrl: out, name: file.name.replace(/\.[^.]+$/, '') + '.jpg', size: Math.round(out.length * 0.75) };
    } catch {
      return { dataUrl: url, name: file.name, size: file.size };
    }
  }

  /**
   * opts: { btn, input, list, getScope, toast, onChange }
   * 返回 { items(), docs(), images(), clear(), take(), render(), addFiles() }
   */
  function create(opts) {
    const { btn, input, list } = opts;
    const toast = opts.toast || (m => console.warn(m));
    let items = [];
    let busy = 0;

    function render() {
      if (!list) return;
      if (!items.length) { list.hidden = true; list.innerHTML = ''; }
      else {
        list.hidden = false;
        list.innerHTML = items.map((it, i) => `
          <span class="att" data-i="${i}" title="${esc(it.path || it.name)}">
            ${it.thumb ? `<img class="att-th" src="${it.thumb}" alt="">` : `<i class="att-ic">${esc(kindOf(it.name))}</i>`}
            <span class="att-nm">${esc(it.name)}</span>
            <span class="att-sz">${it.failed ? '失败' : sizeText(it.size)}</span>
            <b class="att-x" data-x="${i}" title="移除">×</b>
          </span>`).join('');
      }
      if (opts.onChange) opts.onChange(items.slice());
    }

    async function uploadOne(file) {
      if (file.size > MAX) { toast(`${file.name} 太大（${sizeText(file.size)}），单个上限 20MB`); return null; }
      let payload = { dataUrl: null, name: file.name, size: file.size };
      if (IMG_EXT.test(file.name) || /^image\//.test(file.type)) payload = await shrinkImage(file);
      if (!payload.dataUrl) payload.dataUrl = await readAsDataURL(file);

      const b64 = payload.dataUrl.replace(/^data:[^,]*,/, '');
      const scope = opts.getScope && opts.getScope();
      if (!scope) { toast('还没有工作区，先登录或刷新一下'); return null; }

      const r = await fetch(window.withSC ? window.withSC('/api/upload') : '/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, name: payload.name, data: b64 })
      });
      const j = await r.json().catch(() => ({ ok: false, error: '上传失败（返回不是 JSON）' }));
      if (!j.ok) { toast(`${payload.name}：${j.error || '上传失败'}`); return null; }

      const isImg = /^image\//.test(j.mime || '');
      return {
        name: payload.name,
        path: j.path,
        size: j.size,
        kind: j.kind,
        mime: j.mime,
        thumb: isImg ? payload.dataUrl : null,
        dataUrl: isImg ? payload.dataUrl : null
      };
    }

    async function addFiles(files) {
      const arr = Array.from(files || []);
      if (!arr.length) return;
      for (const f of arr) {
        if (!OK_EXT.test(f.name)) { toast(`不支持的格式：${f.name}`); continue; }
        const it = await uploadOne(f);
        if (it) { items.push(it); render(); }
      }
    }

    if (btn && input) {
      btn.onclick = () => input.click();
      input.onchange = async () => {
        await addFiles(input.files);
        input.value = '';
      };
    }

    if (list) {
      list.onclick = e => {
        const x = e.target.closest('[data-x]');
        if (!x) return;
        items.splice(Number(x.dataset.x), 1);
        render();
      };
    }

    render();

    return {
      items: () => items.slice(),
      docs: () => items.filter(x => !x.dataUrl),
      images: () => items.filter(x => x.dataUrl),
      clear: () => { items = []; render(); },
      take: () => { const c = items.slice(); items = []; render(); return c; },
      /* 放回去：take 之后发现这句话没送出去（服务端那一轮已经结束了），
         附件得原样退回输入区，不然图就跟着那句一起丢了 */
      restore: list => { items = (list || []).slice(); render(); },
      addFiles,
      render
    };
  }

  window.ATT = { create, sizeText, esc };
})();
