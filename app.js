/* =====================================================================
 * マイ乗換（アプリ本体）
 *  データの流れ：
 *    routes.json（このリポジトリ）… ルート・駅・迂回の設定
 *    GAS（設定画面でURL登録）    … 阪急公式から作った時刻表データ / 運行情報 / LINEアラーム
 *  画面：#home #route/ID #tt #detour #stations #settings（URLの # で切替）
 * ===================================================================== */

// ---------- 保存まわり（localStorage） ----------
const LS = {
  get(k, d) { try { const v = localStorage.getItem('norikae.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('norikae.' + k, JSON.stringify(v)); } catch (e) {} },
};

const DEFAULT_SETTINGS = {
  gasUrl: '',
  transferMin: null,          // null なら routes.json の値
  dayOverride: 'auto',        // auto / w（平日）/ h（土休日）
  alarm: { dep: 5, xferArr: 2, xferDep: 2, arr: 0 }, // 何分前にLINEするか（0=送らない）
  commuteSide: 'go',
};

let CFG = null;                          // routes.json
let DATA = LS.get('data', null);         // GASから取得した時刻表
let STATUS = LS.get('status', null);     // 運行情報
let SET = Object.assign({}, DEFAULT_SETTINGS, LS.get('settings', {}));
SET.alarm = Object.assign({}, DEFAULT_SETTINGS.alarm, SET.alarm || {});
let HOLIDAYS = LS.get('holidays', { at: 0, days: {} });
const itinCache = {};                    // ルート×曜日ごとの経路一覧キャッシュ
const ui = { route: {}, tt: {} };        // 画面ごとの一時状態

// ---------- 小物 ----------
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const fmt = m => { m = ((Math.floor(m) % 1440) + 1440) % 1440; return Math.floor(m / 60) + ':' + pad(m % 60); };
function toast(msg, ms) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), ms || 2500);
}
function saveSettings() { LS.set('settings', SET); }
function transferMin() { return SET.transferMin != null && SET.transferMin !== '' ? +SET.transferMin : (CFG.transferMin || 2); }

// ---------- 日付・ダイヤ種別 ----------
/** 「運行日」：深夜0〜2時台は前日のダイヤ扱い。min は運行日0時からの分（24時超あり） */
function serviceNow() {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let min = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  if (now.getHours() < 3) { d.setDate(d.getDate() - 1); min += 1440; }
  return { date: d, min };
}
function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
/** 平日 w / 土休日 h（祝日・年末年始12/30〜1/3も土休日扱い） */
function dayType(d) {
  if (SET.dayOverride === 'w' || SET.dayOverride === 'h') return SET.dayOverride;
  const md = (d.getMonth() + 1) * 100 + d.getDate();
  if (d.getDay() === 0 || d.getDay() === 6) return 'h';
  if (HOLIDAYS.days[ymd(d)]) return 'h';
  if (md >= 1230 || md <= 103) return 'h';
  return 'w';
}
const dayLabel = t => (t === 'h' ? '土休日' : '平日');
/** 運行日＋分 → 実際の時刻 */
function toDate(serviceDate, min) { return new Date(serviceDate.getTime() + min * 60000); }

async function loadHolidays() {
  if (Date.now() - HOLIDAYS.at < 20 * 86400000) return;
  try {
    const j = await fetch('https://holidays-jp.github.io/api/v1/date.json').then(r => r.json());
    HOLIDAYS = { at: Date.now(), days: j }; LS.set('holidays', HOLIDAYS);
  } catch (e) { /* オフライン時は土日判定のみ */ }
}

// ---------- GAS通信 ----------
async function gas(params) {
  if (!SET.gasUrl) throw new Error('設定でGASのURLを登録してください');
  const url = SET.gasUrl + (SET.gasUrl.includes('?') ? '&' : '?') + new URLSearchParams(params).toString();
  const r = await fetch(url, { redirect: 'follow' });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'GASエラー');
  return j;
}
async function refreshData(force) {
  if (!SET.gasUrl) return;
  if (!force && DATA && Date.now() - (DATA.fetchedAt || 0) < 6 * 3600000) return;
  try {
    const j = await gas({ action: 'data' });
    j.fetchedAt = Date.now();
    DATA = j; LS.set('data', DATA);
    Object.keys(itinCache).forEach(k => delete itinCache[k]);
    render();
    if (force) toast(j.building ? '取得しました（GAS側でまだ作成中のデータあり）' : '時刻表を更新しました');
  } catch (e) { if (force) toast('取得失敗：' + e.message); }
}
async function refreshStatus() {
  if (!SET.gasUrl) return;
  try {
    STATUS = await gas({ action: 'status' }); LS.set('status', STATUS); renderStatus();
  } catch (e) { /* 何もしない */ }
}

