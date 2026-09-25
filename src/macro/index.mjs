// 거시지표 탭: 매일 06:30 실행 → 수집 → 포맷 → (선택) 요약 → 저장/전송
import 'dotenv/config';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { safe, kstDate } from '../common/util.mjs';
import { saveToFile } from '../common/notify.mjs';
import { fetchMarkets, fetchHistory } from './sources/markets.mjs';
import { fetchExim } from './sources/exim.mjs';
import { fetchEcos } from './sources/ecos.mjs';
import { fetchFred } from './sources/fred.mjs';
import { fetchRss, fetchNaver } from './sources/news.mjs';
import { formatBrief, formatForLlm } from './format.mjs';
import { summarizeWithClaude } from './summarize.mjs';

const env = process.env;

export async function runMacro() {
  const t0 = Date.now();
  const [markets, history, exim, ecos, fred, rss, naver] = await Promise.all([
    safe('시장(Yahoo)', fetchMarkets),
    safe('일봉(Yahoo)', () => fetchHistory()),
    safe('수출입은행', () => fetchExim(env.EXIM_API_KEY)),
    safe('ECOS', () => fetchEcos(env.ECOS_API_KEY)),
    safe('FRED', () => fetchFred(env.FRED_API_KEY)),
    safe('RSS', fetchRss),
    safe('네이버뉴스', () => fetchNaver(env.NAVER_CLIENT_ID, env.NAVER_CLIENT_SECRET)),
  ]);
  const data = { markets, exim, ecos, fred, rss, naver };

  let summary = null;
  if (env.ANTHROPIC_API_KEY) {
    const r = await safe('Claude 요약', () => summarizeWithClaude(formatForLlm(data)));
    summary = r.ok ? r.data : null;
  }

  const text = formatBrief({ ...data, summary });
  const outDir = path.resolve(env.OUT_DIR || 'out');
  const saved = await saveToFile(outDir, `macro-${kstDate()}.txt`, text);
  // 핸드폰용 페이지(src/app/build.mjs)가 읽는 구조화 데이터
  await saveToFile(outDir, `macro-${kstDate()}.json`, JSON.stringify({ date: kstDate(), generatedAt: new Date().toISOString(), summary, ...data, history: history.ok ? history.data : {} }));

  console.log(text);
  console.log(`\n저장: ${saved}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  // 텔레그램 발송은 src/telegram.mjs 가 전담 (중복 발송 방지)
  return text;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMacro().catch((e) => { console.error(`브리핑 실패: ${e.message}`); if (env.DEBUG) console.error(e.stack); process.exit(1); });
}
