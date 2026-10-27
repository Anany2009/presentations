/* Presentation editor — edit text, photos, slides, notes and theme in the browser, then save to GitHub.
 *
 * Loaded by every presentation page (p/<slug>/index.html). Press E or the ✎ button to start editing.
 * Saving commits the page (and any new photos) to the GitHub repository through the GitHub API, using a
 * fine-grained token the owner pastes once (kept only in this browser's localStorage).
 */
(() => {
  const REPO = (() => {
    // https://<owner>.github.io/<repo>/p/<slug>/  →  owner, repo, path of this page inside the repo
    const m = location.hostname.match(/^([^.]+)\.github\.io$/);
    const parts = location.pathname.split('/').filter(Boolean);
    const owner = m ? m[1] : (localStorage.getItem('ed.owner') || '');
    const repo = m ? parts[0] : (localStorage.getItem('ed.repo') || '');
    const inRepo = m ? parts.slice(1) : parts.slice(parts.indexOf('p'));
    let page = inRepo.join('/');
    if (!page || page.endsWith('/')) page += 'index.html';
    if (!page.endsWith('.html')) page += '/index.html';
    return { owner, repo, page, branch: 'main' };
  })();
  const ROOT_REL = '../../';                    // from p/<slug>/ back to the repo root
  const LOCKED = el => /[﴿﴾]/.test(el.textContent);   // Qur'anic text stays locked to protect accuracy
  const pending = new Map();                    // img element -> File waiting to be uploaded
  let on = false, dirty = false;

  /* ---------- UI ---------- */
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = ROOT_REL + 'editor/editor.css';
  document.head.appendChild(css);

  const root = document.createElement('div');
  root.id = 'ed-root';
  root.innerHTML = `
    <button id="ed-toggle" title="تعديل (E)">✎</button>
    <aside id="ed-panel" dir="rtl" hidden>
      <header><b>وضع التعديل</b><button id="ed-close" title="إنهاء التعديل">✕</button></header>
      <section>
        <label>الشريحة الحالية</label>
        <div class="ed-row">
          <button data-act="prev">→ السابقة</button><span id="ed-num"></span><button data-act="next">التالية ←</button>
        </div>
        <div class="ed-grid">
          <button data-act="dup">نسخ الشريحة</button>
          <button data-act="del">حذف الشريحة</button>
          <button data-act="up">تقديمها</button>
          <button data-act="down">تأخيرها</button>
        </div>
        <label>إضافة شريحة جديدة بعد الحالية</label>
        <div class="ed-grid">
          <button data-add="title">عنوان</button>
          <button data-add="photo">صورة وعنوان</button>
          <button data-add="quote">عبارة كبيرة</button>
          <button data-add="list">نقاط</button>
        </div>
      </section>
      <section>
        <label>ملاحظات المتحدث لهذه الشريحة</label>
        <textarea id="ed-notes" rows="6"></textarea>
      </section>
      <section>
        <label>التصميم</label>
        <select id="ed-theme">
          <option value="night">ليل المسجد</option>
          <option value="stone">حجر المدينة (فاتح)</option>
          <option value="roots">الجذور والفروع</option>
        </select>
      </section>
      <section class="ed-tips">
        انقر على أي نص لتعديله · انقر على أي صورة لاستبدالها · نص القرآن مقفل حفاظًا على دقته.
      </section>
      <section>
        <button id="ed-save" class="primary">حفظ ونشر على الرابط</button>
        <button id="ed-copy">نسخة جديدة لمسجد أو مركز آخر…</button>
        <button id="ed-key" class="link">إعداد مفتاح GitHub</button>
        <div id="ed-status"></div>
      </section>
    </aside>
    <input type="file" id="ed-file" accept="image/*" hidden>`;
  document.body.appendChild(root);
  const $ = sel => root.querySelector(sel);
  const status = (msg, kind = '') => { const s = $('#ed-status'); s.textContent = msg; s.className = kind; };

  /* ---------- edit mode ---------- */
  function setEditing(v) {
    on = v;
    document.body.classList.toggle('editing', on);
    $('#ed-panel').hidden = !on;
    deck.revealAll(on);
    document.querySelectorAll('.slide').forEach(s => deck.textBlocks(s).forEach(el => {
      if (on && !LOCKED(el)) el.setAttribute('contenteditable', 'plaintext-only');
      else el.removeAttribute('contenteditable');
      el.classList.toggle('ed-locked', on && LOCKED(el));
    }));
    if (on) sync(); else deck.show(deck.cur, 0);
  }
  function sync() {
    const s = deck.slides[deck.cur];
    $('#ed-num').textContent = `${deck.cur + 1} / ${deck.slides.length}`;
    $('#ed-notes').value = (s.querySelector('aside.notes') || {}).textContent || '';
    $('#ed-theme').value = document.documentElement.dataset.theme || 'night';
  }
  const go = i => { deck.show(i, 0); deck.revealAll(true); sync(); };

  $('#ed-toggle').onclick = () => setEditing(!on);
  $('#ed-close').onclick = () => setEditing(false);
  addEventListener('keydown', e => {
    if ((e.key === 'e' || e.key === 'E') && !e.target.isContentEditable && !/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) setEditing(!on);
  });
  addEventListener('input', e => { if (on && e.target.isContentEditable) dirty = true; });
  addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

  /* ---------- slide operations ---------- */
  root.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    const act = b.dataset.act, add = b.dataset.add;
    const s = deck.slides[deck.cur];
    if (act === 'prev') go(Math.max(0, deck.cur - 1));
    if (act === 'next') go(Math.min(deck.slides.length - 1, deck.cur + 1));
    if (act === 'dup') { const c = s.cloneNode(true); s.after(c); finish(deck.cur + 1); }
    if (act === 'del' && deck.slides.length > 1 && confirm('حذف هذه الشريحة؟')) { s.remove(); finish(Math.max(0, deck.cur - 1)); }
    if (act === 'up' && s.previousElementSibling?.classList.contains('slide')) { s.previousElementSibling.before(s); finish(deck.cur - 1); }
    if (act === 'down' && s.nextElementSibling?.classList.contains('slide')) { s.nextElementSibling.after(s); finish(deck.cur + 1); }
    if (add) { const t = document.createElement('template'); t.innerHTML = TEMPLATES[add].trim(); s.after(t.content.firstChild); finish(deck.cur + 1); }
  });
  function finish(i) {
    dirty = true;
    deck.refresh();
    setEditing(true);
    go(i);
  }
  $('#ed-notes').oninput = e => {
    const s = deck.slides[deck.cur];
    let a = s.querySelector('aside.notes');
    if (!a) { a = document.createElement('aside'); a.className = 'notes'; s.appendChild(a); }
    a.textContent = e.target.value;
    dirty = true;
  };
  $('#ed-theme').onchange = e => { document.documentElement.dataset.theme = e.target.value; dirty = true; };

  /* ---------- photos ---------- */
  let target = null;
  document.addEventListener('click', e => {
    if (!on) return;
    const img = e.target.closest('.slide img');
    if (!img) return;
    e.preventDefault();
    target = img;
    $('#ed-file').click();
  }, true);
  $('#ed-file').onchange = e => {
    const f = e.target.files[0];
    if (!f || !target) return;
    pending.set(target, f);
    target.src = URL.createObjectURL(f);
    target.closest('.por')?.querySelector('.mono')?.remove();
    dirty = true;
    e.target.value = '';
  };

  /* ---------- GitHub ---------- */
  const token = () => localStorage.getItem('ed.token');
  $('#ed-key').onclick = askKey;
  function askKey() {
    const t = prompt('الصق مفتاح GitHub (fine-grained token) الذي يملك صلاحية Contents: Read and write على هذا المستودع.\nيُحفظ في هذا المتصفح فقط.', token() || '');
    if (t !== null) localStorage.setItem('ed.token', t.trim());
    if (!REPO.owner) {
      localStorage.setItem('ed.owner', prompt('اسم حساب GitHub:', '') || '');
      localStorage.setItem('ed.repo', prompt('اسم المستودع:', '') || '');
      location.reload();
    }
  }
  async function gh(path, opts = {}) {
    const r = await fetch(`https://api.github.com/repos/${REPO.owner}/${REPO.repo}/contents/${path}`, {
      ...opts, headers: { Authorization: `Bearer ${token()}`, Accept: 'application/vnd.github+json', ...(opts.headers || {}) },
    });
    if (r.status === 404 && (!opts.method || opts.method === 'GET')) return null;
    if (!r.ok) throw new Error(`GitHub ${r.status}: ${(await r.json().catch(() => ({}))).message || ''}`);
    return r.json();
  }
  const b64 = async blob => {
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  };
  async function put(path, base64, message) {
    const old = await gh(`${path}?ref=${REPO.branch}`);
    return gh(path, { method: 'PUT', body: JSON.stringify({ message, content: base64, branch: REPO.branch, ...(old ? { sha: old.sha } : {}) }) });
  }

  // Upload new photos, then serialise the page without editor state.
  async function pageHtml() {
    for (const [img, file] of pending) {
      const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
      const name = `media/uploads/${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
      status('رفع الصور…');
      await put(name, await b64(await shrink(file)), `Photo for ${REPO.page}`);
      img.src = ROOT_REL + name;
    }
    pending.clear();
    const doc = document.documentElement.cloneNode(true);
    doc.querySelector('#ed-root')?.remove();
    doc.querySelectorAll('link[href$="editor.css"], script#export, video').forEach(n => n.remove());
    doc.querySelectorAll('[contenteditable]').forEach(n => n.removeAttribute('contenteditable'));
    doc.querySelectorAll('.on,.in,.tone-dark,.ed-locked,.editing,.cursor').forEach(n => n.classList.remove('on', 'in', 'tone-dark', 'ed-locked', 'editing', 'cursor'));
    doc.querySelectorAll('[class=""]').forEach(n => n.removeAttribute('class'));
    doc.querySelectorAll('.tl .line i').forEach(n => n.removeAttribute('style'));
    doc.querySelectorAll('.placeholder').forEach(n => n.style.removeProperty('display'));
    const num = doc.querySelector('#num'); if (num) { num.textContent = ''; num.removeAttribute('style'); }
    return '<!doctype html>\n' + doc.outerHTML;
  }
  // keep uploads reasonable for the web (long edge 2560px, JPEG)
  async function shrink(file) {
    if (!/^image\/(jpeg|png|webp)/.test(file.type)) return file;
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 2560 / Math.max(bmp.width, bmp.height));
    const c = Object.assign(document.createElement('canvas'), { width: Math.round(bmp.width * k), height: Math.round(bmp.height * k) });
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return new Promise(r => c.toBlob(r, file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.88));
  }
  const utf8 = s => btoa(unescape(encodeURIComponent(s)));
  window.__edSerialize = pageHtml;   // used by the local self-test

  $('#ed-save').onclick = async () => {
    if (!token()) { askKey(); if (!token()) return; }
    try {
      status('جارٍ الحفظ…');
      await put(REPO.page, utf8(await pageHtml()), `Edit ${REPO.page}`);
      dirty = false;
      status('تم الحفظ ✓ — يظهر على الرابط خلال دقيقة تقريبًا.', 'ok');
    } catch (err) { status('تعذّر الحفظ: ' + err.message, 'err'); }
  };

  $('#ed-copy').onclick = async () => {
    if (!token()) { askKey(); if (!token()) return; }
    const title = prompt('اسم العرض الجديد (مثلًا: لقاء مسجد النور – دالاس):');
    if (!title) return;
    const slug = prompt('اسم قصير للرابط بالإنجليزية (حروف وأرقام وشرطات):', title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'new-talk');
    if (!slug || !/^[a-z0-9-]+$/.test(slug)) { status('الاسم القصير غير صالح.', 'err'); return; }
    try {
      status('جارٍ إنشاء النسخة…');
      let html = await pageHtml();
      html = html.replace(/<title>[^<]*<\/title>/, `<title>${title.replace(/[<&]/g, '')}</title>`);
      await put(`p/${slug}/index.html`, utf8(html), `New presentation: ${title}`);
      const list = await gh(`presentations.json?ref=${REPO.branch}`);
      const items = list ? JSON.parse(decodeURIComponent(escape(atob(list.content.replace(/\n/g, ''))))) : [];
      items.push({ slug, title, created: new Date().toISOString().slice(0, 10) });
      await put('presentations.json', utf8(JSON.stringify(items, null, 2)), `List ${slug}`);
      status(`تم ✓ الرابط الجديد: ${location.origin}/${REPO.repo}/p/${slug}/ (يظهر خلال دقيقة)`, 'ok');
    } catch (err) { status('تعذّر الإنشاء: ' + err.message, 'err'); }
  };

  /* ---------- new slide templates (use the deck's own classes, so every theme applies) ---------- */
  const TEMPLATES = {
    title: `<section class="slide" data-title="New · Title">
  <div class="center">
    <div class="kick f fade">Chapter</div>
    <div class="ar h-ar f" style="margin-top:40px;font-size:96px">عنوان عربي</div>
    <div class="h-en f" style="margin-top:26px">English title</div>
  </div>
  <aside class="notes"></aside>
</section>`,
    photo: `<section class="slide" data-title="New · Photo">
  <div class="ph kb"><img class="grade" src="${ROOT_REL}media/n_dome.jpg" style="object-position:50% 50%"></div>
  <div class="shade-b"></div>
  <div class="abs" style="left:0;right:0;bottom:100px;text-align:center">
    <div class="ar h-ar f" style="font-size:88px">عنوان على الصورة</div>
    <div class="h-en f" style="margin-top:18px">Caption in English</div>
  </div>
  <aside class="notes"></aside>
</section>`,
    quote: `<section class="slide" data-title="New · Statement">
  <div class="center">
    <div class="ar big-ar f">عبارة كبيرة مؤثرة</div>
    <div class="rule f fade" style="margin:50px 300px 40px"></div>
    <div class="big-en f">A short, powerful line</div>
  </div>
  <aside class="notes"></aside>
</section>`,
    list: `<section class="slide" data-title="New · Points">
  <div class="abs" style="left:0;right:0;top:130px;text-align:center">
    <div class="ar h-ar f" style="font-size:80px">عنوان النقاط</div>
    <div class="h-en f" style="margin-top:18px">Heading</div>
  </div>
  <div class="words" style="top:480px">
    <div class="word f"><div class="ar w-ar" style="font-size:70px">الأولى</div><div class="w-en">First</div></div>
    <div class="word f"><div class="ar w-ar" style="font-size:70px">الثانية</div><div class="w-en">Second</div></div>
    <div class="word f"><div class="ar w-ar" style="font-size:70px">الثالثة</div><div class="w-en">Third</div></div>
  </div>
  <aside class="notes"></aside>
</section>`,
  };
})();
