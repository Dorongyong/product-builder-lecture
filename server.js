require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');

const PORT = process.env.PORT || 3000;
const MODEL = 'claude-sonnet-4-6';
const SYSTEM_PROMPT_PATH = path.join(__dirname, 'prompt', 'system.md');
const REFERENCES_DIR = path.join(__dirname, 'nursing-app', 'references');

// 참고문헌 검색에 항상 사용할 간호진단 키워드
const SEARCH_KEYWORDS = [
  '급성통증', '급성 통증', 'Acute Pain',
  '감염의 위험', 'Risk for Infection',
  '체액 부족', 'Deficient Fluid Volume',
  '오심', 'Nausea',
  '활동 지속성 장애',
  '가스교환', '낙상', '불안', '피로',
];

const MAX_SNIPPET_CHARS = 1000;      // 페이지 하나당 참고문헌 발췌 최대 길이
const MAX_MATCHES_PER_KEYWORD = 2;   // 키워드 하나당 최대 인용 페이지 수
const MAX_TOTAL_REFERENCE_CHARS = 6000; // 프롬프트에 포함할 참고문헌 전체 최대 길이

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

function loadSystemPrompt() {
  const promptDir = path.dirname(SYSTEM_PROMPT_PATH);
  if (!fs.existsSync(promptDir)) {
    fs.mkdirSync(promptDir, { recursive: true });
  }
  if (!fs.existsSync(SYSTEM_PROMPT_PATH)) {
    fs.writeFileSync(SYSTEM_PROMPT_PATH, '', 'utf-8');
  }
  return fs.readFileSync(SYSTEM_PROMPT_PATH, 'utf-8').trim();
}

// references/*.txt 파일을 "===PAGE N===" 마커 기준으로 페이지 단위로 잘라 캐싱한다.
let referenceCache = null;

function loadReferenceFiles() {
  if (referenceCache) return referenceCache;

  referenceCache = [];
  if (!fs.existsSync(REFERENCES_DIR)) return referenceCache;

  const files = fs.readdirSync(REFERENCES_DIR).filter((f) => f.toLowerCase().endsWith('.txt'));
  const markerRegex = /===PAGE\s+(\d+)===/g;

  for (const fileName of files) {
    const raw = fs.readFileSync(path.join(REFERENCES_DIR, fileName), 'utf-8');
    const markers = [];
    let match;
    markerRegex.lastIndex = 0;
    while ((match = markerRegex.exec(raw)) !== null) {
      markers.push({ pageNum: match[1], start: match.index + match[0].length });
    }

    const pages = [];
    for (let i = 0; i < markers.length; i++) {
      const end = i + 1 < markers.length ? markers[i + 1].start : raw.length;
      const text = raw.slice(markers[i].start, end).trim();
      if (text) pages.push({ pageNum: markers[i].pageNum, text });
    }

    referenceCache.push({
      fileName,
      title: fileName.replace(/_?OCR\.txt$/i, '').replace(/\.txt$/i, '').replace(/_/g, ' ').trim(),
      pages,
    });
  }

  return referenceCache;
}

