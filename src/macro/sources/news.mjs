// 뉴스: RSS(키 불필요) + 네이버 뉴스 검색 API(선택)
// 매경 RSS는 봇 차단(403)이라 제외. 제목·링크만 사용 (본문 재게시 X)
import Parser from 'rss-parser';
import { fetchJson } from '../../common/util.mjs';

const parser = new Parser({ timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0 morning-brief' } });

const FEEDS = [
  ['연합인포맥스', 'https://news.einfomax.co.kr/rss/allArticle.xml'],
  ['한경 금융', 'https://www.hankyung.com/feed/finance'],
  ['한경 경제', 'https://www.hankyung.com/feed/economy'],
  ['한경 국제', 'https://www.hankyung.com/feed/international'],
  ['연합뉴스 경제', 'https://www.yna.co.kr/rss/economy.xml'],
];

// 밤사이 시장 관련 기사만 추리는 키워드 (대소문자 무시)
const KEYWORDS = [
  '뉴욕', '월가', '연준', 'fomc', '금리', '환율', '달러', '엔화', '위안', '국채', '유가', '원유', 'wti', '금값',
  '나스닥', 's&p', '다우', '증시', '코스피', '외국인', '반도체', '인플레', '물가', 'cpi', 'pce', '고용', '실업',
  '관세', '무역', '중국', '일본은행', 'boj', 'ecb', '한은', '기준금리', '채권', '비트코인',
];

const HOURS_BACK = 16; // 전날 오후 ~ 오늘 새벽

const ENT = { '&quot;': '"', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };
const decode = (s) => s.replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/g, (m) => ENT[m] ?? m).trim();

export async function fetchRss() {
  const since = Date.now() - HOURS_BACK * 3600 * 1000;
  const settled = await Promise.allSettled(
    FEEDS.map(async ([source, url]) => {
      const feed = await parser.parseURL(url);
      return feed.items
        .map((it) => ({ source, title: decode(it.title || ''), link: it.link, at: it.isoDate ? Date.parse(it.isoDate) : Date.parse(it.pubDate || '') }))
        .filter((it) => it.title && (!it.at || it.at >= since));
    }),
  );

  const items = [];
  const failed = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') items.push(...r.value);
    else failed.push(`${FEEDS[i][0]}: ${r.reason?.message}`);
  });

  const hit = (t) => KEYWORDS.some((k) => t.toLowerCase().includes(k));
  const seen = new Set();
  const market = items
    .filter((it) => hit(it.title))
    .filter((it) => { const key = it.title.replace(/\s+/g, ''); if (seen.has(key)) return false; seen.add(key); return true; })
    .sort((a, b) => (b.at || 0) - (a.at || 0));

  return { market, failed, total: items.length };
}

/** 네이버 뉴스 검색 API (선택). 발급: https://developers.naver.com/apps */
export async function fetchNaver(clientId, clientSecret, queries = ['뉴욕증시 마감', '환율 마감', '국제유가']) {
  if (!clientId || !clientSecret) throw new Error('NAVER 키 없음 (건너뜀)');
  const headers = { 'X-Naver-Client-Id': clientId, 'X-Naver-Client-Secret': clientSecret };
  const results = await Promise.all(
    queries.map(async (q) => {
      const j = await fetchJson(`https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(q)}&display=5&sort=date`, { headers });
      return (j.items || []).map((it) => ({
        query: q,
        title: decode(it.title),
        link: it.originallink || it.link,
        at: Date.parse(it.pubDate),
      }));
    }),
  );
  return results.flat();
}
