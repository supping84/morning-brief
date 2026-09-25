// 배달: 파일 저장(항상) + 텔레그램(토큰 있을 때) + 콘솔
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export async function saveToFile(dir, name, text) {
  await mkdir(dir, { recursive: true });
  const p = path.join(dir, name);
  await writeFile(p, text, 'utf8');
  return p;
}

/** 텔레그램 메시지 한도 4096자 → 줄 단위로 잘라 순차 전송. 봇 만들기: @BotFather, chat_id: @userinfobot */
export async function sendTelegram(token, chatId, text, { html = false } = {}) {
  if (!token || !chatId) return false;
  const chunks = [];
  let buf = '';
  for (const ln of text.split('\n')) {
    if (buf && (buf.length + ln.length) > 3800) { chunks.push(buf); buf = ''; }
    buf += ln + '\n';
  }
  if (buf.trim()) chunks.push(buf);

  for (const chunk of chunks) {
    const body = { chat_id: chatId, text: chunk, disable_web_page_preview: true, ...(html ? { parse_mode: 'HTML' } : {}) };
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text();
      // HTML 파싱 오류면 평문으로 재시도 (제목에 이상한 태그가 섞인 경우 대비)
      if (html && /can't parse entities/i.test(detail)) {
        const plain = chunk.replace(/<a href="[^"]*">(.*?)<\/a>/g, '$1').replace(/<[^>]+>/g, '');
        const r2 = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: plain, disable_web_page_preview: true }),
        });
        if (r2.ok) continue;
      }
      throw new Error(`텔레그램 전송 실패 HTTP ${res.status}: ${detail.slice(0, 200)}`);
    }
  }
  return true;
}