// ---------- 経路計算 ----------
function legTrains(legId, day) {
  const raw = DATA && DATA.legs && DATA.legs[legId + '_' + day];
  return (raw || []).map(a => ({ dep: a[0], arr: a[1], type: a[2], dest: a[3], stops: a[4] }));
}
/** その日の全経路（乗換は最短接続、同じ到着なら遅く出る方を残す） */
function itineraries(route, day) {
  const key = route.id + '_' + day + '_' + transferMin();
  if (itinCache[key]) return itinCache[key];
  const legs = route.legs.map(l => legTrains(l.id, day));
  const tm = transferMin();
  const byArr = {};
  (legs[0] || []).forEach(t0 => {
    const trains = [t0];
    for (let i = 1; i < legs.length; i++) {
      const prev = trains[i - 1];
      const nx = legs[i].find(t => t.dep >= prev.arr + tm);
      if (!nx) return;
      trains.push(nx);
    }
    const it = { trains, dep: t0.dep, arr: trains[trains.length - 1].arr };
    const cur = byArr[it.arr];
    if (!cur || cur.dep < it.dep) byArr[it.arr] = it;
  });
  const list = Object.values(byArr).sort((a, b) => a.dep - b.dep);
  itinCache[key] = list;
  return list;
}
/** 今（または指定時刻）以降の最初の経路の位置 */
function firstIndexFrom(list, min) { const i = list.findIndex(it => it.dep >= min); return i < 0 ? list.length : i; }
function lastIndexArriveBy(list, min) { let i = -1; list.forEach((it, k) => { if (it.arr <= min) i = k; }); return i; }

// ---------- 表示部品 ----------
function cdText(ms) {
  const s = Math.round((ms - Date.now()) / 1000);
  if (s < -30) return '発車済';
  if (s < 60) return 'まもなく発車';
  const m = Math.floor(s / 60), r = s % 60;
  return m >= 60 ? 'あと' + Math.floor(m / 60) + '時間' + (m % 60) + '分' : 'あと' + m + '分' + pad(r) + '秒';
}
/** data-cd="エポックms" を持つ要素を1秒ごとに更新 */
function tick() {
  document.querySelectorAll('[data-cd]').forEach(el => {
    const ms = +el.dataset.cd;
    el.textContent = cdText(ms);
    el.classList.toggle('go', ms - Date.now() < 3 * 60000);
  });
}
function typeTag(t) { return '<span class="tag t-' + esc(t) + '">' + esc(t) + '</span>'; }

