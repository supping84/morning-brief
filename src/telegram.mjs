// 텔레그램 발송: out/ 의 결과물을 모바일에서 읽기 좋은 메시지로 만들어 보냄
// 실행: node src/telegram.mjs [full|quick]
//   full  = 요약 + 지표 + 헤드라인 + 스크리너 (06:30)
//   quick = 지표 한 줄 요약만 (09:30 / 12:30 / 15:30)
import 'dotenv/config';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile, readdir, access } from 'node:fs/promises';
import { kstDate, fmtNum } from './common/util.mjs';
import { sendTelegram } from './common/notify.mjs';

const OUT = path.resolve(process.env.OUT_DIR || 'out');
const exists = (p) => access(p).then(() => true, () => false);
const read = async (p) => (await exists(p)) ? readFile(p, 'utf8') : null;

// 텔레그램 HTML 파스모드용 이스케이프
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const won = (v) => v == null ? '-' : v >= 1e12 ? `${(v / 1e12).toFixed(2)}조` : `${Math.round(v / 1e8).toLocaleString()}억`;
const pct = (v, d = 1) => v == null ? '-' : `${(v * 100).toFixed(d)}%`;

function chg(v) {
  if (v == null || Number.isNaN(v)) return '';
  const n = Number(v);
  return `${n > 0 ? '🔺' : n < 0 ? '🔻' : '➖'}${Math.abs(n).toFixed(2)}%`;
}
function pick(list, symbol) {
  return list?.find((q) => q.symbol === symbol);
}
function quoteLine(q, digits = 2) {
  if (!q || q.price == null) return null;
  return `${esc(q.label)} <b>${fmtNum(q.price, digits)}</b> ${chg(q.changePct)}`; // 라벨에 & 가 있어 이스케이프 필수 (S&P500)
}

/** 마크다운 요약 → 텔레그램 HTML */
function mdToTg(text) {
  return esc(text)
    .replace(/^\s*[-*•]\s+/gm, '· ')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/^#{1,6}\s*(.+)$/gm, '<b>$1</b>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function load(date) {
  const macro = JSON.parse(await read(path.join(OUT, `macro-${date}.json`)) ?? 'null');
  let summary = macro?.summary || await read(path.join(OUT, `summary-${date}.txt`));
  let summaryDate = summary ? date : null;
  if (!summary) {
    const ds = (await readdir(OUT).catch(() => [])).map((n) => n.match(/^summary-(\d{4}-\d{2}-\d{2})\.txt$/)?.[1]).filter(Boolean).sort();
    if (ds.length) { summaryDate = ds.at(-1); summary = await read(path.join(OUT, `summary-${summaryDate}.txt`)); }
  }
  const sNames = (await readdir(path.join(OUT, 'screener')).catch(() => [])).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort();
  const sDate = (await exists(path.join(OUT, 'screener', date, 'candidates.json'))) ? date : sNames.at(-1);
  const screener = sDate ? JSON.parse(await read(path.join(OUT, 'screener', sDate, 'candidates.json')) ?? 'null') : null;
  // 프로필(LLM 정성평가)은 오늘 것이 없으면 가장 최근 날짜에서 가져와 종목코드로 매칭
  let profiles = null;
  for (const d of [sDate, ...sNames.slice().reverse()].filter(Boolean)) {
    try {
      const j = JSON.parse(await read(path.join(OUT, 'screener', d, 'profiles.json')) ?? 'null');
      if (j && Object.keys(j).length) { profiles = j; break; }
    } catch { /* 깨진 파일은 건너뜀 */ }
  }
  return { macro, summary, summaryDate, screener, sDate, profiles };
}