// 주어진 키워드들로 참고문헌(교재 OCR 텍스트)에서 관련 페이지를 검색해 인용 가능한 문자열로 반환한다.
function searchReferences(keywords) {
  const books = loadReferenceFiles();
  if (!books.length || !keywords.length) return '';

  const seenPages = new Set();
  const resultParts = [];
  let totalChars = 0;

  outer:
  for (const keyword of keywords) {
    const needle = keyword.toLowerCase();
    let matchesForKeyword = 0;

    for (const book of books) {
      if (matchesForKeyword >= MAX_MATCHES_PER_KEYWORD) break;

      for (const page of book.pages) {
        if (matchesForKeyword >= MAX_MATCHES_PER_KEYWORD) break;

        const pageKey = `${book.fileName}::${page.pageNum}`;
        if (seenPages.has(pageKey)) continue;
        if (!page.text.toLowerCase().includes(needle)) continue;

        seenPages.add(pageKey);
        matchesForKeyword++;

        const snippet = page.text.length > MAX_SNIPPET_CHARS
          ? `${page.text.slice(0, MAX_SNIPPET_CHARS)}...`
          : page.text;

        const part = `[${book.title}, p.${page.pageNum}] (검색어: ${keyword})\n${snippet}`;
        resultParts.push(part);
        totalChars += part.length;

        if (totalChars >= MAX_TOTAL_REFERENCE_CHARS) break outer;
      }
    }
  }

  return resultParts.join('\n\n---\n\n');
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn(
    '[경고] ANTHROPIC_API_KEY가 설정되지 않았습니다. .env 파일에 키를 입력해주세요. (.env.example 참고)'
  );
}

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

app.post('/api/nursing-plan', async (req, res) => {
  const subjective = (req.body?.subjective || '').trim();
  const objective = (req.body?.objective || '').trim();

  if (!subjective && !objective) {
    return res.status(400).json({ error: '주관적 자료 또는 객관적 자료를 입력해주세요.' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({
      error: '서버에 ANTHROPIC_API_KEY가 설정되어 있지 않습니다. .env 파일을 확인해주세요.',
    });
  }

  // 생성에 1~2분 이상 걸릴 수 있어 SSE(Server-Sent Events)로 전환한다.
  // 응답을 한 번에 몰아서 보내면 그 사이 프록시/게이트웨이의 idle timeout에 걸려
  // 브라우저가 빈 응답을 받고 JSON 파싱에 실패하는 문제가 있었다.
  // SSE로 바이트를 지속적으로 흘려보내면 연결이 끊기지 않는다.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // nginx 등 중간 프록시의 응답 버퍼링 방지
  });
  res.flushHeaders();

  const sendEvent = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // 텍스트 델타가 뜸한 구간에도 연결이 idle로 판단되지 않도록 주기적으로 SSE 주석(heartbeat)을 보낸다.
  const heartbeat = setInterval(() => res.write(':heartbeat\n\n'), 15000);

  try {
    const systemPrompt = loadSystemPrompt();
    const referenceContent = searchReferences(SEARCH_KEYWORDS);

    const userMessage = [
      '[대상자 자료]',
      `주관적 자료(S): ${subjective || '(입력 없음)'}`,
      `객관적 자료(O): ${objective || '(입력 없음)'}`,
      '',
      '[참고 교재 내용 - 이론적 근거 작성에 활용]',
      referenceContent || '(관련 참고문헌을 찾지 못했습니다)',
      '',
      '위 교재 내용에서 근거를 찾아 이론적 근거를 작성하고',
      '반드시 교재명과 페이지 번호를 인용해줘.',
      '예) (Canfield, 2021) [간호진단과 근거기반 간호중재 p.120]',
    ].join('\n');

    // 간호진단 2~3개 × 9개 계획(근거 포함) + 수행 + 평가까지 출력하면 분량이 많아
    // max_tokens를 16000까지 확보한다.
    const stream = anthropic.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      ...(systemPrompt ? { system: systemPrompt } : {}),
      messages: [{ role: 'user', content: userMessage }],
    });

    stream.on('text', (delta) => {
      sendEvent('delta', { text: delta });
    });

    const message = await stream.finalMessage();

    const text = message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    console.log(
      `[간호과정 생성 완료] stop_reason=${message.stop_reason}, output_tokens=${message.usage?.output_tokens}, 결과 길이=${text.length}자`
    );

    sendEvent('done', { result: text });
  } catch (err) {
    console.error('간호과정 생성 오류:', err);
    sendEvent('error', {
      error: `간호과정 생성 중 오류가 발생했습니다: ${err.message || '알 수 없는 오류'}`,
    });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`간호과정 자동 수립 서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
});