/** 1つの経路カード */
function itinCard(route, it, serviceDate, opts) {
  opts = opts || {};
  const waits = [];
  for (let i = 1; i < it.trains.length; i++) waits.push(it.trains[i].dep - it.trains[i - 1].arr);
  const depMs = toDate(serviceDate, it.dep).getTime();
  const past = depMs < Date.now() - 30000;
  const alarm = LS.get('alarm', null);
  const alarmOn = alarm && alarm.routeId === route.id && alarm.dep === it.dep && alarm.date === ymd(serviceDate);
  const key = it.dep + '-' + it.arr;
  const open = ui.route.open === key || opts.open;
  let h = '<div class="res' + (past ? ' past' : '') + '">' +
    '<div class="row" data-act="toggle" data-key="' + key + '"><div class="sp"><div class="tm">' + fmt(it.dep) + ' → ' + fmt(it.arr) + '</div>' +
    '<div class="meta">' + (it.arr - it.dep) + '分 ・ 乗換' + (it.trains.length - 1) + '回' +
    (waits.length ? '（待ち' + waits.join('/') + '分）' : '') + (route.fareIC ? ' ・ IC ' + route.fareIC + '円' : '') + '</div>' +
    '<div class="meta">' + it.trains.map(t => typeTag(t.type) + esc(t.dest) + '行').join(' → ') + '</div></div>' +
    '<div style="text-align:right"><div class="cd" data-cd="' + depMs + '">' + cdText(depMs) + '</div>' +
    (alarmOn ? '<div class="small" style="color:var(--green)">🔔アラーム中</div>' : '') + '<div class="sub">' + (open ? '▲' : '▼') + '</div></div></div>';
  if (open) h += itinDetail(route, it) + '<div class="btns" style="margin-top:8px">' +
    (alarmOn ? '<button class="btn" data-act="cancelAlarm">🔕 アラーム解除</button>'
      : '<button class="btn pri" data-act="go" data-dep="' + it.dep + '">🔔 この便で行く（LINE）</button>') + '</div>';
  return h + '</div>';
}
/** 停車駅・各駅の到着時刻 */
function itinDetail(route, it) {
  let h = '<div class="detail">';
  it.trains.forEach((t, i) => {
    const leg = route.legs[i];
    if (i > 0) h += '<div class="xfer">🔁 ' + esc(leg.from) + 'で乗換（待ち' + (t.dep - it.trains[i - 1].arr) + '分）</div>';
    h += '<div class="st main"><span class="t">' + fmt(t.dep) + '発</span>' + esc(leg.from) + '</div>';
    h += '<div class="leg"><div class="small">' + esc(leg.line) + ' ' + typeTag(t.type) + esc(t.dest) + '行</div>';
    (t.stops ? t.stops.split(',') : []).forEach(s => {
      const m = s.match(/^(.*?)(-?\d+)$/);
      if (m) h += '<div class="st"><span class="t">' + fmt(t.dep + +m[2]) + '</span>' + esc(m[1]) + '</div>';
    });
    h += '</div><div class="st main"><span class="t">' + fmt(t.arr) + '着</span>' + esc(leg.to) + '</div>';
  });
  return h + '</div>';
}

// ---------- 画面：ホーム ----------
function viewHome() {
  const sn = serviceNow(), day = dayType(sn.date);
  let h = '';
  if (!SET.gasUrl) h += '<div class="card"><b>はじめに</b><p class="sub">設定 → GASのURLを登録すると時刻表とLINE通知が使えます。</p><a class="btn grn block" href="#settings">設定を開く</a></div>';
  else if (!DATA || !DATA.legs || !Object.keys(DATA.legs).length) h += '<div class="card">時刻表データを準備中です（初回はGASが数分かけて阪急公式から取得します）。<button class="btn block" data-act="reload">再取得</button></div>';

  // 出勤モード（ワンタップで次の便）
  const side = SET.commuteSide === 'back' ? 'back' : 'go';
  const cr = CFG.routes.find(r => r.id === CFG.commute[side]);
  if (cr) {
    const list = itineraries(cr, day);
    const i = firstIndexFrom(list, sn.min);
    const it = list[i];
    h += '<div class="card commute"><div class="seg"><button data-act="side" data-side="go" class="' + (side === 'go' ? 'on' : '') + '">🚒 出勤</button>' +
      '<button data-act="side" data-side="back" class="' + (side === 'back' ? 'on' : '') + '">🏠 帰宅</button></div>' +
      '<h2>' + esc(cr.name) + '</h2>';
    if (it) {
      const depMs = toDate(sn.date, it.dep).getTime();
      h += '<div class="row"><div class="big">' + fmt(it.dep) + '</div><div class="sp" style="padding-left:8px">→ ' + fmt(it.arr) + '着<br>' +
        it.trains.map(t => esc(t.type) + ' ' + esc(t.dest) + '行').join('/') + '</div></div>' +
        '<div class="cd" data-cd="' + depMs + '">' + cdText(depMs) + '</div>' +
        '<div class="next">次：' + list.slice(i + 1, i + 3).map(x => fmt(x.dep) + '→' + fmt(x.arr)).join('　') + '</div>' +
        '<div class="btns" style="margin-top:10px"><button class="btn" data-act="goNow" data-route="' + cr.id + '" data-dep="' + it.dep + '">🔔 この便で行く</button>' +
        '<a class="btn" href="#route/' + cr.id + '">詳しく</a></div>';
    } else h += '<div>本日の運転は終了しました</div>';
    h += '</div>';
  }

  // 保存ルート（★を先頭に）
  const favs = LS.get('favs', []);
  const routes = CFG.routes.slice().sort((a, b) => (favs.includes(b.id) ? 1 : 0) - (favs.includes(a.id) ? 1 : 0));
  h += '<div class="card"><h2>保存ルート</h2>';
  routes.forEach(r => {
    const list = itineraries(r, day);
    const it = list[firstIndexFrom(list, sn.min)];
    h += '<a class="route" href="#route/' + r.id + '"><button class="star" data-act="fav" data-id="' + r.id + '">' + (favs.includes(r.id) ? '★' : '☆') + '</button>' +
      '<div class="sp"><div class="nm">' + esc(r.name) + '</div><div class="nx">' + (it ? '次 ' + fmt(it.dep) + '発 → ' + fmt(it.arr) + '着（' + (it.arr - it.dep) + '分）' : '本日終了') + '</div></div><span class="sub">›</span></a>';
  });
  h += '</div><p class="sub small">ダイヤ：' + dayLabel(day) + (SET.dayOverride !== 'auto' ? '（手動）' : '（自動）') +
    (DATA && DATA.updated ? ' ／ 時刻表更新 ' + new Date(DATA.updated).toLocaleDateString('ja-JP') : '') + '</p>';
  return h;
}

