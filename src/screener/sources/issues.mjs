// 종목별 "주요 이슈": DART 최근 공시(공식) + Google News RSS 헤드라인(키 불필요, 제목·링크만)
import Parser from 'rss-parser';
import { fetchJson } from '../../common/util.mjs';

const parser = new Parser({ timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0 morning-brief' } });

// 노이즈 공시 제외: 임원 지분 변동, 정기보고서 본문, 대량보유 등
const SKIP = /소유상황보고서|대량보유|보고서\s*\(\d{4}\.\d{2}\)|기업설명회\(IR\)개최.*정정|의결권/;

export async function fetchDisclosures(key, corpCode, days = 180, max = 8) {
  const bgn = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10).replaceAll('-', '');
  const j = await fetchJson(`https://opendart.fss.or.kr/api/list.json?crtfc_key=${key}&corp_code=${corpCode}&bgn_de=${bgn}&page_count=40`);
  if (j.status !== '000') return [];
  const seen = new Set();
  const out = [];
  for (const r of j.list || []) {
    const title = r.report_nm.replace(/\s+/g, ' ').trim();
    if (SKIP.test(title) || seen.has(title)) continue;
    seen.add(title);
    out.push({ date: `${r.rcept_dt.slice(0, 4)}-${r.rcept_dt.slice(4, 6)}-${r.rcept_dt.slice(6)}`, title, link: `https://dart.fss.or.kr/dsaf001/main.do?rcptNo=${r.rcept_no}` });
    if (out.length >= max) break;
  }
  return out;
}

export async function fetchNews(name, days = 60, max = 6) {
  const q = encodeURIComponent(`"${name}"`);
  const feed = await parser.parseURL(`https://news.google.com/rss/search?q=${q}&hl=ko&gl=KR&ceid=KR:ko`);
  const since = Date.now() - days * 86400000;
  const seen = new Set();
  return (feed.items || [])
    .map((it) => {
      const at = Date.parse(it.pubDate || it.isoDate || '');
      const m = (it.title || '').match(/^(.*?)(?:\s-\s([^-]+))?$/); // "제목 - 매체"
      return { at, date: Number.isFinite(at) ? new Date(at).toISOString().slice(0, 10) : '', title: (m?.[1] || it.title || '').trim(), src: (m?.[2] || '').trim(), link: it.link };
    })
    .filter((n) => n.title && (!n.at || n.at >= since))
    .filter((n) => { const k = n.title.replace(/\s+/g, ''); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => (b.at || 0) - (a.at || 0))
    .slice(0, max)
    .map(({ at, ...rest }) => rest);
}

/** 사업보고서 발췌에서 "사업의 개요" 첫 단락 (LLM 요약이 없을 때 대체 표시용) */
export function overviewExcerpt(text, maxChars = 700) {
  if (!text) return '';
  let s = text.replace(/\[표\]/g, ' ').replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ');
  const i = s.search(/사업의\s*개요/);
  if (i >= 0) s = s.slice(i).replace(/^사업의\s*개요\s*/, '');
  s = s.replace(/^\d+\.\s*/, '').replace(/^가\.\s*/, '');
  if (s.length <= maxChars) return s.trim();
  const cut = s.slice(0, maxChars);
  const end = Math.max(cut.lastIndexOf('다.'), cut.lastIndexOf('. '));
  return (end > maxChars * 0.5 ? cut.slice(0, end + 2) : cut).trim() + (end > maxChars * 0.5 ? '' : '…');
}
