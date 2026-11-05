 
    /* ================= helpers ================= */
    const $ = s => document.querySelector(s);
    const AUDIO_EXT = /\.(mp3|m4a|flac|wav|ogg|opus|aac)$/i;
    const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const fmt = s => { if (!isFinite(s) || s <= 0) return '0:00'; s = Math.floor(s); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
    const ICON_NOTE = '<svg viewBox="0 0 24 24"><path d="M12 3v10.600A4 4 0 1 0 14 17V7h4V3z"/></svg>';
    const ICON_PLAY = '<svg class="pl" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
    const ICON_HEART = '<svg viewBox="0 0 24 24"><path d="M12 21s-7.500-4.600-9.600-9.200C.9 8.400 3 5 6.400 5c2 0 3.700 1.100 5.600 3.200C13.900 6.100 15.600 5 17.600 5 21 5 23.100 8.400 21.600 11.800 19.500 16.400 12 21 12 21z"/></svg>';
    const ICON_PAUSE = '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>';
    const ICON_PLAYP = '<path d="M8 5v14l11-7z"/>';
    let toastT; function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2200); }

    /* tiny IndexedDB key-value store (remembers your music folder) */
    const idb = () => new Promise((res, rej) => { const r = indexedDB.open('vinyl', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    async function kvGet(k) { try { const db = await idb(); return await new Promise(res => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(); }); } catch { return; } }
    async function kvSet(k, v) { try { const db = await idb(); await new Promise(res => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = res; tx.onerror = res; }); } catch { } }

    /* ================= state ================= */
    let tracks = [], shown = [], uidCounter = 0, scanToken = 0;
    let view = { type: 'all' };
    let queue = [], qi = -1, history = [];
    let shuffle = false, repeat = 0;           // repeat: 0 off, 1 all, 2 one
    let dirHandle = null, curUrl = null, curTrack = null;
    let liked = new Set(JSON.parse(localStorage.getItem('vinyl.liked') || '[]'));
    const audio = new Audio();
    audio.volume = +(localStorage.getItem('vinyl.vol') ?? 0.8);

    /* ================= scanning ================= */
    async function walk(dir, path, out) {
      for await (const [name, h] of dir.entries()) {
        if (name.startsWith('.')) continue;
        if (h.kind === 'directory') await walk(h, path + name + '/', out);
        else if (AUDIO_EXT.test(name)) out.push({ h, path: path + name, name });
      }
    }
    async function scanHandle(handle) {
      const token = ++scanToken;
      $('#status').textContent = 'Scanning ' + handle.name + '…';
      const found = []; await walk(handle, '', found);
      const items = [];
      for (const f of found) { try { items.push({ file: await f.h.getFile(), path: f.path, name: f.name }); } catch { } }
      await ingest(items, token, handle.name);
    }
    async function ingest(items, token, label) {
      tracks = items.map(it => ({
        uid: ++uidCounter, id: it.path, file: it.file, name: it.name,
        title: it.name.replace(AUDIO_EXT, '').replace(/[_]+/g, ' ').replace(/^\d+\s*[-.]\s*/, '').trim() || it.name,
        artist: 'Unknown artist', album: 'Unknown album', no: 0, dur: 0, coverUrl: null, mod: it.file.lastModified || 0
      }));
      $('#status').textContent = tracks.length ? `${tracks.length} songs · ${label}` : '';
      if (!tracks.length) toast('No audio files found in that folder');
      render();
      enrich(tracks.slice(), token);
    }
    async function enrich(list, token) {
      let n = 0;
      for (const t of list) {
        if (token !== scanToken) return;
        try { await readTags(t); } catch { }
        await getDuration(t);
        updateRow(t);
        if (++n % 25 === 0) await new Promise(r => setTimeout(r));
      }
      if (token === scanToken && (view.type === 'albums' || $('#sort').value !== 'title')) render(true);
    }
    function getDuration(t) {
      return new Promise(res => {
        const a = new Audio(), u = URL.createObjectURL(t.file);
        const done = () => { URL.revokeObjectURL(u); a.removeAttribute('src'); res(); };
        a.preload = 'metadata';
        a.onloadedmetadata = () => { t.dur = a.duration; done(); };
        a.onerror = done; setTimeout(done, 3000); a.src = u;
      });
    }

    /* ---------- ID3v2 reader (title / artist / album / track no. / cover art) ---------- */
    function decodeText(body) {
      if (!body.length) return '';
      const enc = body[0], d = body.subarray(1); let s;
      if (enc === 1) { s = (d[0] === 0xFE && d[1] === 0xFF) ? new TextDecoder('utf-16be').decode(d.subarray(2)) : new TextDecoder('utf-16le').decode(d); }
      else if (enc === 2) s = new TextDecoder('utf-16be').decode(d);
      else if (enc === 3) s = new TextDecoder('utf-8').decode(d);
      else s = new TextDecoder('windows-1252').decode(d);
      return s.split('\0')[0].replace(/^\uFEFF/, '').trim();
    }
    function decodePic(body, v2) {
      const enc = body[0]; let p = 1, mime;
      if (v2) { mime = 'image/' + (String.fromCharCode(...body.slice(1, 4)).toLowerCase() === 'png' ? 'png' : 'jpeg'); p = 4; }
      else { let e = p; while (e < body.length && body[e] !== 0) e++; mime = String.fromCharCode(...body.slice(p, e)) || 'image/jpeg'; p = e + 1; }
      p++;
      if (enc === 1 || enc === 2) { while (p + 1 < body.length && !(body[p] === 0 && body[p + 1] === 0)) p += 2; p += 2; }
      else { while (p < body.length && body[p] !== 0) p++; p++; }
      if (!mime.startsWith('image/')) mime = 'image/jpeg';
      return new Blob([body.subarray(p)], { type: mime });
    }
    async function readTags(t) {
      if (!/\.mp3$/i.test(t.name)) return;
      const head = new Uint8Array(await t.file.slice(0, 10).arrayBuffer());
      if (String.fromCharCode(head[0], head[1], head[2]) !== 'ID3') return;
      const ver = head[3], size = (head[6] << 21) | (head[7] << 14) | (head[8] << 7) | head[9];
      const buf = new Uint8Array(await t.file.slice(10, 10 + Math.min(size, 12e6)).arrayBuffer());
      const idLen = ver === 2 ? 3 : 4, hdr = ver === 2 ? 6 : 10; let p = 0;
      while (p + hdr <= buf.length) {
        const id = String.fromCharCode(...buf.subarray(p, p + idLen));
        if (!/^[A-Z0-9]+$/.test(id)) break;
        let fs;
        if (ver === 2) fs = (buf[p + 3] << 16) | (buf[p + 4] << 8) | buf[p + 5];
        else if (ver === 4) fs = (buf[p + 4] << 21) | (buf[p + 5] << 14) | (buf[p + 6] << 7) | buf[p + 7];
        else fs = ((buf[p + 4] << 24) | (buf[p + 5] << 16) | (buf[p + 6] << 8) | buf[p + 7]) >>> 0;
        const body = buf.subarray(p + hdr, p + hdr + fs); p += hdr + fs;
        if (!fs) continue;
        if (id === 'TIT2' || id === 'TT2') t.title = decodeText(body) || t.title;
        else if (id === 'TPE1' || id === 'TP1') t.artist = decodeText(body) || t.artist;
        else if (id === 'TALB' || id === 'TAL') t.album = decodeText(body) || t.album;
        else if (id === 'TRCK' || id === 'TRK') t.no = parseInt(decodeText(body)) || 0;
        else if ((id === 'APIC' || id === 'PIC') && !t.coverUrl) { try { t.coverUrl = URL.createObjectURL(decodePic(body, ver === 2)); } catch { } }
      }
    }

    /* ================= folder picking ================= */
    async function pickFolder() {
      if (window.showDirectoryPicker) {
        try {
          const h = await showDirectoryPicker({ id: 'vinyl-music', mode: 'read', startIn: 'music' });
          dirHandle = h; await kvSet('dir', h); await scanHandle(h);
        } catch (e) { if (e.name !== 'AbortError') toast('Could not open that folder'); }
      } else $('#fallback').click();
    }
    $('#fallback').onchange = async e => {
      const files = [...e.target.files].filter(f => AUDIO_EXT.test(f.name));
      const token = ++scanToken;
      await ingest(files.map(f => ({ file: f, path: f.webkitRelativePath || f.name, name: f.name })), token, 'selected folder');
      e.target.value = '';
    };
    async function reconnect() {
      if (!dirHandle) return pickFolder();
      try {
        if (await dirHandle.requestPermission({ mode: 'read' }) === 'granted') await scanHandle(dirHandle);
        else toast('Permission needed to read your music folder');
      } catch { pickFolder(); }
    }
    $('#rescan').onclick = () => dirHandle ? reconnect() : pickFolder();
    $('#change').onclick = pickFolder;

    /* drag & drop a folder anywhere */
    addEventListener('dragover', e => { e.preventDefault(); $('#main').classList.add('drop'); });
    addEventListener('dragleave', e => { if (!e.relatedTarget) $('#main').classList.remove('drop'); });
    addEventListener('drop', async e => {
      e.preventDefault(); $('#main').classList.remove('drop');
      const it = [...e.dataTransfer.items].find(i => i.kind === 'file');
      if (it && it.getAsFileSystemHandle) {
        const h = await it.getAsFileSystemHandle();
        if (h && h.kind === 'directory') { dirHandle = h; kvSet('dir', h); scanHandle(h); }
      }
    });

    /* ================= view / render ================= */
    function sortKey() { return $('#sort').value; }
    function currentList() {
      let l = tracks;
      if (view.type === 'liked') l = l.filter(t => liked.has(t.id));
      if (view.type === 'album') l = l.filter(t => t.album === view.album);
      const q = $('#q').value.trim().toLowerCase();
      if (q) l = l.filter(t => (t.title + ' ' + t.artist + ' ' + t.album).toLowerCase().includes(q));
      const k = sortKey(); l = l.slice();
      if (view.type === 'album') l.sort((a, b) => (a.no || 999) - (b.no || 999) || a.title.localeCompare(b.title));
      else if (k === 'added') l.sort((a, b) => b.mod - a.mod);
      else l.sort((a, b) => a[k].localeCompare(b[k]) || a.title.localeCompare(b.title));
      return l;
    }
    function hue(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
    function thumb(t) { return t.coverUrl ? `<img src="${t.coverUrl}" alt="">` : ICON_NOTE; }
    function rowInner(t, i) {
      return `<div class="idx"><span class="n">${i + 1}</span>${ICON_PLAY}<span class="eq"><i></i><i></i><i></i></span></div>
  <div class="ti"><div class="th">${thumb(t)}</div><div class="tx"><b>${esc(t.title)}</b><span>${esc(t.artist)}</span></div></div>
  <div class="al">${esc(t.album)}</div>
  <button class="icon lk ${liked.has(t.id) ? 'on' : ''}" data-like="${t.uid}" title="Like">${ICON_HEART}</button>
  <div class="tm">${t.dur ? fmt(t.dur) : '–:––'}</div>`;
    }
    function updateRow(t) {
      const r = document.querySelector(`.row[data-uid="${t.uid}"]`);
      if (r) r.innerHTML = rowInner(t, +r.dataset.i);
    }
    const TITLES = { all: 'Songs', liked: 'Liked Songs', albums: 'Albums' };
    function render(keepScroll) {
      const main = $('#main'), sc = main.scrollTop, c = $('#content');
      document.querySelectorAll('.nav').forEach(n => n.classList.toggle('active', n.dataset.view === (view.type === 'album' ? 'albums' : view.type)));
      if (!tracks.length) {
        c.innerHTML = `<div class="empty"><div class="box"><div class="disc"></div>
      <h2>Your music, your way.</h2>
      <p>Pick the folder where your music lives. Vinyl finds every song inside it (sub-folders too), reads the titles, artists and cover art, and gets out of your way.</p>
      <button class="cta" id="pick">Choose music folder</button>
      <small id="hint">Best in Chrome or Edge — everything stays on your laptop, nothing is uploaded.</small></div></div>`;
        $('#pick').onclick = pickFolder;
        if (dirHandle) {
          $('#pick').textContent = `Reconnect “${dirHandle.name}”`;
          $('#pick').onclick = reconnect;
          c.querySelector('.box').insertAdjacentHTML('beforeend', '');
          const alt = document.createElement('button'); alt.className = 'cta alt'; alt.textContent = 'Pick another'; alt.onclick = pickFolder;
          $('#pick').after(alt);
        }
        return;
      }
      if (view.type === 'albums') {
        const map = new Map();
        for (const t of currentList()) { if (!map.has(t.album)) map.set(t.album, { name: t.album, artist: t.artist, cover: null, n: 0 }); const a = map.get(t.album); a.n++; if (!a.cover && t.coverUrl) a.cover = t.coverUrl; }
        const albums = [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
        c.innerHTML = `<div class="hero"><div><small>Library</small><h1>Albums</h1><p>${albums.length} albums · ${tracks.length} songs</p></div></div>
      <div class="grid">${albums.map(a => `<button class="card" data-album="${esc(a.name)}"><div class="cv" style="background:${a.cover ? '#222' : `linear-gradient(135deg,hsl(${hue(a.name)} 60% 45%),hsl(${(hue(a.name) + 60) % 360} 50% 20%))`}">${a.cover ? `<img src="${a.cover}" alt="">` : ICON_NOTE}</div><b>${esc(a.name)}</b><span>${esc(a.artist)} · ${a.n} song${a.n > 1 ? 's' : ''}</span></button>`).join('')}</div>`;
      } else {
        shown = currentList();
        const total = shown.reduce((s, t) => s + (t.dur || 0), 0);
        const mins = Math.round(total / 60);
        const title = view.type === 'album' ? view.album : TITLES[view.type];
        const cover = shown.find(t => t.coverUrl);
        c.innerHTML = `<div class="hero"><div class="art">${view.type === 'album' && cover ? `<img src="${cover.coverUrl}" alt="">` : ICON_NOTE}</div>
      <div><small>${view.type === 'album' ? 'Album' : 'Playlist'}</small><h1>${esc(title)}</h1>
      <p>${shown.length} song${shown.length === 1 ? '' : 's'}${mins ? ` · about ${mins} min` : ''}</p></div></div>
      <div class="actions"><button class="bigplay" id="playAll" title="Play">${'<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>'}</button>
        <button class="icon ${shuffle ? 'on' : ''}" id="shuffle2" title="Shuffle"><svg viewBox="0 0 24 24"><path d="M17 3l4 4-4 4V8h-2.600l-3 4 3 4H17v-3l4 4-4 4v-3h-3.600L9 13.200 6.200 17H3v-2h2.200l3-4-3-4H3V5h3.200L9 8.800 12.400 5H17z"/></svg></button></div>
      ${shown.length ? `<div class="head"><span style="text-align:center">#</span><span>Title</span><span class="al">Album</span><span></span><span style="text-align:right">Time</span></div>
      <div class="list" id="list">${shown.map((t, i) => `<div class="row ${curTrack && curTrack.uid === t.uid ? 'playing' : ''}" data-uid="${t.uid}" data-i="${i}">${rowInner(t, i)}</div>`).join('')}</div>`
            : `<div class="empty" style="min-height:30vh"><div class="box"><p>${view.type === 'liked' ? 'Tap the heart on any song and it will show up here.' : 'Nothing matches your search.'}</p></div></div>`}`;
        $('#playAll').onclick = () => { if (shown.length) { if (!shuffle) setShuffle(false); startQueue(shown, shuffle ? Math.floor(Math.random() * shown.length) : 0); } };
        $('#shuffle2').onclick = () => { setShuffle(!shuffle); render(true); };
      }
      if (keepScroll) main.scrollTop = sc;
    }
    document.addEventListener('click', e => {
      const nav = e.target.closest('.nav'); if (nav) { view = { type: nav.dataset.view }; $('#q').value = ''; render(); $('#main').scrollTop = 0; return; }
      const card = e.target.closest('.card'); if (card) { view = { type: 'album', album: card.dataset.album }; render(); $('#main').scrollTop = 0; return; }
      const lk = e.target.closest('[data-like]'); if (lk) { e.stopPropagation(); toggleLike(tracks.find(t => t.uid == lk.dataset.like)); return; }
      const row = e.target.closest('.row'); if (row) startQueue(shown, +row.dataset.i);
    });
    $('#q').oninput = () => { if (view.type === 'albums') view = { type: 'all' }; render(); };
    $('#sort').onchange = () => render();

    /* ================= likes ================= */
    function toggleLike(t) {
      if (!t) return;
      liked.has(t.id) ? liked.delete(t.id) : liked.add(t.id);
      localStorage.setItem('vinyl.liked', JSON.stringify([...liked]));
      if (view.type === 'liked') render(true); else updateRow(t);
      syncNow();
    }
    $('#npLike').onclick = () => toggleLike(curTrack);

    /* ================= playback ================= */
    function startQueue(list, i) { queue = list.slice(); qi = i; history = []; loadTrack(queue[qi]); }
    function loadTrack(t) {
      if (!t) return;
      if (curUrl) URL.revokeObjectURL(curUrl);
      curUrl = URL.createObjectURL(t.file); curTrack = t;
      audio.src = curUrl; audio.play().catch(() => { });
      syncNow(); setAccent(t); mediaSession(t);
      document.title = `${t.title} · Vinyl`;
      document.querySelectorAll('.row.playing').forEach(r => r.classList.remove('playing'));
      const r = document.querySelector(`.row[data-uid="${t.uid}"]`); if (r) r.classList.add('playing');
    }
    function next(auto) {
      if (!queue.length) return;
      if (auto && repeat === 2) { audio.currentTime = 0; audio.play(); return; }
      history.push(qi);
      if (shuffle && queue.length > 1) { let n; do n = Math.floor(Math.random() * queue.length); while (n === qi); qi = n; }
      else if (qi + 1 < queue.length) qi++;
      else if (repeat === 1 || !auto) qi = 0;
      else { audio.pause(); audio.currentTime = 0; return; }
      loadTrack(queue[qi]);
    }
    function prev() {
      if (!queue.length) return;
      if (audio.currentTime > 3) { audio.currentTime = 0; return; }
      if (history.length) qi = history.pop(); else qi = (qi - 1 + queue.length) % queue.length;
      loadTrack(queue[qi]);
    }
    function toggle() { if (!curTrack) { if (shown.length) startQueue(shown, 0); return; } audio.paused ? audio.play() : audio.pause(); }
    function setShuffle(v) { shuffle = v; $('#shuffle').classList.toggle('on', v); toast(v ? 'Shuffle on' : 'Shuffle off'); }
    $('#shuffle').onclick = () => { setShuffle(!shuffle); const s2 = $('#shuffle2'); if (s2) s2.classList.toggle('on', shuffle); };
    $('#repeat').onclick = () => {
      repeat = (repeat + 1) % 3; $('#repeat').classList.toggle('on', repeat > 0); toast(['Repeat off', 'Repeat all', 'Repeat one'][repeat]);
      $('#repIcon').innerHTML = repeat === 2 ? '<path d="M7 7h10v3l4-4-4-4v3H5v6h2zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2z"/><text x="12" y="15" font-size="8" font-weight="900" text-anchor="middle" fill="#000">1</text>' : '<path d="M7 7h10v3l4-4-4-4v3H5v6h2zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2z"/>';
    };
    $('#pp').onclick = toggle; $('#next').onclick = () => next(false); $('#prev').onclick = prev;
    audio.onended = () => next(true);
    audio.onplay = audio.onpause = () => { document.body.classList.toggle('playing', !audio.paused); $('#ppIcon').innerHTML = audio.paused ? ICON_PLAYP : ICON_PAUSE; };
    audio.ontimeupdate = () => {
      const d = audio.duration || 0, c = audio.currentTime;
      $('#cur').textContent = fmt(c); $('#dur').textContent = fmt(d);
      if (!seeking) { const v = d ? c / d * 1000 : 0; $('#seekbar').value = v; $('#seekbar').style.setProperty('--p', v / 10 + '%'); }
      if (curTrack && !curTrack.dur && d) { curTrack.dur = d; updateRow(curTrack); }
    };
    let seeking = false; const sb = $('#seekbar');
    sb.oninput = () => { seeking = true; sb.style.setProperty('--p', sb.value / 10 + '%'); $('#cur').textContent = fmt(audio.duration * sb.value / 1000); };
    sb.onchange = () => { if (audio.duration) audio.currentTime = audio.duration * sb.value / 1000; seeking = false; };
    const vol = $('#vol'); vol.value = audio.volume * 100; vol.style.setProperty('--p', vol.value + '%');
    vol.oninput = () => { audio.volume = vol.value / 100; audio.muted = false; vol.style.setProperty('--p', vol.value + '%'); localStorage.setItem('vinyl.vol', audio.volume); volIcon(); };
    function volIcon() { $('#volIcon').innerHTML = (audio.muted || audio.volume === 0) ? '<path d="M3 9v6h4l5 5V4L7 9zm13.600 3l2.400-2.400-1.400-1.400L15.200 10.600 12.800 8.200l-1.400 1.400L13.800 12l-2.400 2.400 1.400 1.400 2.400-2.400 2.400 2.400 1.400-1.400z"/>' : '<path d="M3 9v6h4l5 5V4L7 9zm13.500 3A4.500 4.500 0 0 0 14 8v8a4.500 4.500 0 0 0 2.500-4z"/>'; }
    $('#mute').onclick = () => { audio.muted = !audio.muted; volIcon(); };
    volIcon();

    function syncNow() {
      const t = curTrack; if (!t) return;
      $('#npTitle').textContent = t.title; $('#npArtist').textContent = t.artist + (t.album !== 'Unknown album' ? ' · ' + t.album : '');
      $('#npCover').innerHTML = t.coverUrl ? `<img src="${t.coverUrl}" alt="">` : ICON_NOTE;
      $('#npLike').classList.toggle('on', liked.has(t.id));
    }
    function setAccent(t) {
      const apply = (r, g, b) => {
        const m = Math.max(r, g, b); if (m < 120) { const k = 150 / Math.max(m, 1); r = Math.min(255, r * k | 0); g = Math.min(255, g * k | 0); b = Math.min(255, b * k | 0); }
        document.documentElement.style.setProperty('--accent', `rgb(${r},${g},${b})`);
        document.documentElement.style.setProperty('--accent-rgb', `${r},${g},${b}`);
      };
      if (t.coverUrl) {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement('canvas'); c.width = c.height = 8; const x = c.getContext('2d'); x.drawImage(img, 0, 0, 8, 8);
          const d = x.getImageData(0, 0, 8, 8).data; let r = 0, g = 0, b = 0; for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
          const n = d.length / 4; apply(r / n | 0, g / n | 0, b / n | 0);
        };
        img.src = t.coverUrl;
      } else {
        const h = hue(t.album + t.artist) / 60, f = x => Math.round(255 * (0.55 + 0.45 * Math.cos((h + x) * 1.0472 * 1)));
        apply(f(0), f(4), f(2));
      }
    }
    function mediaSession(t) {
      if (!('mediaSession' in navigator)) return;
      navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: t.album, artwork: t.coverUrl ? [{ src: t.coverUrl, sizes: '512x512' }] : [] });
      navigator.mediaSession.setActionHandler('play', () => audio.play());
      navigator.mediaSession.setActionHandler('pause', () => audio.pause());
      navigator.mediaSession.setActionHandler('previoustrack', prev);
      navigator.mediaSession.setActionHandler('nexttrack', () => next(false));
    }

    /* ================= keyboard ================= */
    addEventListener('keydown', e => {
      const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) && document.activeElement.type !== 'range';
      if (e.key === '/' && !typing) { e.preventDefault(); $('#q').focus(); return; }
      if (e.key === 'Escape') { document.activeElement.blur(); return; }
      if (typing) return;
      if (e.code === 'Space') { e.preventDefault(); toggle(); }
      else if (e.key === 'ArrowRight') { e.shiftKey ? next(false) : audio.currentTime += 5; }
      else if (e.key === 'ArrowLeft') { e.shiftKey ? prev() : audio.currentTime -= 5; }
      else if (e.key === 'ArrowUp') { e.preventDefault(); vol.value = Math.min(100, +vol.value + 5); vol.oninput(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); vol.value = Math.max(0, +vol.value - 5); vol.oninput(); }
      else if (e.key.toLowerCase() === 'm') $('#mute').click();
      else if (e.key.toLowerCase() === 's') $('#shuffle').click();
      else if (e.key.toLowerCase() === 'r') $('#repeat').click();
      else if (e.key.toLowerCase() === 'l') toggleLike(curTrack);
    });

    /* ================= boot ================= */
    (async function boot() {
      render();
      if (!window.showDirectoryPicker) { $('#hint').textContent = 'Your browser will ask you to select a folder and upload nothing — it stays on your laptop. (Chrome/Edge can remember the folder.)'; return; }
      const h = await kvGet('dir');
      if (!h) return;
      dirHandle = h;
      try {
        if (await h.queryPermission({ mode: 'read' }) === 'granted') scanHandle(h);
        else render();
      } catch { render(); }
    })();
  