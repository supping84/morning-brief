// 앱 예약 작업용 준비 단계를 한 번에: 없는 것만 채우고, 뭐가 있고 없는지 한 줄로 보고
// 실행: node src/prepare.mjs   (npm run prepare)
import 'dotenv/config';
import path from 'node:path';
import { access, readdir } from 'node:fs/promises';
import { kstDate } from './common/util.mjs';

const OUT = path.resolve(process.env.OUT_DIR || 'out');
const has = (p) => access(p).then(() => true, () => false);
const today = kstDate();

async function ensure(label, file, run) {
  if (await has(file)) return `${label}=있음`;
  try {
    console.error(`  ${label} 없음 → 생성 중…`);
    await run();
    return (await has(file)) ? `${label}=생성` : `${label}=실패`;
  } catch (e) {
    console.error(`  ${label} 실패: ${e.message}`);
    return `${label}=실패(${e.message.slice(0, 60)})`;
  }
}

const parts = [];
parts.push(await ensure('거시', path.join(OUT, `macro-${today}.json`), async () => {
  const { runMacro } = await import('./macro/index.mjs');
  await runMacro();
}));
parts.push(await ensure('스크리너', path.join(OUT, 'screener', today, 'candidates.json'), async () => {
  const { runScreener } = await import('./screener/index.mjs');
  await runScreener();
}));

// 남은 일(LLM 담당)을 알려줌
const needSummary = !(await has(path.join(OUT, `summary-${today}.txt`)));
const sDir = path.join(OUT, 'screener', today);
const changed = (await has(path.join(sDir, 'CHANGED'))) ? (await (await import('node:fs/promises')).readFile(path.join(sDir, 'CHANGED'), 'utf8')).trim() : '?';
const needEval = !(await has(path.join(sDir, 'profiles.json')));
const older = (await readdir(path.join(OUT, 'screener')).catch(() => [])).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n) && n < today).sort();
let lastEval = null;
for (const d of older.slice().reverse()) if (await has(path.join(OUT, 'screener', d, 'profiles.json'))) { lastEval = d; break; }

console.log(`날짜=${today} ${parts.join(' ')} CHANGED=${changed}`);
console.log(`할일: 요약=${needSummary ? '작성필요' : '이미있음'} 정성평가=${needEval ? (changed === '0' && lastEval ? `복사(${lastEval})` : '작성필요') : '이미있음'}`);
