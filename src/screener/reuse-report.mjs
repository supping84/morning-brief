// 후보 변동 없는 날: 가장 최근 report.md/profiles.json을 오늘 폴더로 재사용하고
// profiles.json의 issues만 오늘자 candidates.json(공시·뉴스)으로 갱신한다.
// 사용: node src/screener/reuse-report.mjs
import { readdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { env } from 'node:process';
import { kstDate } from '../common/util.mjs';

const OUT = path.resolve(env.OUT_DIR || 'out', 'screener');
const today = kstDate();
const todayDir = path.join(OUT, today);

function fmtMD(dateStr) {
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${parseInt(m[2], 10)}/${parseInt(m[3], 10)}` : dateStr;
}

function buildIssues(issues) {
  const news = issues?.news || [];
  const disc = issues?.disclosures || [];
  const newsPart = news.slice(0, 2).map((n) => `${fmtMD(n.date)} '${n.title}'`).join(', ');
  const discPart = disc.slice(0, 3).map((d) => `${fmtMD(d.date)} ${d.title}`).join(', ');
  let out = '';
  if (newsPart) out += `${newsPart} 보도.`;
  if (discPart) out += `${out ? ' ' : ''}${discPart} 공시.`;
  return out || '관련 공시·뉴스 없음.';
}

async function main() {
  if (existsSync(path.join(todayDir, 'report.md')) && existsSync(path.join(todayDir, 'profiles.json'))) {
    console.log('오늘 폴더에 이미 report.md/profiles.json이 있음 — 건너뜀');
    return;
  }

  const dates = (await readdir(OUT)).filter((d) => d !== today && /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse();
  const prevDate = dates.find((d) => existsSync(path.join(OUT, d, 'report.md')) && existsSync(path.join(OUT, d, 'profiles.json')));
  if (!prevDate) {
    console.log('재사용할 이전 report.md/profiles.json을 찾지 못함');
    process.exitCode = 1;
    return;
  }

  await copyFile(path.join(OUT, prevDate, 'report.md'), path.join(todayDir, 'report.md'));
  await copyFile(path.join(OUT, prevDate, 'profiles.json'), path.join(todayDir, 'profiles.json'));

  const reportPath = path.join(todayDir, 'report.md');
  let report = await readFile(reportPath, 'utf8');
  report = report.replace(/^# .*$/m, `# 강소기업 스크리너 리포트  ${today}`);
  // 제목 뒤에 있던 이전 날짜의 "후보 변동..." 안내문(있다면)을 오늘자로 교체
  report = report.replace(/^(# .*\n\n)(> .*\n\n)?/, `$1> 후보 변동 없음 (${prevDate} 평가 재사용)\n\n`);
  await writeFile(reportPath, report, 'utf8');

  const candPath = path.join(todayDir, 'candidates.json');
  const profPath = path.join(todayDir, 'profiles.json');
  const cand = JSON.parse(await readFile(candPath, 'utf8')).candidates;
  const prof = JSON.parse(await readFile(profPath, 'utf8'));

  let updated = 0;
  for (const c of cand) {
    if (!prof[c.code]) continue;
    prof[c.code].issues = buildIssues(c.issues);
    updated++;
  }
  await writeFile(profPath, JSON.stringify(prof, null, 2), 'utf8');

  console.log(`재사용: ${prevDate} → ${today} (report.md, profiles.json) · issues 갱신 ${updated}건`);
}

main();