// ---------- 画面：ルート詳細（検索結果） ----------
function viewRoute(id) {
  const route = CFG.routes.find(r => r.id === id);
  if (!route) return '<div class="card">ルートが見つかりません</div>';
  const st = ui.route.id === id ? ui.route : (ui.route = { id, mode: 'now', time: '', start: null, open: null });
  const sn = serviceNow();
  const day = dayType(sn.date);
  const list = itineraries(route, day);
  let base;
  if (st.mode === 'now' || !st.time) base = sn.min;
  else { const [hh, mm] = st.time.split(':').map(Number); base = hh * 60 + mm; if (base < 180) base += 1440; }
  if (st.start == null) {
    st.start = st.mode === 'arr' ? Math.max(0, lastIndexArriveBy(list, base) - 4) : firstIndexFrom(list, base);
  }
  st.start = Math.max(0, Math.min(st.start, Math.max(0, list.length - 1)));
  let h = '<div class="mode">' + [['now', '今から'], ['dep', '出発時刻'], ['arr', '到着時刻']].map(([k, l]) =>
    '<button data-act="mode" data-mode="' + k + '" class="' + (st.mode === k ? 'on' : '') + '">' + l + '</button>').join('') + '</div>';
  if (st.mode !== 'now') h += '<div class="row" style="margin-bottom:8px"><input type="time" id="timeIn" value="' + esc(st.time || fmt(sn.min).padStart(5, '0')) + '"><button class="btn grn" data-act="search">検索</button></div>';
  h += '<div class="btns" style="margin-bottom:10px"><button class="btn" data-act="shift" data-d="-1">◀ 1本前</button><button class="btn" data-act="mode" data-mode="now">いま発</button><button class="btn" data-act="shift" data-d="1">1本後 ▶</button></div>';
  const show = list.slice(st.start, st.start + 5);
  if (!show.length) h += '<div class="card">該当する便がありません</div>';
  show.forEach(it => { h += itinCard(route, it, sn.date); });
  if (list.length) h += '<div class="card"><h2>始発・終電（' + dayLabel(day) + '）</h2>始発 ' + fmt(list[0].dep) + ' → ' + fmt(list[0].arr) +
    '<br>終電 ' + fmt(list[list.length - 1].dep) + ' → ' + fmt(list[list.length - 1].arr) + '</div>';
  const memo = LS.get('memo:' + id, '');
  h += '<div class="card"><h2>ルートメモ</h2><textarea id="routeMemo" placeholder="例：前から3両目が淡路の階段に近い">' + esc(memo) + '</textarea>' +
    '<button class="btn block" data-act="saveMemo" data-id="' + id + '">メモを保存</button></div>';
  h += '<div class="btns"><a class="btn" href="#detour">⚠️ 迂回ルート</a><a class="btn" href="#stations">🗺️ 構内図</a></div>';
  return h;
}

