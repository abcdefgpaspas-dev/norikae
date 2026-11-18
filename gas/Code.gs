/**
 * マイ乗換（GAS側）
 *  - 阪急公式の駅時刻表を取得してアプリ用データを作る（ダイヤ改正も自動で追従）
 *  - 乗換アラーム：アプリの「この便で行く」→ 指定時刻にLINEへプッシュ
 *  - 遅延通知：通勤時間帯に阪急の運行情報を5分おきに確認 → 変化があればLINEへ
 *
 * 必要なスクリプトプロパティ（プロジェクトの設定 → スクリプト プロパティ）
 *   LINE_TOKEN   … みどりのかご（Messaging API）のチャネルアクセストークン
 *   LINE_USER_ID … 通知先（りょう）のユーザーID（Uで始まる33文字）
 *
 * 初回は setup() を実行 → 承認 → 「デプロイ → 新しいデプロイ → ウェブアプリ」
 */

// ===== 設定 ==========================================================
const CONFIG = {
  APP_URL: 'https://abcdefgpaspas-dev.github.io/norikae/',
  // 遅延チェックする時間帯（曜日 0=日〜6=土）。土日も見たいなら days に 0,6 を足す
  DELAY_WINDOWS: [
    { days: [1, 2, 3, 4, 5], from: '06:00', to: '09:30' },
    { days: [1, 2, 3, 4, 5], from: '17:00', to: '20:30' },
  ],
  WATCH_LINES: ['京都線'], // 阪急の運行情報は「京都線」に千里線も含まれる
  RAILINFO_URL: 'https://www.hankyu.co.jp/railinfo/include/page_railinfo.html',
  STATION_URL: 'https://www.hankyu.co.jp/station/html/',
  BATCH: 30,            // 一度に並列取得する件数
  TIME_LIMIT_MS: 270000 // 1回の実行で使う最大時間（GASは6分で強制終了）
};

const P = PropertiesService.getScriptProperties();

// ===== 初回セットアップ ================================================
function setup() {
  // 既存トリガーを掃除して作り直す
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('checkDelay').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('dailyRefresh').timeBased().everyDays(1).atHour(3).create();
  refreshTimetables(true);
}

/** LINE通知のテスト（スクリプトエディタから実行） */
function testLine() {
  pushLine('🚃 マイ乗換：LINE通知のテストです。届いていればOK！');
}

/** デプロイ後に実行：アプリ設定用リンクをLINEに送る */
function sendSetupLink() {
  const url = ScriptApp.getService().getUrl();
  if (!url) throw new Error('先にウェブアプリとしてデプロイしてください');
  pushLine('🚃 マイ乗換の設定リンク\n①このリンクをSafariで開く or ②アプリの設定画面に貼り付け\n' +
    CONFIG.APP_URL + '#setup=' + encodeURIComponent(url));
}

// ===== Web API（アプリから呼ばれる） ===================================
function doGet(e) {
  const p = (e && e.parameter) || {};
  let res;
  try {
    switch (p.action) {
      case 'data':   res = getData(); break;
      case 'status': res = getStatus(); break;
      case 'alarm':  res = addAlarm(p.id, JSON.parse(p.items || '[]')); break;
      case 'cancel': res = cancelAlarm(p.id); break;
      case 'alarms': res = { ok: true, alarms: loadQueue() }; break;
      case 'test':   pushLine('🚃 マイ乗換：アプリからのテスト通知です'); res = { ok: true }; break;
      case 'refresh': refreshTimetables(true); res = { ok: true, job: P.getProperty('JOB') || null }; break;
      default:       res = { ok: true, msg: 'マイ乗換 GAS 稼働中' };
    }
  } catch (err) {
    res = { ok: false, error: String(err) };
  }
  return ContentService.createTextOutput(JSON.stringify(res)).setMimeType(ContentService.MimeType.JSON);
}

// ===== 時刻表データ ====================================================
function getRoutesConfig() {
  const txt = UrlFetchApp.fetch(CONFIG.APP_URL + 'routes.json?t=' + Date.now()).getContentText();
  return JSON.parse(txt);
}

/** アプリへ返す全データ */
function getData() {
  const meta = JSON.parse(P.getProperty('META') || '{}');
  const legs = {}, pages = {};
  (meta.legs || []).forEach(k => legs[k] = loadBig('L:' + k));
  (meta.pages || []).forEach(k => pages[k] = loadBig('P:' + k));
  return { ok: true, updated: meta.updated || null, building: !!P.getProperty('JOB'), legs, pages };
}

