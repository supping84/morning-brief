// 핸드폰용 페이지 빌드: out/macro-<날짜>.json + out/summary-<날짜>.txt + out/screener/<날짜>/{candidates.json,report.md}
//   → out/app/index.html (자체 완결 HTML, 예약 작업이 Artifact 로 게시)
// 실행: node src/app/build.mjs [YYYY-MM-DD]   (날짜 생략 시 오늘, 없으면 가장 최근 파일)
import 'dotenv/config';
import path from 'node:path';
import { readFile, readdir, writeFile, mkdir, access } from 'node:fs/promises';
import { kstDate, fmtNum } from '../common/util.mjs';

const OUT = path.resolve(process.env.OUT_DIR || 'out');
const exists = (p) => access(p).then(() => true, () => false);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 오늘 파일이 없으면 가장 최근 날짜 */
async function latestDate(prefix, dir = OUT) {
  const today = kstDate();
  if (await exists(path.join(dir, `${prefix}${today}.json`)) || await exists(path.join(dir, prefix, today))) return today;
  const names = await readdir(dir).catch(() => []);
  const dates = names.map((n) => n.match(/(\d{4}-\d{2}-\d{2})/)?.[1]).filter(Boolean).sort();
  return dates.at(-1) ?? today;
}

// ── 포맷 ──
const won = (v) => v == null ? '-' : v >= 1e12 ? `${(v / 1e12).toFixed(2)}조` : `${Math.round(v / 1e8).toLocaleString()}억`;
const pct = (v, d = 1) => v == null ? '-' : `${(v * 100).toFixed(d)}%`;
function chg(v) {
  if (v == null || Number.isNaN(v)) return '<span class="chg flat">–</span>';
  const n = Number(v);
  const cls = n > 0 ? 'up' : n < 0 ? 'down' : 'flat';
  const arrow = n > 0 ? '▲' : n < 0 ? '▼' : '–';
  return `<span class="chg ${cls}">${arrow} ${Math.abs(n).toFixed(2)}%</span>`;
}
function bp(v) {
  if (v == null || Number.isNaN(v)) return '<span class="chg flat">–</span>';
  const n = Number(v) * 100;
  const cls = n > 0 ? 'up' : n < 0 ? 'down' : 'flat';
  return `<span class="chg ${cls}">${n > 0 ? '+' : ''}${n.toFixed(1)}bp</span>`;
}
const stamp = (t) => {
  if (!t) return '';
  const d = new Date(t);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.month}/${p.day} ${p.hour}:${p.minute}`;
};

// ── 거시 탭 ──
// 지표 행. HIST 에 해당 키의 일별 시계열이 있으면 누르면 그래프가 펼쳐지는 버튼이 됨
function rowWrap(inner, key, label, digits, unit, HIST) {
  if (key && HIST[key]) {
    return `<li class="row has-chart" data-key="${esc(key)}" data-label="${esc(label)}"><button class="rowbtn" type="button" aria-expanded="false" data-key="${esc(key)}" data-label="${esc(label)}" data-digits="${digits}" data-unit="${esc(unit)}">${inner}</button><div class="chart" hidden></div></li>`;
  }
  return `<li class="row"><div class="rowbtn static">${inner}</div></li>`;
}
function quoteRows(list, digits = 2, HIST = {}) {
  return list.map((q) => {
    const d = typeof digits === 'function' ? digits(q) : digits;
    const inner = q.missing || q.price == null
      ? `<span class="lbl">${esc(q.label)}</span><span class="val">-</span>`
      : `<span class="lbl">${esc(q.label)}</span><span class="val">${fmtNum(q.price, d)}</span>${chg(q.changePct)}`;
    return rowWrap(inner, q.symbol, q.label, d, '', HIST);
  }).join('');
}
function yieldRows(list, HIST) {
  return list.map((q) => {
    const inner = q.missing || q.price == null
      ? `<span class="lbl">${esc(q.label)}</span><span class="val">-</span>`
      : `<span class="lbl">${esc(q.label)}</span><span class="val">${fmtNum(q.price, 3)}%</span>${bp((q.price - q.prevClose))}`;
    return rowWrap(inner, q.symbol, q.label, 3, '%', HIST);
  }).join('');
}
function rateRows(list, HIST) {
  return list.map((r) => {
    const inner = r.error
      ? `<span class="lbl">${esc(r.label)}</span><span class="val">-</span>`
      : `<span class="lbl">${esc(r.label)}<small>${esc(r.date?.slice(5) ?? '')}</small></span><span class="val">${fmtNum(r.value, 3)}%</span>${bp(r.delta)}`;
    return rowWrap(inner, `r:${r.label}`, r.label, 3, '%', HIST);
  }).join('');
}

/** 그래프용 시계열 모음: { key: {d:[], c:[]} } */
function collectHistory(m) {
  const H = {};
  for (const [s, h] of Object.entries(m?.history ?? {})) if (h?.c?.length > 5) H[s] = h;
  for (const src of [m?.ecos, m?.fred]) {
    if (!src?.ok) continue;
    for (const r of src.data) if (r.history?.c?.length > 5) H[`r:${r.label}`] = r.history;
  }
  return H;
}
function section(title, meta, body) {
  return `<section class="sec"><header class="sec-h"><h2>${esc(title)}</h2>${meta ? `<span class="meta">${esc(meta)}</span>` : ''}</header>${body}</section>`;
}

function macroTab(m, summary, HIST) {
  if (!m) return '<p class="empty">거시 데이터가 아직 없습니다. 06:30 예약 작업이 돌면 채워집니다.</p>';
  const parts = [];
  parts.push(`<section class="sec fav-sec" id="fav-ind" hidden><header class="sec-h"><h2>★ 즐겨찾기</h2><span class="meta">길게 눌러 추가 · 해제</span></header><p class="fav-hint">지표를 길게 누르면 여기에 고정됩니다</p><ul class="list"></ul></section>`);
  if (Object.keys(HIST).length) parts.push('<p class="hint">지표를 누르면 6개월 일별 그래프, 길게 누르면 즐겨찾기</p>');
  if (m.markets?.ok) {
    const d = m.markets.data;
    const usTime = d.us.find((x) => x.time)?.time;
    parts.push(section('간밤 미장', `마감 ${stamp(usTime)} KST`, `<ul class="list">${quoteRows(d.us, 2, HIST)}</ul>`));
    parts.push(section('미 국채금리', '장중~마감, Yahoo', `<ul class="list">${yieldRows(d.usRates, HIST)}</ul>`));
    parts.push(section('달러 · 환율', null, `<ul class="list">${quoteRows(d.fx, (q) => /KRW|JPY/.test(q.symbol) ? 2 : 4, HIST)}</ul>`));
    parts.push(section('원자재', '선물, 밤사이 반영', `<ul class="list">${quoteRows(d.commodities, 2, HIST)}</ul>`));
    const kr0 = d.kr.find((x) => x.time);
    const krToday = kr0 && kstDate(new Date(kr0.time)) === kstDate();
    const krLabel = kr0?.state === 'REGULAR' ? `장중 ${stamp(kr0.time)}` : krToday ? `오늘 마감 ${stamp(kr0.time)}` : `전일 마감 ${stamp(kr0?.time)}`;
    parts.push(section('국내', krLabel, `<ul class="list">${quoteRows(d.kr, 2, HIST)}</ul>`));
    parts.push(section('글로벌 참고', null, `<ul class="list">${quoteRows(d.global, (q) => q.symbol === 'BTC-USD' ? 0 : 2, HIST)}</ul>`));
  }
  if (m.exim?.ok) {
    parts.push(section('고시환율', `수출입은행 ${m.exim.data.date}`, `<ul class="list">${m.exim.data.rates.map((r) =>
      `<li class="row"><div class="rowbtn static"><span class="lbl">${esc(r.unit)}<small>${esc(r.name)}</small></span><span class="val">${fmtNum(r.base, 2)}</span><span class="sub">살때 ${fmtNum(r.tts, 0)} · 팔때 ${fmtNum(r.ttb, 0)}</span></div></li>`).join('')}</ul>`));
  }
  if (m.ecos?.ok || m.fred?.ok) {
    parts.push(section('금리 확정치', 'ECOS · FRED', `<ul class="list">${m.ecos?.ok ? rateRows(m.ecos.data, HIST) : ''}${m.fred?.ok ? rateRows(m.fred.data, HIST) : ''}</ul>`));
  }
  const skipped = ['markets', 'exim', 'ecos', 'fred'].map((k) => m[k]).filter((r) => r && !r.ok).map((r) => r.name);
  if (skipped.length) parts.push(`<p class="note">건너뜀: ${esc(skipped.join(', '))}</p>`);
  return parts.join('');
}

// ── 이슈 탭 (첫 화면): 오늘의 요약 + 밤사이 헤드라인 ──
function issuesTab(m, summary, staleDate) {
  const parts = [];
  if (summary) parts.push(`<section class="sec summary"><header class="sec-h"><h2>${staleDate ? '요약' : '오늘의 요약'}</h2>${staleDate ? `<span class="meta">${esc(staleDate.slice(5))} 작성</span>` : ''}</header><div class="prose">${md(summary)}</div></section>`);
  if (!m) { parts.push('<p class="empty">데이터가 아직 없습니다. 06:30 예약 작업이 돌면 채워집니다.</p>'); return parts.join(''); }
  const heads = [];
  if (m.rss?.ok) heads.push(...m.rss.data.market.map((h) => ({ src: h.source, title: h.title, link: h.link, at: h.at })));
  if (m.naver?.ok) heads.push(...m.naver.data.map((h) => ({ src: `네이버·${h.query}`, title: h.title, link: h.link, at: h.at })));
  heads.sort((a, b) => (b.at || 0) - (a.at || 0));
  const hhmm = (t) => { if (!t) return ''; const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(t)).map((x) => [x.type, x.value])); return `${p.hour}:${p.minute}`; };
  if (heads.length) {
    parts.push(section('밤사이 헤드라인', `${heads.length}건 · 최신순`, `<ul class="news">${heads.slice(0, 60).map((h) =>
      `<li><a href="${esc(h.link)}" target="_blank" rel="noopener"><span class="src">${esc(h.src)}</span><span class="tm">${hhmm(h.at)}</span>${esc(h.title)}</a></li>`).join('')}</ul>`));
  } else {
    parts.push('<p class="empty">밤사이 시장 관련 헤드라인이 없습니다.</p>');
  }
  const skipped = ['rss', 'naver'].map((k) => m[k]).filter((r) => r && !r.ok).map((r) => r.name);
  if (skipped.length) parts.push(`<p class="note">건너뜀: ${esc(skipped.join(', '))}</p>`);
  return parts.join('');
}

// ── 종목 탭 ──
/** 사업개요 버튼 + 패널: LLM 프로필(profiles.json) 있으면 그걸, 없으면 사업보고서 발췌. 아래에 최근 공시·뉴스 */
function bizPanel(x, p) {
  const disc = x.issues?.disclosures ?? [];
  const news = x.issues?.news ?? [];
  const hasAny = p || x.overview || disc.length || news.length;
  if (!hasAny) return '';
  const body = [];
  if (p) {
    if (p.oneLiner) body.push(`<p class="one">${esc(p.oneLiner)}</p>`);
    if (p.business) body.push(`<h4>사업 내용</h4><p>${esc(p.business)}</p>`);
    if (p.moat) body.push(`<h4>강점 · 해자</h4><p>${esc(p.moat)}</p>`);
    if (p.risks) body.push(`<h4>리스크</h4><p>${esc(p.risks)}</p>`);
    if (p.issues) body.push(`<h4>최근 흐름</h4><p>${esc(p.issues)}</p>`);
  } else if (x.overview) {
    body.push(`<h4>사업 내용 <small>사업보고서 발췌 · 요약은 06:30 예약 작업 후</small></h4><p>${esc(x.overview)}</p>`);
  }
  if (news.length) body.push(`<h4>뉴스</h4><ul class="iss">${news.map((n) => `<li><a href="${esc(n.link)}" target="_blank" rel="noopener"><span class="d">${esc(n.date.slice(5))}</span>${esc(n.title)}${n.src ? `<span class="s">${esc(n.src)}</span>` : ''}</a></li>`).join('')}</ul>`);
  if (disc.length) body.push(`<h4>최근 공시</h4><ul class="iss">${disc.map((d) => `<li><a href="${esc(d.link)}" target="_blank" rel="noopener"><span class="d">${esc(d.date.slice(5))}</span>${esc(d.title)}</a></li>`).join('')}</ul>`);
  return `<div class="biz"><button type="button" class="bizbtn" aria-expanded="false">사업개요 · 주요 이슈</button><div class="bizbody" hidden>${body.join('')}</div></div>`;
}

function screenerTab(s, report, profiles) {
  if (!s) return '<p class="empty">스크리너 결과가 아직 없습니다. DART 키를 넣고 06:30 예약 작업이 돌면 채워집니다.</p>';
  const c = s.candidates;
  const parts = [];
  parts.push(`<section class="sec fav-sec" id="fav-stock" hidden><header class="sec-h"><h2>★ 즐겨찾기</h2><span class="meta">길게 눌러 추가 · 해제</span></header><p class="fav-hint">종목을 길게 누르면 여기에 고정됩니다</p><ol class="cands"></ol></section>`);
  parts.push(`<p class="funnel">재무 FY${s.fy} · 후보 ${c.length} · 누르면 상세, 길게 누르면 즐겨찾기</p>`);
  if (report) parts.push(`<section class="sec report"><header class="sec-h"><h2>정성 평가 리포트</h2></header><div class="prose">${md(report)}</div></section>`);
  parts.push(`<section class="sec"><header class="sec-h"><h2>정량 후보</h2><span class="meta">점수순</span></header><ol class="cands">${c.map((x, i) => `
    <li class="cand" data-code="${esc(x.code)}" data-name="${esc(x.name)}">
      <details>
        <summary>
          <span class="rank">${i + 1}</span>
          <span class="name">${esc(x.name)}<small>${esc(x.code)} · ${won(x.pm.marketCap)}</small></span>
          <span class="score">${x.score.toFixed(1)}</span>
        </summary>
        ${x.ohlc?.length ? `<div class="kchart" data-code="${esc(x.code)}"><div class="ranges"></div><div class="stat"></div><div class="plot"></div></div>` : ''}
        <dl class="kv">
          <div><dt>영업이익률</dt><dd>${pct(x.fm.opMargin)}</dd></div>
          <div><dt>ROE</dt><dd>${pct(x.fm.roe)}</dd></div>
          <div><dt>부채비율</dt><dd>${pct(x.fm.debtRatio, 0)}</dd></div>
          <div><dt>PBR</dt><dd>${x.pbr.toFixed(2)}</dd></div>
          <div><dt>PER</dt><dd>${x.per?.toFixed(1) ?? '-'}</dd></div>
          <div><dt>6M 변동성</dt><dd>${pct(x.pm.annVol, 0)}</dd></div>
          <div><dt>6M 등락</dt><dd>${pct(x.pm.ret6m)}</dd></div>
          <div><dt>52주 고점比</dt><dd>${pct(x.pm.fromHigh52w)}</dd></div>
        </dl>
        <p class="fin">매출 ${won(x.fm.revenue)} · 영업이익 ${x.fm.opIncome.map(won).join(' / ')} · 순이익 ${x.fm.netIncome.map(won).join(' / ')} <small>(당기 / 전기 / 전전기)</small></p>
        <p class="why">${x.why.map((w) => `<span class="tag">${esc(w)}</span>`).join('')}</p>
        ${bizPanel(x, profiles?.[x.code])}
      </details>
    </li>`).join('')}</ol></section>`);
  return parts.join('');
}

// ── 아주 작은 markdown → html (요약·리포트용) ──
function inline(s) {
  return esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`(.+?)`/g, '<code>$1</code>');
}
function md(text) {
  const lines = String(text).replace(/\r/g, '').split('\n');
  const out = [];
  let list = null, table = null, para = [];
  const flushP = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
  const flushL = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const flushT = () => { if (table) { out.push('</tbody></table></div>'); table = null; } };
  for (const raw of lines) {
    const ln = raw.trim();
    if (!ln) { flushP(); flushL(); flushT(); continue; }
    if (ln.startsWith('|')) {
      flushP(); flushL();
      if (/^\|[\s:-]+\|/.test(ln) && !/[^\s|:-]/.test(ln)) continue; // 구분선
      const cells = ln.replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
      if (!table) { table = 'open'; out.push(`<div class="tbl"><table><thead><tr>${cells.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>`); }
      else out.push(`<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`);
      continue;
    }
    flushT();
    const h = ln.match(/^(#{1,4})\s+(.*)/);
    if (h) { flushP(); flushL(); const lv = Math.min(h[1].length + 1, 5); out.push(`<h${lv}>${inline(h[2])}</h${lv}>`); continue; }
    const li = ln.match(/^(?:[-*•]|\d+[.)])\s+(.*)/);
    if (li) { flushP(); const kind = /^\d/.test(ln) ? 'ol' : 'ul'; if (list !== kind) { flushL(); list = kind; out.push(`<${kind}>`); } out.push(`<li>${inline(li[1])}</li>`); continue; }
    flushL();
    para.push(ln);
  }
  flushP(); flushL(); flushT();
  return out.join('\n');
}

// ── 페이지 ──
function page({ date, macro, summary, summaryDate, screener, report, profiles, builtAt }) {
  const HIST = collectHistory(macro);
  const OHLC = Object.fromEntries((screener?.candidates ?? []).filter((c) => c.ohlc?.length).map((c) => [c.code, c.ohlc]));
  return `<title>아침 시장 노트</title>
<meta name="theme-color" content="#F4F5F8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;600&family=Manrope:wght@500;600;700&display=swap">
<style>
:root{
  --bg:#F4F5F8; --surface:#FFFFFF; --line:#E3E6ED; --ink:#171A21; --ink-2:#5B6270; --ink-3:#8A91A0;
  --accent:#1F3A93; --accent-soft:#E8ECF9;
  --up:#C8382F; --down:#1F5FC4; --flat:#8A91A0;
  --font:"IBM Plex Sans KR",-apple-system,"Apple SD Gothic Neo","Malgun Gothic",system-ui,sans-serif;
  --mono:"Manrope","IBM Plex Sans KR",-apple-system,system-ui,sans-serif;
}
@media (prefers-color-scheme: dark){ :root:not([data-theme="light"]){
  --bg:#0F1115; --surface:#181B21; --line:#272B34; --ink:#EDEFF4; --ink-2:#A3A9B6; --ink-3:#6E7482;
  --accent:#8FA6F0; --accent-soft:#1E2740; --up:#F0655B; --down:#5E93F0; --flat:#6E7482;
}}
:root[data-theme="dark"]{
  --bg:#0F1115; --surface:#181B21; --line:#272B34; --ink:#EDEFF4; --ink-2:#A3A9B6; --ink-3:#6E7482;
  --accent:#8FA6F0; --accent-soft:#1E2740; --up:#F0655B; --down:#5E93F0; --flat:#6E7482;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 var(--font);-webkit-font-smoothing:antialiased}
.val,.chg,.date,.meta,.kv dd,.score,.rank,.ax,.tip,.stat,.chart .ranges button{font-variant-numeric:tabular-nums;letter-spacing:-.01em}
a{color:inherit}
.top{position:sticky;top:env(safe-area-inset-top,0px);z-index:5;background:var(--bg);border-bottom:1px solid var(--line);padding:10px 16px 0}
.top .ttl{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.top h1{margin:0;font-size:17px;font-weight:600;letter-spacing:-.01em}
.top .date{font-family:var(--mono);font-size:12px;color:var(--ink-2)}
.tabs{display:flex;gap:4px;margin-top:8px}
.tabs button{flex:1;appearance:none;border:0;background:transparent;color:var(--ink-2);font:inherit;font-weight:500;padding:9px 0 10px;border-bottom:2px solid transparent;cursor:pointer}
.tabs button[aria-selected="true"]{color:var(--accent);border-bottom-color:var(--accent)}
.tabs button:focus-visible{outline:2px solid var(--accent);outline-offset:-2px;border-radius:4px}
main{padding:12px 16px 32px;display:flex;flex-direction:column;gap:12px;max-width:720px;margin:0 auto}
.sec{background:var(--surface);border:1px solid var(--line);border-radius:10px;overflow:hidden}
.sec-h{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding:10px 14px 6px}
.sec-h h2{margin:0;font-size:13px;font-weight:600;text-transform:none;letter-spacing:.01em;color:var(--ink-2)}
.sec-h .meta{font-family:var(--mono);font-size:11px;color:var(--ink-3)}
.list{list-style:none;margin:0;padding:0 14px 6px}
.row{border-top:1px solid var(--line)}
.row:first-child{border-top:0}
.rowbtn{display:grid;grid-template-columns:1fr auto auto;align-items:baseline;gap:10px;padding:7px 0;width:100%;appearance:none;border:0;background:transparent;color:inherit;font:inherit;text-align:left}
button.rowbtn{cursor:pointer;border-radius:6px}
button.rowbtn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
button.rowbtn .lbl::after{content:"";display:inline-block;width:5px;height:5px;margin-left:7px;border-right:1.5px solid var(--ink-3);border-bottom:1.5px solid var(--ink-3);transform:translateY(-3px) rotate(45deg);transition:transform .15s}
button.rowbtn[aria-expanded="true"] .lbl::after{transform:translateY(-1px) rotate(225deg)}
.row .lbl{font-size:14px}
.row .lbl small{display:block;font-size:11px;color:var(--ink-3);font-family:var(--mono)}
.row .val{font-family:var(--mono);font-variant-numeric:tabular-nums;font-size:15px;font-weight:600;text-align:right}
.row .sub{grid-column:2/4;font-size:11px;color:var(--ink-3);font-family:var(--mono);text-align:right}
.hint{margin:-4px 2px 0;font-size:12px;color:var(--ink-3)}
/* 지표 그래프 */
.chart{padding:2px 0 10px}
.chart .ranges{display:flex;gap:4px;justify-content:flex-end;margin-bottom:4px}
.chart .ranges button{appearance:none;border:1px solid var(--line);background:transparent;color:var(--ink-2);font:500 11px/1 var(--mono);padding:4px 8px;border-radius:5px;cursor:pointer}
.chart .ranges button[aria-pressed="true"]{background:var(--accent-soft);color:var(--accent);border-color:transparent}
.chart .ranges button:focus-visible{outline:2px solid var(--accent)}
.chart .stat{display:flex;justify-content:space-between;align-items:baseline;font-family:var(--mono);font-size:12px;color:var(--ink-2);min-height:18px;margin-bottom:2px}
.chart .stat b{font-weight:500;color:var(--ink)}
.chart svg{display:block;width:100%;height:170px;touch-action:pan-y;overflow:visible}
.chart .grid{stroke:var(--line);stroke-width:1}
.chart .area{fill:var(--accent);opacity:.10}
.chart .line{fill:none;stroke:var(--accent);stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.chart .end{fill:var(--accent);stroke:var(--surface);stroke-width:2}
.chart .endbg{fill:var(--accent)}
.chart .endtxt{font-family:var(--mono);font-size:11px;font-weight:600;fill:#fff}
.chart .ax{font-family:var(--mono);font-size:10px;fill:var(--ink-3)}
.chart .xh{stroke:var(--ink-3);stroke-width:1;stroke-dasharray:2 3}
.chart .dot{fill:var(--accent);stroke:var(--surface);stroke-width:2}
.chart .tip{font-family:var(--mono);font-size:11px;fill:var(--ink)}
.chart .tipbg{fill:var(--surface);stroke:var(--line);stroke-width:1}
/* 종목 일봉 캔들 */
.kchart{margin:2px 6px 8px;padding:8px 8px 6px;border:1px solid var(--line);border-radius:8px}
.kchart .ranges{display:flex;gap:4px;justify-content:flex-end;margin-bottom:4px}
.kchart .ranges button{appearance:none;border:1px solid var(--line);background:transparent;color:var(--ink-2);font:500 11px/1 var(--mono);padding:4px 8px;border-radius:5px;cursor:pointer}
.kchart .ranges button[aria-pressed="true"]{background:var(--accent-soft);color:var(--accent);border-color:transparent}
.kchart .stat{display:flex;justify-content:space-between;align-items:baseline;font-family:var(--mono);font-size:12px;color:var(--ink-2);min-height:18px;margin-bottom:2px;flex-wrap:wrap;gap:2px 10px}
.kchart .stat b{font-weight:600;color:var(--ink)}
.kchart svg{display:block;width:100%;height:220px;touch-action:pan-y;overflow:visible}
.kchart .grid{stroke:var(--line);stroke-width:1}
.kchart .ax{font-family:var(--mono);font-size:10px;fill:var(--ink-3)}
.kchart .w.up,.kchart .b.up{stroke:var(--up)} .kchart .b.up{fill:var(--up)}
.kchart .w.down,.kchart .b.down{stroke:var(--down)} .kchart .b.down{fill:var(--down)}
.kchart .w.flat,.kchart .b.flat{stroke:var(--ink-2)} .kchart .b.flat{fill:var(--ink-2)}
.kchart .v{fill:var(--ink-3);opacity:.35}
.kchart .v.up{fill:var(--up)} .kchart .v.down{fill:var(--down)}
.kchart .xh{stroke:var(--ink-3);stroke-width:1;stroke-dasharray:2 3}
.kchart .tipbg{fill:var(--surface);stroke:var(--line);stroke-width:1}
.kchart .tip{font-family:var(--mono);font-size:11px;fill:var(--ink)}
.kchart .tip .t1{fill:var(--ink-2)}
.chg{font-family:var(--mono);font-variant-numeric:tabular-nums;font-size:12.5px;font-weight:600;min-width:5.5em;text-align:right}
.chg.up{color:var(--up)} .chg.down{color:var(--down)} .chg.flat{color:var(--flat)}
.news{list-style:none;margin:0;padding:0 14px 8px}
.news li{border-top:1px solid var(--line);padding:8px 0}
.news li:first-child{border-top:0}
.news a{text-decoration:none;display:block;font-size:14px;line-height:1.4}
.news .src{display:inline-block;font-family:var(--mono);font-size:10.5px;color:var(--accent);background:var(--accent-soft);border-radius:4px;padding:1px 5px;margin-right:6px;vertical-align:1px}
.news .tm{font-family:var(--mono);font-size:11px;color:var(--ink-3);margin-right:6px}
.summary{border-color:var(--accent);border-width:1px}
.summary .sec-h h2{color:var(--accent)}
.prose{padding:0 14px 12px;font-size:14px}
.prose p{margin:6px 0}
.prose h2,.prose h3,.prose h4,.prose h5{margin:14px 0 4px;font-size:14px;font-weight:600}
.prose h2{font-size:15px}
.prose ul,.prose ol{margin:4px 0;padding-left:20px}
.prose li{margin:3px 0}
.prose code{font-family:var(--mono);font-size:12.5px}
.tbl{overflow-x:auto;margin:6px -14px;padding:0 14px}
table{border-collapse:collapse;font-size:12.5px;min-width:100%}
th,td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--line);white-space:nowrap;vertical-align:top}
th{color:var(--ink-2);font-weight:500}
td:last-child{white-space:normal;min-width:14em}
.funnel{margin:0 2px;font-family:var(--mono);font-size:12px;color:var(--ink-3)}
.cands{list-style:none;margin:0;padding:0 8px 8px}
.cand{border-top:1px solid var(--line)}
.cand:first-child{border-top:0}
.cand summary{display:grid;grid-template-columns:2em 1fr auto;align-items:center;gap:8px;padding:9px 6px;cursor:pointer;list-style:none}
.cand summary::-webkit-details-marker{display:none}
.cand .rank{font-family:var(--mono);font-size:12px;color:var(--ink-3);text-align:center}
.cand .name{font-weight:500;font-size:15px}
.cand .name small{display:block;font-weight:400;font-family:var(--mono);font-size:11px;color:var(--ink-3)}
.cand .score{font-family:var(--mono);font-size:13px;color:var(--accent);background:var(--accent-soft);border-radius:6px;padding:2px 8px}
.kv{display:grid;grid-template-columns:repeat(4,1fr);gap:6px 10px;margin:2px 6px 8px 6px;padding:8px 10px;background:var(--bg);border-radius:8px}
.kv div{display:flex;flex-direction:column}
.kv dt{font-size:10.5px;color:var(--ink-3)}
.kv dd{margin:0;font-family:var(--mono);font-size:13px;font-variant-numeric:tabular-nums}
@media (max-width:380px){.kv{grid-template-columns:repeat(3,1fr)}}
.fin{margin:0 6px 6px;font-size:12px;color:var(--ink-2)}
.fin small{color:var(--ink-3)}
.why{margin:0 6px 8px;display:flex;flex-wrap:wrap;gap:4px}
.tag{font-size:11px;background:var(--accent-soft);color:var(--accent);border-radius:4px;padding:1px 6px}
.empty,.note{margin:8px 2px;color:var(--ink-3);font-size:13px}
/* 즐겨찾기 */
.rowbtn,.cand summary{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
.fav-sec{border-color:var(--accent);background:linear-gradient(0deg,var(--accent-soft),var(--accent-soft)) padding-box,var(--surface)}
.fav-sec .sec-h h2{color:var(--accent)}
.fav-sec .list,.fav-sec .cands{background:var(--surface);margin:0 8px 8px;padding-left:8px;padding-right:8px;border-radius:7px}
.fav-sec .list{padding-bottom:4px} .fav-sec .cands{padding-bottom:4px}
.fav-hint{margin:0;padding:2px 14px 12px;font-size:12.5px;color:var(--ink-2)}
.row.fav > .rowbtn .lbl::before,.cand.fav .name::before{content:"★";color:var(--accent);font-size:11px;margin-right:5px;vertical-align:1px}
.cand.gone{opacity:.7}
.gone-row{padding:9px 6px}
.gone-row .name{font-weight:500;font-size:15px}
.gone-row .name small{display:block;font-weight:400;font-family:var(--mono);font-size:11px;color:var(--ink-3)}
.toast{position:fixed;left:50%;bottom:calc(24px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);background:var(--ink);color:var(--bg);font-size:13px;padding:9px 14px;border-radius:20px;z-index:20;box-shadow:0 4px 16px rgba(0,0,0,.18);white-space:nowrap;max-width:calc(100vw - 32px);overflow:hidden;text-overflow:ellipsis}
/* 사업개요 패널 */
.biz{margin:0 6px 10px}
.bizbtn{appearance:none;width:100%;border:1px solid var(--accent);background:transparent;color:var(--accent);font:500 13px/1 var(--font);padding:9px 12px;border-radius:7px;cursor:pointer;text-align:left;position:relative}
.bizbtn::after{content:"";position:absolute;right:14px;top:50%;width:6px;height:6px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:translateY(-70%) rotate(45deg);transition:transform .15s}
.bizbtn[aria-expanded="true"]{background:var(--accent-soft);border-color:transparent}
.bizbtn[aria-expanded="true"]::after{transform:translateY(-20%) rotate(225deg)}
.bizbtn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.bizbody{padding:10px 4px 2px;font-size:13.5px;line-height:1.55}
.bizbody .one{margin:0 0 6px;font-weight:600;font-size:14.5px;color:var(--ink)}
.bizbody h4{margin:12px 0 3px;font-size:12px;font-weight:600;color:var(--ink-2);letter-spacing:.02em}
.bizbody h4 small{font-weight:400;color:var(--ink-3);margin-left:6px}
.bizbody p{margin:0;color:var(--ink);word-break:keep-all}
.iss{list-style:none;margin:0;padding:0}
.iss li{border-top:1px solid var(--line);padding:6px 0}
.iss li:first-child{border-top:0}
.iss a{text-decoration:none;display:block;font-size:13px;line-height:1.4}
.iss .d{font-family:var(--mono);font-size:11px;color:var(--ink-3);margin-right:8px}
.iss .s{font-size:11px;color:var(--ink-3);margin-left:6px}
footer{padding:0 16px 24px;text-align:center;font-family:var(--mono);font-size:11px;color:var(--ink-3)}
[hidden]{display:none!important}
@media (prefers-reduced-motion:no-preference){.cand details[open] .kv{animation:fade .18s ease}}
@keyframes fade{from{opacity:0;transform:translateY(-2px)}to{opacity:1;transform:none}}
</style>
<header class="top">
  <div class="ttl"><h1>아침 시장 노트</h1><span class="date" title="마지막 업데이트">${esc(stamp(builtAt))} 업데이트</span></div>
  <div class="tabs" role="tablist">
    <button id="tab-issues" role="tab" aria-selected="true" aria-controls="panel-issues">주요 이슈</button>
    <button id="tab-macro" role="tab" aria-selected="false" aria-controls="panel-macro">거시지표</button>
    <button id="tab-stock" role="tab" aria-selected="false" aria-controls="panel-stock">종목 발굴</button>
  </div>
</header>
<main>
  <div id="panel-issues" role="tabpanel" aria-labelledby="tab-issues">${issuesTab(macro, summary, summaryDate === date ? null : summaryDate)}</div>
  <div id="panel-macro" role="tabpanel" aria-labelledby="tab-macro" hidden>${macroTab(macro, summary, HIST)}</div>
  <div id="panel-stock" role="tabpanel" aria-labelledby="tab-stock" hidden>${screenerTab(screener, report, profiles)}</div>
</main>
<footer>생성 ${esc(stamp(builtAt))} KST · 개인 참고용, 투자 판단은 본인 책임</footer>
<div id="toast" class="toast" role="status" aria-live="polite" hidden></div>
<script>
(function(){
  var tabs=[['tab-issues','panel-issues'],['tab-macro','panel-macro'],['tab-stock','panel-stock']];
  function show(id){
    tabs.forEach(function(t){var on=t[0]===id;document.getElementById(t[0]).setAttribute('aria-selected',on?'true':'false');document.getElementById(t[1]).hidden=!on;});
    try{localStorage.setItem('tab',id);}catch(e){}
    window.scrollTo(0,0);
  }
  tabs.forEach(function(t){document.getElementById(t[0]).addEventListener('click',function(){show(t[0]);});});
  var saved=null; try{saved=localStorage.getItem('tab');}catch(e){}
  if(saved==='tab-macro'||saved==='tab-stock') show(saved);
})();
</script>
<script id="hist" type="application/json">${JSON.stringify(HIST).replace(/</g, '\\u003c')}</script>
<script id="ohlc" type="application/json">${JSON.stringify(OHLC).replace(/</g, '\\u003c')}</script>
<script>
(function(){
  var OHLC; try{OHLC=JSON.parse(document.getElementById('ohlc').textContent);}catch(e){return;}
  var RANGES=[['1M',22],['3M',66],['6M',9999]];
  var fmt=function(v){return Math.round(v).toLocaleString('en-US');};
  var vol=function(v){return v>=1e6?(v/1e6).toFixed(1)+'M':v>=1e3?(v/1e3).toFixed(0)+'K':String(v);};
  var mmdd=function(s){return s.slice(5).replace('-','/');};

  function render(box,range){
    var all=OHLC[box.dataset.code]; if(!all) return;
    var n=Math.min(range,all.length), rows=all.slice(-n);
    var W=box.clientWidth-16||320, H=220, padL=4, padR=54, padT=10, padB=18, volH=40, gap=6;
    var priceTop=padT, priceBot=H-padB-volH-gap, volTop=priceBot+gap, volBot=H-padB;
    var lo=Infinity,hi=-Infinity,vmax=0;
    rows.forEach(function(r){ if(r[3]<lo)lo=r[3]; if(r[2]>hi)hi=r[2]; if(r[5]>vmax)vmax=r[5]; });
    var span=hi-lo||lo*0.01||1; lo-=span*0.05; hi+=span*0.05;
    var slot=(W-padL-padR)/n, bw=Math.max(1.5,Math.min(9,slot*0.62));
    var x=function(i){return padL+slot*(i+0.5);};
    var y=function(v){return priceTop+(priceBot-priceTop)*(1-(v-lo)/(hi-lo));};
    var yv=function(v){return volBot-(volBot-volTop)*(vmax?v/vmax:0);};
    var s='';
    var ticks=[hi-span*0.05,(hi+lo)/2,lo+span*0.05];
    ticks.forEach(function(t){ s+='<line class="grid" x1="'+padL+'" x2="'+(W-padR)+'" y1="'+y(t).toFixed(1)+'" y2="'+y(t).toFixed(1)+'"/><text class="ax" x="'+(W-padR+6)+'" y="'+(y(t)+3.5).toFixed(1)+'">'+fmt(t)+'</text>'; });
    s+='<line class="grid" x1="'+padL+'" x2="'+(W-padR)+'" y1="'+volBot+'" y2="'+volBot+'"/>';
    rows.forEach(function(r,i){
      var o=r[1],h=r[2],l=r[3],c=r[4],v=r[5]; var cls=c>o?'up':c<o?'down':'flat';
      var cx=x(i).toFixed(1), top=y(Math.max(o,c)), bot=y(Math.min(o,c)), bh=Math.max(1,bot-top);
      s+='<line class="w '+cls+'" x1="'+cx+'" x2="'+cx+'" y1="'+y(h).toFixed(1)+'" y2="'+y(l).toFixed(1)+'"/>';
      s+='<rect class="b '+cls+'" x="'+(x(i)-bw/2).toFixed(1)+'" y="'+top.toFixed(1)+'" width="'+bw.toFixed(1)+'" height="'+bh.toFixed(1)+'"/>';
      s+='<rect class="v '+cls+'" x="'+(x(i)-bw/2).toFixed(1)+'" y="'+yv(v).toFixed(1)+'" width="'+bw.toFixed(1)+'" height="'+Math.max(0,(volBot-yv(v))).toFixed(1)+'"/>';
    });
    [0,Math.floor((n-1)/2),n-1].forEach(function(i,k){ var a=k===0?'start':k===1?'middle':'end'; s+='<text class="ax" text-anchor="'+a+'" x="'+x(i).toFixed(1)+'" y="'+(H-4)+'">'+mmdd(rows[i][0])+'</text>'; });
    s+='<g class="hover" style="display:none"><line class="xh" y1="'+priceTop+'" y2="'+volBot+'"/><rect class="tipbg" rx="4" width="150" height="48"/><text class="tip"><tspan class="t1"></tspan><tspan class="t2"></tspan><tspan class="t3"></tspan></text></g>';
    s+='<rect class="hit" x="0" y="0" width="'+W+'" height="'+H+'" fill="transparent"/>';
    box.querySelector('.plot').innerHTML='<svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="일봉 차트">'+s+'</svg>';

    var first=rows[0][4], last=rows[n-1][4], ch=last-first, chp=first?ch/first*100:0, col=ch>0?'var(--up)':ch<0?'var(--down)':'var(--flat)';
    box.querySelector('.stat').innerHTML='<span>'+mmdd(rows[0][0])+' → '+mmdd(rows[n-1][0])+' · '+n+'일 · 고 '+fmt(Math.max.apply(null,rows.map(function(r){return r[2];})))+' 저 '+fmt(Math.min.apply(null,rows.map(function(r){return r[3];})))+'</span><span><b>'+fmt(last)+'</b> <span style="color:'+col+'">'+(ch>=0?'+':'')+fmt(ch)+' ('+(chp>=0?'+':'')+chp.toFixed(1)+'%)</span></span>';

    var el=box.querySelector('svg'), hov=el.querySelector('.hover'), xh=el.querySelector('.xh'), bg=el.querySelector('.tipbg'), t1=el.querySelector('.t1'), t2=el.querySelector('.t2'), t3=el.querySelector('.t3');
    function at(clientX){
      var rc=el.getBoundingClientRect(); var px=(clientX-rc.left)/rc.width*W;
      var i=Math.round((px-padL)/slot-0.5); i=Math.max(0,Math.min(n-1,i));
      var r=rows[i], cx=x(i), prev=i>0?rows[i-1][4]:null, dd=prev?((r[4]-prev)/prev*100):0;
      xh.setAttribute('x1',cx);xh.setAttribute('x2',cx);
      var bw2=150, bx=cx+10; if(bx+bw2>W-padR) bx=cx-10-bw2; var by=priceTop;
      bg.setAttribute('x',bx);bg.setAttribute('y',by);
      t1.textContent=r[0]+'  '+(prev?(dd>=0?'+':'')+dd.toFixed(2)+'%':''); t1.setAttribute('x',bx+6); t1.setAttribute('y',by+13);
      t2.textContent='시 '+fmt(r[1])+'  고 '+fmt(r[2])+'  저 '+fmt(r[3]); t2.setAttribute('x',bx+6); t2.setAttribute('y',by+27);
      t3.textContent='종 '+fmt(r[4])+'  거래량 '+vol(r[5]); t3.setAttribute('x',bx+6); t3.setAttribute('y',by+41);
      hov.style.display='';
    }
    var hit=el.querySelector('.hit');
    hit.addEventListener('pointermove',function(e){at(e.clientX);});
    hit.addEventListener('pointerdown',function(e){at(e.clientX);});
    hit.addEventListener('pointerleave',function(){hov.style.display='none';});
  }

  /* 이벤트 위임: 즐겨찾기 섹션에 복제된 종목에도 그대로 동작 */
  document.addEventListener('click',function(e){
    var b=e.target.closest('.bizbtn'); if(!b) return;
    var open=b.getAttribute('aria-expanded')==='true'; b.setAttribute('aria-expanded',open?'false':'true'); b.nextElementSibling.hidden=open;
  });
  document.addEventListener('toggle',function(e){
    var det=e.target; if(!det.matches||!det.matches('.cand details')) return;
    /* 하나만 열림: 다른 종목은 닫기 */
    if(det.open) document.querySelectorAll('.cand details[open]').forEach(function(o){ if(o!==det) o.open=false; });
    var box=det.querySelector('.kchart'); if(!det.open||!box||box.dataset.ready) return;
    box.dataset.ready='1'; var range=66;
    box.querySelector('.ranges').innerHTML=RANGES.map(function(r){return '<button type="button" data-n="'+r[1]+'" aria-pressed="'+(r[1]===range)+'">'+r[0]+'</button>';}).join('');
    box.querySelectorAll('.ranges button').forEach(function(b){b.addEventListener('click',function(){
      box.querySelectorAll('.ranges button').forEach(function(o){o.setAttribute('aria-pressed','false');}); b.setAttribute('aria-pressed','true'); render(box,+b.dataset.n);
    });});
    render(box,range);
  },true);
})();
</script>
<script>
(function(){
  var HIST; try{HIST=JSON.parse(document.getElementById('hist').textContent);}catch(e){return;}
  var RANGES=[['1M',22],['3M',66],['6M',9999]];
  var fmt=function(v,d){return Number(v).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});};
  var mmdd=function(s){return s.slice(5).replace('-','/');};

  function render(box,btn,range){
    var h=HIST[btn.dataset.key]; if(!h) return;
    var digits=+btn.dataset.digits||0, unit=btn.dataset.unit||'';
    var n=Math.min(range,h.c.length), d=h.d.slice(-n), c=h.c.slice(-n);
    var W=box.clientWidth||340, H=170, padL=6, padR=Math.max(52,(fmt(h.c[h.c.length-1],digits)+unit).length*6.4+16), padT=12, padB=20; /* 우측 여백: y축 라벨 + 현재가 */
    var lo=Math.min.apply(null,c), hi=Math.max.apply(null,c); if(hi===lo){hi=lo*1.001||1;lo=lo*0.999;}
    var span=hi-lo; lo-=span*0.06; hi+=span*0.06;
    var x=function(i){return padL+(W-padL-padR)*(n===1?0.5:i/(n-1));};
    var y=function(v){return padT+(H-padT-padB)*(1-(v-lo)/(hi-lo));};
    var pts=c.map(function(v,i){return x(i).toFixed(1)+','+y(v).toFixed(1);});
    var line='M'+pts.join('L');
    var area=line+'L'+x(n-1).toFixed(1)+','+(H-padB)+'L'+x(0).toFixed(1)+','+(H-padB)+'Z';
    var ticks=[hi-span*0.06, (hi+lo)/2, lo+span*0.06];
    var first=c[0], last=c[n-1], ch=(last-first), chp=first?ch/first*100:0;
    var col=ch>0?'var(--up)':ch<0?'var(--down)':'var(--flat)';
    var xi=[0,Math.floor((n-1)/2),n-1];
    var svg='<svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="'+btn.dataset.label+' 일별 추이">'
      +ticks.map(function(t){return '<line class="grid" x1="'+padL+'" x2="'+(W-padR)+'" y1="'+y(t).toFixed(1)+'" y2="'+y(t).toFixed(1)+'"/><text class="ax" x="'+(W-padR+6)+'" y="'+(y(t)+3.5).toFixed(1)+'">'+fmt(t,digits)+'</text>';}).join('')
      +'<path class="area" d="'+area+'"/><path class="line" d="'+line+'"/>'
      +'<circle class="end" r="3.5" cx="'+x(n-1).toFixed(1)+'" cy="'+y(last).toFixed(1)+'"/>'
      +(function(){ var s=fmt(last,digits)+unit, w=s.length*6.4+10, ex=W-padR+4, ey=Math.max(padT,Math.min(H-padB-16,y(last)-8)); return '<rect class="endbg" rx="3" x="'+ex+'" y="'+ey.toFixed(1)+'" width="'+w.toFixed(0)+'" height="16"/><text class="endtxt" x="'+(ex+5)+'" y="'+(ey+11.5).toFixed(1)+'">'+s+'</text>'; })()
      +xi.map(function(i,k){var anchor=k===0?'start':k===1?'middle':'end';return '<text class="ax" text-anchor="'+anchor+'" x="'+x(i).toFixed(1)+'" y="'+(H-5)+'">'+mmdd(d[i])+'</text>';}).join('')
      +'<g class="hover" style="display:none"><line class="xh" y1="'+padT+'" y2="'+(H-padB)+'"/><circle class="dot" r="4"/><rect class="tipbg" rx="4" height="34" width="118"/><text class="tip"><tspan class="t1"></tspan><tspan class="t2"></tspan></text></g>'
      +'<rect class="hit" x="0" y="0" width="'+W+'" height="'+H+'" fill="transparent"/></svg>';
    box.querySelector('.plot').innerHTML=svg;
    var stat=box.querySelector('.stat');
    stat.innerHTML='<span>'+mmdd(d[0])+' → '+mmdd(d[n-1])+' · '+n+'일</span><span>기간 <span style="color:'+col+'">'+(ch>=0?'+':'')+fmt(ch,digits)+unit+' ('+(chp>=0?'+':'')+chp.toFixed(2)+'%)</span></span>';

    /* 크로스헤어 + 툴팁 */
    var el=box.querySelector('svg'), hov=el.querySelector('.hover'), xh=el.querySelector('.xh'), dot=el.querySelector('.dot'), bg=el.querySelector('.tipbg'), t1=el.querySelector('.t1'), t2=el.querySelector('.t2'), txt=el.querySelector('.tip');
    function at(clientX){
      var r=el.getBoundingClientRect(); var px=(clientX-r.left)/r.width*W;
      var i=Math.round((px-padL)/(W-padL-padR)*(n-1)); i=Math.max(0,Math.min(n-1,i));
      var cx=x(i), cy=y(c[i]);
      xh.setAttribute('x1',cx);xh.setAttribute('x2',cx);dot.setAttribute('cx',cx);dot.setAttribute('cy',cy);
      var prev=i>0?c[i-1]:null, dd=prev==null?'':' '+(c[i]-prev>=0?'+':'')+(prev?((c[i]-prev)/prev*100).toFixed(2):'0.00')+'%';
      t1.textContent=d[i]; t2.textContent=fmt(c[i],digits)+unit+dd;
      var bw=118, bx=cx+10; if(bx+bw>W-padR) bx=cx-10-bw; var by=Math.max(0,Math.min(H-padB-34,cy-40));
      bg.setAttribute('x',bx);bg.setAttribute('y',by);bg.setAttribute('width',bw);
      t1.setAttribute('x',bx+6);t1.setAttribute('y',by+13);t2.setAttribute('x',bx+6);t2.setAttribute('y',by+27);
      txt.setAttribute('x',bx+6);
      hov.style.display='';
    }
    var hit=el.querySelector('.hit');
    hit.addEventListener('pointermove',function(e){at(e.clientX);});
    hit.addEventListener('pointerdown',function(e){at(e.clientX);});
    hit.addEventListener('pointerleave',function(){hov.style.display='none';});
  }

  /* 이벤트 위임: 즐겨찾기 섹션에 복제된 지표에도 그대로 동작 */
  document.addEventListener('click',function(e){
    var btn=e.target.closest('button.rowbtn'); if(!btn) return;
    var box=btn.nextElementSibling, open=btn.getAttribute('aria-expanded')==='true';
    /* 하나만 열림: 다른 지표 그래프는 닫기 */
    if(!open) document.querySelectorAll('button.rowbtn[aria-expanded="true"]').forEach(function(o){ if(o!==btn){o.setAttribute('aria-expanded','false'); o.nextElementSibling.hidden=true;} });
    btn.setAttribute('aria-expanded',open?'false':'true'); box.hidden=open;
    if(open||box.dataset.ready) return;
    box.dataset.ready='1';
    var range=66;
    box.innerHTML='<div class="ranges">'+RANGES.map(function(r){return '<button type="button" data-n="'+r[1]+'" aria-pressed="'+(r[1]===range)+'">'+r[0]+'</button>';}).join('')+'</div><div class="stat"></div><div class="plot"></div>';
    box.querySelectorAll('.ranges button').forEach(function(b){b.addEventListener('click',function(){
      box.querySelectorAll('.ranges button').forEach(function(o){o.setAttribute('aria-pressed','false');}); b.setAttribute('aria-pressed','true'); render(box,btn,+b.dataset.n);
    });});
    render(box,btn,range);
  });
})();
</script>
<script>
/* 즐겨찾기: 지표(.row[data-key]) / 종목(.cand[data-code]) 길게 누르면 맨 위 섹션에 고정. 이 기기 브라우저에만 저장 */
(function(){
  var KEY_I='fav.ind', KEY_S='fav.stock';
  function load(k){ try{ return JSON.parse(localStorage.getItem(k)||'[]'); }catch(e){ return []; } }
  function save(k,v){ try{ localStorage.setItem(k,JSON.stringify(v)); }catch(e){} }
  var favI=load(KEY_I), favS=load(KEY_S);

  var toastEl=document.getElementById('toast'), toastT;
  function toast(msg){ if(!toastEl) return; toastEl.textContent=msg; toastEl.hidden=false; clearTimeout(toastT); toastT=setTimeout(function(){toastEl.hidden=true;},1400); }
  function buzz(){ try{ if(navigator.vibrate) navigator.vibrate(25); }catch(e){} }

  function markStars(){
    document.querySelectorAll('.row[data-key]').forEach(function(li){ li.classList.toggle('fav',favI.indexOf(li.dataset.key)>=0); });
    document.querySelectorAll('.cand[data-code]').forEach(function(li){ li.classList.toggle('fav',favS.some(function(s){return s.code===li.dataset.code;})); });
  }
  function cleanClone(node){
    var c=node.cloneNode(true);
    c.querySelectorAll('[data-ready]').forEach(function(x){ delete x.dataset.ready; });
    c.querySelectorAll('.chart').forEach(function(x){ x.hidden=true; x.innerHTML=''; });
    c.querySelectorAll('button.rowbtn,.bizbtn').forEach(function(x){ x.setAttribute('aria-expanded','false'); });
    c.querySelectorAll('.bizbody').forEach(function(x){ x.hidden=true; });
    c.querySelectorAll('details').forEach(function(x){ x.open=false; });
    c.querySelectorAll('.kchart .plot,.kchart .ranges,.kchart .stat').forEach(function(x){ x.innerHTML=''; });
    return c;
  }
  function renderFavs(){
    var boxI=document.getElementById('fav-ind'), boxS=document.getElementById('fav-stock');
    if(boxI){
      var ul=boxI.querySelector('ul'); ul.innerHTML='';
      favI.forEach(function(k){ var src=document.querySelector('#panel-macro .sec:not(.fav-sec) .row[data-key="'+CSS.escape(k)+'"]'); if(src) ul.appendChild(cleanClone(src)); });
      boxI.querySelector('.fav-hint').hidden=favI.length>0; boxI.hidden=false;
    }
    if(boxS){
      var ol=boxS.querySelector('ol'); ol.innerHTML='';
      favS.forEach(function(s){
        var src=document.querySelector('#panel-stock .sec:not(.fav-sec) .cand[data-code="'+CSS.escape(s.code)+'"]');
        if(src){ ol.appendChild(cleanClone(src)); }
        else { var li=document.createElement('li'); li.className='cand fav gone'; li.dataset.code=s.code; li.innerHTML='<div class="gone-row"><span class="name">'+s.name+'<small>'+s.code+' · 오늘 후보에 없음</small></span></div>'; ol.appendChild(li); }
      });
      boxS.querySelector('.fav-hint').hidden=favS.length>0; boxS.hidden=false;
    }
    markStars();
  }

  function toggleInd(key,label){
    var i=favI.indexOf(key);
    if(i>=0){ favI.splice(i,1); toast(label+' 즐겨찾기 해제'); } else { favI.push(key); toast('★ '+label+' 즐겨찾기 추가'); }
    save(KEY_I,favI); renderFavs();
  }
  function toggleStock(code,name){
    var i=favS.findIndex(function(s){return s.code===code;});
    if(i>=0){ favS.splice(i,1); toast(name+' 즐겨찾기 해제'); } else { favS.push({code:code,name:name}); toast('★ '+name+' 즐겨찾기 추가'); }
    save(KEY_S,favS); renderFavs();
  }

  /* 길게 누르기 (500ms). 손가락이 10px 이상 움직이면 취소 → 스크롤과 충돌 없음 */
  var timer=null, sx=0, sy=0, fired=false;
  function target(e){ return e.target.closest('.row[data-key] > button.rowbtn, .cand[data-code] > details > summary, .cand.gone'); }
  document.addEventListener('pointerdown',function(e){
    var t=target(e); if(!t) return; sx=e.clientX; sy=e.clientY; fired=false;
    clearTimeout(timer);
    timer=setTimeout(function(){
      fired=true; buzz();
      var row=t.closest('.row[data-key]'); if(row){ toggleInd(row.dataset.key,row.dataset.label); return; }
      var cand=t.closest('.cand[data-code]'); if(cand) toggleStock(cand.dataset.code,cand.dataset.name||(cand.querySelector('.name')||{}).firstChild&&cand.querySelector('.name').firstChild.textContent.trim()||cand.dataset.code);
    },500);
  });
  document.addEventListener('pointermove',function(e){ if(timer&&(Math.abs(e.clientX-sx)>10||Math.abs(e.clientY-sy)>10)){ clearTimeout(timer); timer=null; } });
  ['pointerup','pointercancel','pointerleave'].forEach(function(ev){ document.addEventListener(ev,function(){ clearTimeout(timer); timer=null; }); });
  /* 길게 누른 뒤 따라오는 클릭은 무시 (그래프 열림/닫힘 방지) */
  document.addEventListener('click',function(e){ if(fired&&target(e)){ e.preventDefault(); e.stopPropagation(); fired=false; } },true);
  document.addEventListener('contextmenu',function(e){ if(target(e)) e.preventDefault(); });

  renderFavs();
})();
</script>`;
}

export async function buildApp(dateArg) {
  const date = dateArg || await latestDate('macro-');
  const read = async (p) => (await exists(p)) ? readFile(p, 'utf8') : null;
  const macro = JSON.parse(await read(path.join(OUT, `macro-${date}.json`)) ?? 'null');
  // 요약: 오늘 것이 없으면(장중 갱신 등) 가장 최근 요약을 날짜와 함께 보여줌
  let summary = macro?.summary || await read(path.join(OUT, `summary-${date}.txt`));
  let summaryDate = summary ? date : null;
  if (!summary) {
    const dates = (await readdir(OUT).catch(() => [])).map((n) => n.match(/^summary-(\d{4}-\d{2}-\d{2})\.txt$/)?.[1]).filter(Boolean).sort();
    if (dates.length) { summaryDate = dates.at(-1); summary = await read(path.join(OUT, `summary-${summaryDate}.txt`)); }
  }
  // 스크리너는 날짜 폴더: 오늘 폴더가 없으면 가장 최근 폴더 (오전 실행 전이나 실패한 날에도 어제 후보 유지)
  const sNames = (await readdir(path.join(OUT, 'screener')).catch(() => [])).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort();
  const sDate = (await exists(path.join(OUT, 'screener', date, 'candidates.json'))) ? date : (sNames.at(-1) ?? date);
  const sDir = path.join(OUT, 'screener', sDate);
  const screener = JSON.parse(await read(path.join(sDir, 'candidates.json')) ?? 'null');
  const report = await read(path.join(sDir, 'report.md'));
  let profiles = null;
  try { profiles = JSON.parse(await read(path.join(sDir, 'profiles.json')) ?? 'null'); } catch (e) { console.error(`profiles.json 파싱 실패: ${e.message}`); }

  const html = page({ date, macro, summary, summaryDate, screener, report, profiles, builtAt: new Date().toISOString() });
  const outPath = path.join(OUT, 'app', 'index.html');
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, html, 'utf8');
  console.log(`페이지 생성: ${outPath} (${(html.length / 1024).toFixed(0)}KB) — 거시 ${macro ? date : '없음'} / 요약 ${summary ? '있음' : '없음'} / 후보 ${screener?.candidates.length ?? 0} / 리포트 ${report ? '있음' : '없음'} / 프로필 ${profiles ? Object.keys(profiles).length : 0}`);
  return outPath;
}

if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  buildApp(process.argv[2]).catch((e) => { console.error(`빌드 실패: ${e.message}`); process.exit(1); });
}