// ---------- 画面：駅時刻表 ----------
function viewTT() {
  const sn = serviceNow();
  const st = ui.tt;
  const station = CFG.timetables.find(t => t.station === st.station) || CFG.timetables[0];
  const pg = station.pages.find(p => p.page === st.page) || station.pages[0];
  const day = st.day || dayType(sn.date);
  let h = '<div class="mode">' + CFG.timetables.map(t => '<button data-act="ttStation" data-v="' + esc(t.station) + '" class="' + (t === station ? 'on' : '') + '">' + esc(t.station) + '</button>').join('') + '</div>';
  h += '<select id="ttDir" style="width:100%;margin-bottom:8px">' + station.pages.map(p => '<option value="' + p.page + '"' + (p === pg ? ' selected' : '') + '>' + esc(p.dir) + '</option>').join('') + '</select>';
  h += '<div class="mode">' + ['w', 'h'].map(d => '<button data-act="ttDay" data-v="' + d + '" class="' + (day === d ? 'on' : '') + '">' + dayLabel(d) + (d === dayType(sn.date) ? '（今日）' : '') + '</button>').join('') + '</div>';
  const rows = (DATA && DATA.pages && DATA.pages[pg.page + '_' + day]) || [];
  if (!rows.length) return h + '<div class="card">データがありません（設定 → 時刻表を再取得）</div>';
  const isToday = day === dayType(sn.date);
  const nextMin = isToday ? (rows.find(r => r[0] >= sn.min) || [])[0] : null;
  const byHour = {};
  rows.forEach(r => { const hh = Math.floor(r[0] / 60); (byHour[hh] = byHour[hh] || []).push(r); });
  h += '<div class="card" style="padding:4px 8px"><table class="tt">';
  Object.keys(byHour).map(Number).sort((a, b) => a - b).forEach(hh => {
    h += '<tr' + (isToday && hh === Math.floor(sn.min / 60) ? ' id="nowHour"' : '') + '><td class="h">' + (hh % 24) + '</td><td>' +
      byHour[hh].map(r => '<span class="m t-' + esc(r[1]) + (r[0] === nextMin ? ' nx' : '') + '">' + pad(r[0] % 60) +
        '<small>' + esc(r[1].slice(0, 2)) + '・' + esc(r[2].replace('京都河原町', '河原町').replace('大阪梅田', '梅田').slice(0, 3)) + '</small></span>').join('') + '</td></tr>';
  });
  return h + '</table></div><p class="sub small">出典：阪急電鉄 駅時刻表（臨時ダイヤには非対応）</p>';
}

// ---------- 画面：迂回ルート ----------
function viewDetour() {
  let h = '<div class="card"><h2>阪急の運行情報</h2>';
  if (STATUS) {
    h += Object.entries(STATUS.lines || {}).map(([k, v]) => '<div>' + esc(k) + '：<b style="color:' + (v.includes('平常') ? 'var(--green)' : 'var(--red)') + '">' + esc(v) + '</b></div>').join('') +
      '<p class="sub">' + esc(STATUS.message || '') + '</p><p class="sub small">確認 ' + new Date(STATUS.checkedAt).toLocaleTimeString('ja-JP') + '（20分以上の遅れのみ公表）</p>';
  } else h += '<p class="sub">未取得</p>';
  h += '<a class="btn block" href="' + esc(CFG.links.railinfo) + '" target="_blank">阪急 公式運行情報・振替輸送</a><button class="btn block" data-act="status">運行情報を更新</button></div>';
  Object.values(CFG.detours).forEach(d => {
    h += '<div class="card"><h2>' + esc(d.title) + '</h2>';
    d.options.forEach(o => {
      h += '<div style="margin:10px 0"><b>' + esc(o.name) + '</b> <span class="sub">' + esc(o.time) + (o.fare ? ' ・ ' + esc(o.fare) : '') + '</span>' +
        '<ol class="links">' + o.steps.map(s => '<li>' + esc(s) + '</li>').join('') + '</ol>' +
        '<ul class="links">' + o.links.map(l => '<li><a href="' + esc(l.url) + '" target="_blank">' + esc(l.label) + '</a></li>').join('') + '</ul></div>';
    });
    h += '</div>';
  });
  return h + '<p class="sub small">JR運賃・所要時間は目安です。実際の便はリンク先で確認してください。</p>';
}