/** 毎日3時：駅時刻表ページが変わっていたら（＝ダイヤ改正）作り直す */
function dailyRefresh() { refreshTimetables(false); }

/**
 * 時刻表の再構築。force=false のときはページ内容が変わった単位だけ作り直す。
 * 処理が長い場合は JOB に残りを保存し、1分後に continueRefresh で続きを実行。
 */
function refreshTimetables(force) {
  const cfg = getRoutesConfig();
  const units = [];
  const pageSet = {};
  cfg.routes.forEach(r => r.legs.forEach(l => { pageSet[l.page] = 1; }));
  cfg.timetables.forEach(t => t.pages.forEach(pg => { pageSet[pg.page] = 1; }));
  // 生の駅時刻表（時刻表画面用）
  Object.keys(pageSet).forEach(pg => ['w', 'h'].forEach(d => units.push({ kind: 'page', page: pg, day: d })));
  // ルート区間（到着時刻・停車駅つき）
  const seenLeg = {};
  cfg.routes.forEach(r => r.legs.forEach(l => {
    if (seenLeg[l.id]) return; seenLeg[l.id] = 1;
    ['w', 'h'].forEach(d => units.push({ kind: 'leg', leg: l, day: d }));
  }));
  P.setProperty('JOB', JSON.stringify({ force: !!force, units }));
  continueRefresh();
}

function continueRefresh() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    // 継続用の一時トリガーを掃除
    ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'continueRefresh')
      .forEach(t => ScriptApp.deleteTrigger(t));
    const job = JSON.parse(P.getProperty('JOB') || 'null');
    if (!job) return;
    const start = Date.now();
    const detailCache = {}; // 同じ列車の詳細ページを使い回す
    const meta = JSON.parse(P.getProperty('META') || '{}');
    meta.legs = meta.legs || []; meta.pages = meta.pages || [];

    while (job.units.length) {
      if (Date.now() - start > CONFIG.TIME_LIMIT_MS) break;
      const u = job.units[0];
      const html = fetchText(CONFIG.STATION_URL + u.page + '_' + u.day + '.html');
      const list = parseStationPage(html);
      const hashKey = 'H:' + (u.kind === 'leg' ? 'L:' + u.leg.id : 'P:' + u.page) + '_' + u.day;
      const hash = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, html.replace(/\s+/g, '').length + JSON.stringify(list)));
      if (!job.force && P.getProperty(hashKey) === hash) { job.units.shift(); continue; }

      if (u.kind === 'page') {
        const key = u.page + '_' + u.day;
        saveBig('P:' + key, list.map(t => [t.min, t.type, t.dest]));
        if (meta.pages.indexOf(key) < 0) meta.pages.push(key);
      } else {
        const key = u.leg.id + '_' + u.day;
        const trains = buildLeg(u.leg, list, detailCache, start);
        if (trains === null) break; // 時間切れ → 次回この単位からやり直し
        saveBig('L:' + key, trains);
        if (meta.legs.indexOf(key) < 0) meta.legs.push(key);
      }
      P.setProperty(hashKey, hash);
      job.units.shift();
    }
    meta.updated = new Date().toISOString();
    P.setProperty('META', JSON.stringify(meta));
    if (job.units.length) {
      P.setProperty('JOB', JSON.stringify(job));
      ScriptApp.newTrigger('continueRefresh').timeBased().after(60 * 1000).create();
    } else {
      P.deleteProperty('JOB');
    }
  } finally {
    lock.releaseLock();
  }
}

/** 駅時刻表ページ → [{min, type, dest, url}] */
function parseStationPage(html) {
  const re = /<a href="(\/station\/timetable\.php\?[^"]+)"[\s\S]*?timetable_train_type">［([^］]+)］<\/p><p class="timetable_station_name">([^<]+)<\/p>/g;
  const out = [];
  let m;
  while ((m = re.exec(html))) {
    const href = m[1].replace(/&amp;/g, '&');
    const tm = (href.match(/TM=(\d{3,4})/) || [])[1];
    if (!tm) continue;
    out.push({ min: hhmmToMin(tm), type: m[2], dest: m[3].trim(), url: href });
  }
  return out;
}