function hhmm(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.hour}:${p.minute}`;
}

/** 지표 블록 (quick/full 공통) */
function marketBlock(m, { full }) {
  if (!m?.markets?.ok) return ['⚠️ 시장 데이터 수신 실패'];
  const d = m.markets.data;
  const L = [];
  const kr = [pick(d.kr, '^KS11'), pick(d.kr, '^KQ11')].map((q) => quoteLine(q)).filter(Boolean);
  const kr0 = d.kr.find((x) => x.time);
  if (kr.length) {
    const state = kr0?.state === 'REGULAR' ? '장중' : '마감';
    L.push(`<b>🇰🇷 국내</b> <i>${state}</i>`, ...kr.map((s) => '  ' + s));
  }
  const fx = [
    quoteLine(pick(d.fx, 'KRW=X')),
    quoteLine(pick(d.fx, 'JPYKRW=X')),
    quoteLine(pick(d.fx, 'DX-Y.NYB'), 2),
  ].filter(Boolean);
  if (fx.length) L.push('', '<b>💱 환율</b>', ...fx.map((s) => '  ' + s));

  const us = (full ? ['^GSPC', '^IXIC', '^SOX', '^VIX'] : ['^GSPC', '^IXIC', '^SOX'])
    .map((s) => quoteLine(pick(d.us, s))).filter(Boolean);
  if (us.length) L.push('', `<b>🇺🇸 미장</b> <i>${full ? '간밤 마감' : '전일'}</i>`, ...us.map((s) => '  ' + s));

  const tnx = pick(d.usRates, '^TNX');
  if (tnx?.price != null) {
    const bp = (tnx.price - tnx.prevClose) * 100;
    L.push('', `<b>📈 금리</b>`, `  美 10년물 <b>${fmtNum(tnx.price, 3)}%</b> ${bp > 0 ? '+' : ''}${bp.toFixed(1)}bp`);
  }
  const cm = (full ? ['CL=F', 'GC=F', 'HG=F'] : ['CL=F', 'GC=F'])
    .map((s) => quoteLine(pick(d.commodities, s))).filter(Boolean);
  if (cm.length) L.push('', '<b>🛢 원자재</b>', ...cm.map((s) => '  ' + s));
  return L;
}

export async function buildMessage(mode = 'full', date = kstDate()) {
  const { macro, summary, summaryDate, screener, profiles } = await load(date);
  const full = mode === 'full';
  const L = [];
  L.push(`<b>📊 ${full ? '모닝 브리핑' : '장중 업데이트'}</b>  ${date} ${hhmm()}`);
  L.push('');

  if (full && summary) {
    if (summaryDate && summaryDate !== date) L.push(`<i>요약 ${summaryDate} 작성</i>`);
    L.push(mdToTg(summary), '');
  }

  L.push(...marketBlock(macro, { full }));

  if (full) {
    const heads = [];
    if (macro?.rss?.ok) heads.push(...macro.rss.data.market.map((h) => ({ src: h.source, title: h.title, link: h.link, at: h.at })));
    if (macro?.naver?.ok) heads.push(...macro.naver.data.map((h) => ({ src: '네이버', title: h.title, link: h.link, at: h.at })));
    heads.sort((a, b) => (b.at || 0) - (a.at || 0));
    if (heads.length) {
      L.push('', `<b>📰 주요 이슈</b> <i>${heads.length}건 중 12</i>`);
      heads.slice(0, 12).forEach((h) => L.push(`· <a href="${esc(h.link)}">${esc(h.title)}</a> <i>${esc(h.src)}</i>`));
    }

    if (screener?.candidates?.length) {
      const c = screener.candidates;
      L.push('', `<b>🔎 종목 후보</b> <i>FY${screener.fy} · ${c.length}개 중 상위 8</i>`);
      c.slice(0, 8).forEach((x, i) => {
        const p = profiles?.[x.code];
        L.push(`${i + 1}. <b>${esc(x.name)}</b> <code>${x.code}</code> ${won(x.pm.marketCap)}`);
        L.push(`    영업이익률 ${pct(x.fm.opMargin)} · ROE ${pct(x.fm.roe)} · PBR ${x.pbr.toFixed(2)} · 6M ${pct(x.pm.ret6m)}`);
        if (p?.oneLiner) L.push(`    <i>${esc(p.oneLiner)}</i>`);
      });
    }
  }

  const page = process.env.APP_URL;
  if (page) L.push('', `📱 <a href="${esc(page)}">전체 보기</a>`);
  L.push('', '<i>개인 참고용 · 투자 판단은 본인 책임</i>');
  return L.join('\n');
}

export async function sendBrief(mode = 'full') {
  const token = process.env.TELEGRAM_BOT_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID 가 .env 에 없습니다');
  const text = await buildMessage(mode);
  await sendTelegram(token, chatId, text, { html: true });
  console.log(`텔레그램 발송 완료 (${mode}, ${text.length}자)`);
  return text;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2] === 'quick' ? 'quick' : 'full';
  if (process.env.DRY_RUN) buildMessage(mode).then((t) => console.log(t));
  else sendBrief(mode).catch((e) => { console.error(`텔레그램 실패: ${e.message}`); process.exit(1); });
}