// ---------- 画面：駅（構内図・号車／出口メモ） ----------
function viewStations() {
  let h = '';
  CFG.stations.forEach((s, i) => {
    const memo = LS.get('smemo:' + s.name, null);
    h += '<div class="card"><div class="row"><b class="sp">' + esc(s.name) + '</b><span class="sub small">' + esc(s.company) + '</span></div>' +
      '<div class="btns" style="margin-top:8px"><a class="btn" href="' + esc(s.page) + '" target="_blank">駅情報</a>' +
      (s.map ? '<a class="btn" href="' + esc(s.map) + '" target="_blank">構内図</a>' : '') + '</div>' +
      (s.map && s.map.endsWith('.svg') ? '<details class="map" style="margin-top:8px"><summary class="sub">構内図をここで見る</summary><img loading="lazy" src="' + esc(s.map) + '" alt="' + esc(s.name) + '構内図"></details>' : '') +
      '<label class="f">号車・出口メモ</label><textarea id="sm' + i + '">' + esc(memo != null ? memo : s.memo) + '</textarea>' +
      '<button class="btn block" data-act="saveSMemo" data-i="' + i + '">保存</button></div>';
  });
  return h;
}

// ---------- 画面：設定 ----------
function viewSettings() {
  const a = SET.alarm;
  const num = (id, v, lbl) => '<label class="f">' + lbl + '</label><input id="' + id + '" type="number" inputmode="numeric" min="0" max="30" value="' + esc(v) + '" style="width:100px"> 分';
  let h = '<div class="card"><h2>GAS（時刻表・LINE通知）</h2><label class="f">ウェブアプリURL（…/exec）</label>' +
    '<input id="gasUrl" style="width:100%" placeholder="https://script.google.com/macros/s/…/exec" value="' + esc(SET.gasUrl) + '">' +
    '<p class="sub small">LINEに届いた「設定リンク」の文字列をそのまま貼ってもOK</p></div>';
  h += '<div class="card"><h2>乗換アラーム（LINE）</h2>' +
    num('aDep', a.dep, '乗車駅の発車 何分前') + num('aXA', a.xferArr, '乗換駅の到着 何分前') +
    num('aXD', a.xferDep, '乗換列車の発車 何分前') + num('aArr', a.arr, '目的地の到着 何分前') +
    '<p class="sub small">0で送らない。LINE無料枠は月200通（みどりのかごと共通）</p></div>';
  h += '<div class="card"><h2>経路・ダイヤ</h2>' + num('tMin', transferMin(), '最低乗換時間') +
    '<label class="f">ダイヤ</label><select id="dayOv"><option value="auto">自動（祝日・年末年始対応）</option><option value="w">平日で固定</option><option value="h">土休日で固定</option></select></div>';
  h += '<button class="btn grn block" data-act="saveSettings">保存</button>' +
    '<div class="btns" style="margin-top:8px"><button class="btn" data-act="testLine">LINEテスト</button><button class="btn" data-act="reload">時刻表を再取得</button></div>' +
    '<button class="btn block" data-act="rebuild">GAS側で時刻表を作り直す（ダイヤ改正時）</button>' +
    '<p class="sub small">時刻表更新：' + (DATA && DATA.updated ? new Date(DATA.updated).toLocaleString('ja-JP') : '未取得') + '</p>';
  setTimeout(() => { const s = $('#dayOv'); if (s) s.value = SET.dayOverride; });
  return h;
}