/** 区間データを作る：各列車の詳細ページから乗車駅の発時刻・降車駅の着時刻・途中停車駅を取る */
function buildLeg(leg, list, cache, start) {
  const targets = list.filter(t => !leg.types || leg.types.indexOf(t.type) >= 0);
  const need = targets.filter(t => !cache[trainKey(t.url)]);
  for (let i = 0; i < need.length; i += CONFIG.BATCH) {
    if (Date.now() - start > CONFIG.TIME_LIMIT_MS) return null;
    const chunk = need.slice(i, i + CONFIG.BATCH);
    const reqs = chunk.map(t => ({ url: 'https://www.hankyu.co.jp' + encodeHref(t.url), muteHttpExceptions: true }));
    const resps = UrlFetchApp.fetchAll(reqs);
    resps.forEach((r, j) => {
      if (r.getResponseCode() === 200) cache[trainKey(chunk[j].url)] = parseDetail(r.getContentText());
    });
  }
  const out = [];
  targets.forEach(t => {
    const rows = cache[trainKey(t.url)];
    if (!rows) return;
    const fi = rows.findIndex(r => r.name === leg.from);
    const ti = rows.findIndex((r, k) => k > fi && r.name === leg.to);
    if (fi < 0 || ti < 0) return; // 降車駅に停まらない列車は除外
    const dep = rows[fi].dep != null ? rows[fi].dep : t.min;
    const arr = rows[ti].arr != null ? rows[ti].arr : rows[ti].dep;
    // 途中駅は「駅名+出発からの分」で圧縮（例: 相川3）
    const stops = rows.slice(fi + 1, ti).map(r => r.name + ((r.arr != null ? r.arr : r.dep) - dep)).join(',');
    out.push([dep, arr, t.type, t.dest, stops]);
  });
  out.sort((a, b) => a[0] - b[0]);
  return out;
}

/** 列車詳細ページ → [{name, arr, dep}] */
function parseDetail(html) {
  const re = /<td>([^<]+)<\/td>\s*<td>([\s\S]*?)<\/td>/g;
  const rows = [];
  let m;
  while ((m = re.exec(html))) {
    const times = (m[2].match(/\d{1,2}:\d{2}/g) || []).map(hmToMin);
    if (!times.length) continue;
    const hasArr = m[2].indexOf('到着') >= 0;
    const hasDep = m[2].indexOf('出発') >= 0;
    rows.push({
      name: m[1].trim(),
      arr: hasArr ? times[0] : null,
      dep: hasDep ? times[times.length - 1] : null,
    });
  }
  return rows;
}

function trainKey(href) { return (href.match(/TX=([^&]+)/) || [])[1] + (href.match(/DW=(\d)/) || [])[1]; }
function encodeHref(href) {
  return href.replace(/stationName=([^&]+)/, (s, v) => 'stationName=' + encodeURIComponent(safeDecode(v)));
}
function safeDecode(v) { try { return decodeURIComponent(v); } catch (e) { return v; } }
function hhmmToMin(s) { s = ('0000' + s).slice(-4); return fixMidnight(+s.slice(0, 2) * 60 + +s.slice(2)); }
function hmToMin(s) { const a = s.split(':'); return fixMidnight(+a[0] * 60 + +a[1]); }
function fixMidnight(m) { return m < 180 ? m + 1440 : m; } // 0〜2時台は「24時〜」として扱う

// ===== プロパティに大きなJSONを分割保存（1値9KB制限対策） ==============
function saveBig(key, obj) {
  const s = JSON.stringify(obj);
  const size = 8000;
  const n = Math.ceil(s.length / size) || 1;
  const props = {};
  props[key + '#n'] = String(n);
  for (let i = 0; i < n; i++) props[key + '#' + i] = s.slice(i * size, (i + 1) * size);
  P.setProperties(props);
}
function loadBig(key) {
  const n = +(P.getProperty(key + '#n') || 0);
  if (!n) return null;
  let s = '';
  for (let i = 0; i < n; i++) s += P.getProperty(key + '#' + i) || '';
  return JSON.parse(s);
}

function fetchText(url) {
  const r = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) throw new Error('取得失敗 ' + r.getResponseCode() + ' ' + url);
  return r.getContentText();
}

// ===== 乗換アラーム ====================================================
function loadQueue() { return JSON.parse(P.getProperty('QUEUE') || '[]'); }
function saveQueue(q) { P.setProperty('QUEUE', JSON.stringify(q)); }

/** items: [{at: エポックms, text: '…'}] */
function addAlarm(id, items) {
  const now = Date.now();
  let q = loadQueue().filter(a => a.at > now - 10 * 60000);
  if (id) q = q.filter(a => a.id !== id);
  items.forEach(it => { if (it.at > now - 30000) q.push({ id: id || 'x', at: it.at, text: it.text }); });
  q.sort((a, b) => a.at - b.at);
  saveQueue(q);
  ensureQueueTrigger(q.length > 0);
  return { ok: true, count: q.length };
}
function cancelAlarm(id) {
  const q = loadQueue().filter(a => a.id !== id);
  saveQueue(q);
  ensureQueueTrigger(q.length > 0);
  return { ok: true, count: q.length };
}
function ensureQueueTrigger(on) {
  const ts = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'processQueue');
  if (on && !ts.length) ScriptApp.newTrigger('processQueue').timeBased().everyMinutes(1).create();
  if (!on) ts.forEach(t => ScriptApp.deleteTrigger(t));
}

/** 1分ごと：時刻が来たアラームをLINEへ送る（キューが空になればトリガー自体を削除） */
function processQueue() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    const now = Date.now();
    const q = loadQueue();
    const rest = [];
    q.forEach(a => {
      if (a.at <= now + 30000) {
        if (a.at > now - 10 * 60000) pushLine(a.text); // 10分以上古いものは捨てる
      } else rest.push(a);
    });
    saveQueue(rest);
    ensureQueueTrigger(rest.length > 0);
  } finally {
    lock.releaseLock();
  }
}

// ===== 遅延通知 ========================================================
function inWindow(d) {
  const day = d.getDay();
  const hm = Utilities.formatDate(d, 'Asia/Tokyo', 'HH:mm');
  return CONFIG.DELAY_WINDOWS.some(w => w.days.indexOf(day) >= 0 && hm >= w.from && hm <= w.to);
}

/** 阪急の運行情報を取得して解析 */
function fetchRailinfo() {
  const html = fetchText(CONFIG.RAILINFO_URL + '?t=' + Date.now());
  const lines = {};
  const re = /<span>([^<]+線)<\/span><\/h3>\s*<p[^>]*>([\s\S]*?)<\/p>/g;
  let m;
  while ((m = re.exec(html))) lines[m[1]] = strip(m[2]);
  const msgBlock = (html.match(/sec01_inner_cnt01">([\s\S]*?)<\/div>/) || [])[1] || '';
  const message = strip(msgBlock).slice(0, 400);
  return { lines, message };
}
function strip(s) { return s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim(); }

/** アプリ表示用（2分キャッシュ） */
function getStatus() {
  const c = CacheService.getScriptCache();
  const hit = c.get('STATUS');
  if (hit) return JSON.parse(hit);
  const info = fetchRailinfo();
  const res = { ok: true, checkedAt: new Date().toISOString(), lines: info.lines, message: info.message,
    normal: CONFIG.WATCH_LINES.every(l => !info.lines[l] || info.lines[l].indexOf('平常') >= 0) };
  c.put('STATUS', JSON.stringify(res), 120);
  return res;
}

/** 5分ごと（時間帯外は何もしない）：変化があったときだけLINE */
function checkDelay() {
  const now = new Date();
  if (!inWindow(now)) return;
  const info = fetchRailinfo();
  const bad = CONFIG.WATCH_LINES.filter(l => info.lines[l] && info.lines[l].indexOf('平常') < 0);
  const sig = bad.length ? bad.map(l => l + ':' + info.lines[l]).join('|') + '|' + info.message : 'NORMAL';
  const last = P.getProperty('DELAY_SIG') || 'NORMAL';
  if (sig === last) return; // 同じ内容は送らない
  P.setProperty('DELAY_SIG', sig);
  if (bad.length) {
    pushLine('⚠️ 阪急 運行情報\n' + bad.map(l => '【' + l + '（千里線含む）】' + info.lines[l]).join('\n') +
      '\n' + info.message + '\n\n迂回ルートはこちら👇\n' + CONFIG.APP_URL + '#detour\n公式: https://www.hankyu.co.jp/railinfo/');
  } else {
    pushLine('✅ 阪急 京都線・千里線は平常運転に戻りました');
  }
}

// ===== LINE ============================================================
function pushLine(text) {
  const token = P.getProperty('LINE_TOKEN');
  const to = P.getProperty('LINE_USER_ID');
  if (!token || !to) throw new Error('スクリプトプロパティ LINE_TOKEN / LINE_USER_ID が未設定です');
  const r = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ to, messages: [{ type: 'text', text: text.slice(0, 4900) }] }),
    muteHttpExceptions: true,
  });
  if (r.getResponseCode() !== 200) console.warn('LINE送信失敗', r.getResponseCode(), r.getContentText());
}