// ---------- 乗換アラーム ----------
function buildAlarmItems(route, it, serviceDate) {
  const a = SET.alarm, items = [];
  const at = m => toDate(serviceDate, m).getTime();
  const t0 = it.trains[0], L0 = route.legs[0];
  if (a.dep > 0) items.push({ at: at(t0.dep - a.dep), text: '🚃 ' + L0.from + ' ' + fmt(t0.dep) + '発 ' + t0.dest + '行（' + t0.type + '）まで あと' + a.dep + '分' });
  for (let i = 1; i < it.trains.length; i++) {
    const p = it.trains[i - 1], c = it.trains[i], L = route.legs[i];
    if (a.xferArr > 0) items.push({ at: at(p.arr - a.xferArr), text: '🔁 まもなく' + L.from + '（' + fmt(p.arr) + '着）\n' + fmt(c.dep) + '発 ' + c.dest + '行（' + c.type + '）に乗換・待ち' + (c.dep - p.arr) + '分' });
    if (a.xferDep > 0) items.push({ at: at(c.dep - a.xferDep), text: '⏰ ' + L.from + ' ' + fmt(c.dep) + '発 ' + c.dest + '行 まもなく発車' });
  }
  const last = it.trains[it.trains.length - 1];
  if (a.arr > 0) items.push({ at: at(last.arr - a.arr), text: '🏁 まもなく' + route.legs[route.legs.length - 1].to + '（' + fmt(last.arr) + '着）' });
  return items.filter(x => x.at > Date.now() - 20000);
}
async function setAlarm(routeId, dep) {
  const route = CFG.routes.find(r => r.id === routeId);
  const sn = serviceNow();
  const it = itineraries(route, dayType(sn.date)).find(x => x.dep === dep);
  if (!it) return;
  const items = buildAlarmItems(route, it, sn.date);
  if (!items.length) { toast('通知できる時刻を過ぎています'); return; }
  try {
    await gas({ action: 'alarm', id: 'trip', items: JSON.stringify(items) });
    LS.set('alarm', { routeId, dep, date: ymd(sn.date) });
    toast('🔔 LINEアラームを' + items.length + '件セットしました（±1分）', 3500);
    render();
  } catch (e) { toast('失敗：' + e.message, 4000); }
}
async function cancelAlarm() {
  try { await gas({ action: 'cancel', id: 'trip' }); } catch (e) {}
  LS.set('alarm', null); toast('アラームを解除しました'); render();
}

// ---------- 運行情報バナー ----------
function renderStatus() {
  const b = $('#statusBar');
  if (!STATUS) { b.classList.add('hidden'); return; }
  b.classList.remove('hidden');
  const bad = !STATUS.normal;
  b.classList.toggle('bad', bad);
  b.textContent = bad
    ? '⚠️ 阪急 ' + Object.entries(STATUS.lines || {}).filter(([, v]) => !v.includes('平常')).map(([k, v]) => k + ' ' + v).join('・') + ' → 迂回ルート'
    : '✅ 阪急 京都線・千里線 平常運転（' + new Date(STATUS.checkedAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }) + '確認）';
}

// ---------- 画面切替 ----------
function render() {
  if (!CFG) return;
  const hash = location.hash.slice(1) || 'home';
  const [page, arg] = hash.split('/');
  const sn = serviceNow(), day = dayType(sn.date);
  const badge = $('#dayBadge'); badge.textContent = dayLabel(day); badge.className = 'badge' + (day === 'h' ? ' h' : '');
  let html = '', title = 'マイ乗換';
  if (page === 'route') { html = viewRoute(decodeURIComponent(arg || '')); const r = CFG.routes.find(x => x.id === arg); title = r ? r.name : title; }
  else if (page === 'tt') { html = viewTT(); title = '駅時刻表'; }
  else if (page === 'detour') { html = viewDetour(); title = '迂回ルート'; }
  else if (page === 'stations') { html = viewStations(); title = '駅・構内図'; }
  else if (page === 'settings') { html = viewSettings(); title = '設定'; }
  else html = viewHome();
  $('#view').innerHTML = html;
  $('#title').textContent = title;
  $('#backBtn').classList.toggle('hidden', page !== 'route');
  document.querySelectorAll('.tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === (page === 'route' ? 'home' : page)));
  renderStatus();
  if (page === 'tt' && !ui.tt.scrolled) { const n = $('#nowHour'); if (n) n.scrollIntoView({ block: 'center' }); ui.tt.scrolled = true; }
}

// ---------- 操作（クリックをまとめて処理） ----------
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  if (el.tagName === 'BUTTON' || act === 'toggle') e.preventDefault();
  if (act === 'fav') { e.preventDefault(); e.stopPropagation(); const f = LS.get('favs', []); const i = f.indexOf(el.dataset.id); i < 0 ? f.push(el.dataset.id) : f.splice(i, 1); LS.set('favs', f); render(); }
  else if (act === 'side') { SET.commuteSide = el.dataset.side; saveSettings(); render(); }
  else if (act === 'goNow') setAlarm(el.dataset.route, +el.dataset.dep);
  else if (act === 'go') setAlarm(ui.route.id, +el.dataset.dep);
  else if (act === 'cancelAlarm') cancelAlarm();
  else if (act === 'toggle') { ui.route.open = ui.route.open === el.dataset.key ? null : el.dataset.key; render(); }
  else if (act === 'mode') { ui.route.mode = el.dataset.mode; ui.route.start = null; if (el.dataset.mode === 'now') ui.route.time = ''; render(); }
  else if (act === 'search') { ui.route.time = $('#timeIn').value; ui.route.start = null; render(); }
  else if (act === 'shift') { ui.route.start = (ui.route.start || 0) + +el.dataset.d; render(); }
  else if (act === 'saveMemo') { LS.set('memo:' + el.dataset.id, $('#routeMemo').value); toast('保存しました'); }
  else if (act === 'saveSMemo') { const s = CFG.stations[+el.dataset.i]; LS.set('smemo:' + s.name, $('#sm' + el.dataset.i).value); toast('保存しました'); }
  else if (act === 'ttStation') { ui.tt.station = el.dataset.v; ui.tt.page = null; ui.tt.scrolled = false; render(); }
  else if (act === 'ttDay') { ui.tt.day = el.dataset.v; render(); }
  else if (act === 'status') { await refreshStatus(); render(); toast('更新しました'); }
  else if (act === 'reload') { await refreshData(true); }
  else if (act === 'rebuild') { try { await gas({ action: 'refresh' }); toast('GASで作成を開始しました。数分後に「時刻表を再取得」してください', 5000); } catch (err) { toast('失敗：' + err.message); } }
  else if (act === 'testLine') { try { await gas({ action: 'test' }); toast('送信しました。LINEを確認してください'); } catch (err) { toast('失敗：' + err.message, 4000); } }
  else if (act === 'saveSettings') {
    SET.gasUrl = parseGasUrl($('#gasUrl').value);
    SET.alarm = { dep: +$('#aDep').value || 0, xferArr: +$('#aXA').value || 0, xferDep: +$('#aXD').value || 0, arr: +$('#aArr').value || 0 };
    SET.transferMin = +$('#tMin').value || 0;
    SET.dayOverride = $('#dayOv').value;
    saveSettings(); Object.keys(itinCache).forEach(k => delete itinCache[k]);
    toast('保存しました'); refreshData(true); refreshStatus();
  }
});
document.addEventListener('change', e => { if (e.target.id === 'ttDir') { ui.tt.page = e.target.value; render(); } });
$('#backBtn').addEventListener('click', () => { if (history.length > 1) history.back(); else location.hash = '#home'; });
window.addEventListener('hashchange', () => { if (!location.hash.startsWith('#setup=')) { window.scrollTo(0, 0); render(); } });

/** 設定リンク（…#setup=URL）や貼り付け文字列から GAS URL を取り出す */
function parseGasUrl(s) {
  s = (s || '').trim();
  const m = s.match(/#setup=([^\s]+)/);
  if (m) s = decodeURIComponent(m[1]);
  const u = s.match(/https:\/\/script\.google(?:usercontent)?\.com\/[^\s]+/);
  return u ? u[0] : s;
}

/** 入力欄を編集中か（自動再描画で入力が消えないように） */
function isEditing() { const a = document.activeElement; return a && /INPUT|TEXTAREA|SELECT/.test(a.tagName); }

// ---------- 起動 ----------
(async function start() {
  // 設定リンクから開かれたら GAS URL を保存
  if (location.hash.startsWith('#setup=')) {
    SET.gasUrl = parseGasUrl(location.hash); saveSettings();
    history.replaceState(null, '', location.pathname + '#home');
    setTimeout(() => toast('GASを登録しました'), 300);
  }
  CFG = await fetch('routes.json', { cache: 'no-cache' }).then(r => r.json()).catch(() => LS.get('cfg', null));
  if (CFG) LS.set('cfg', CFG);
  render();
  loadHolidays().then(render);
  refreshData(false);
  refreshStatus();
  setInterval(tick, 1000);
  setInterval(() => { if (!document.hidden && !isEditing()) render(); }, 60000); // 1分ごとに一覧を更新（入力中は除く）
  setInterval(() => { if (!document.hidden) refreshStatus(); }, 180000);   // 3分ごとに運行情報
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { render(); refreshStatus(); } });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
