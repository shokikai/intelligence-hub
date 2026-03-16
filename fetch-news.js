/**
 * fetch-news.js
 * Google News RSS から飲食業界ニュースを取得し、
 * Anthropic API で要約・分類・示唆コメントを生成して news-data.json に保存する。
 */

import Anthropic from '@anthropic-ai/sdk';
import { XMLParser } from 'fast-xml-parser';
import { writeFileSync } from 'fs';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

// ===== 設定 =====

/** 取得するキーワード（Google News RSS） */
const KEYWORDS = [
  '飲食業界',
  'フードテック',
  '外食トレンド',
  'フードデリバリー',
  '飲食店 人手不足',
  '食品EC',
  '外食産業',
  '飲食店 DX',
  '外食 新業態',
  '食品 消費トレンド',
];

/** 1キーワードあたり最大取得件数 */
const MAX_PER_KEYWORD = 10;

/** Claude バッチサイズ */
const BATCH_SIZE = 10;

/** キーワード間の待機時間（ms） */
const RSS_DELAY_MS = 1200;

/** バッチ間の待機時間（ms） */
const CLAUDE_DELAY_MS = 2000;

// ===== RSS 取得 =====

/**
 * Google News RSS を取得して生XMLを返す
 * @param {string} keyword
 * @returns {Promise<string>}
 */
async function fetchRSS(keyword) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(keyword)}&hl=ja&gl=JP&ceid=JP:ja`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IntelligenceHubBot/1.0)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/**
 * RSS XML をパースして記事配列を返す
 * @param {string} xml
 * @returns {{ title: string, link: string, pubDate: string, source: string }[]}
 */
function parseRSS(xml) {
  const result = xmlParser.parse(xml);
  const items = result?.rss?.channel?.item ?? [];
  const list = Array.isArray(items) ? items : [items];

  return list.map(item => {
    // title は文字列または { '#text': string } 形式の場合がある
    const title = typeof item.title === 'string'
      ? item.title
      : (item.title?.['#text'] ?? String(item.title ?? ''));

    // source も同様
    const source = typeof item.source === 'string'
      ? item.source
      : (item.source?.['#text'] ?? String(item.source ?? ''));

    return {
      title: title.trim(),
      link: String(item.link ?? item.guid ?? ''),
      pubDate: String(item.pubDate ?? ''),
      source: source.trim(),
    };
  }).filter(item => item.title.length > 0);
}

// ===== Anthropic 処理 =====

/**
 * 記事バッチを Claude で分析し、分類・要約・示唆を生成する
 * @param {{ title: string, link: string, pubDate: string, source: string }[]} articles
 * @returns {Promise<Object[]>}
 */
async function processWithClaude(articles) {
  const articleList = articles
    .map((a, i) => `[${i}] タイトル: ${a.title}\n    出典: ${a.source}\n    URL: ${a.link}`)
    .join('\n\n');

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: `あなたは飲食・外食業界の経営コンサルタントです。
以下のニュース記事を分析し、国内70店舗とECを運営する飲食チェーンの経営・マーケティング担当者向けに情報を整理してください。

【カテゴリ定義】
0: 飲食業界ニュース（出店・閉店・M&A・新業態）
1: フードテック（デリバリー・セルフオーダー・AI活用）
2: EC・デジタルマーケティング（食品EC・D2C・SNSトレンド）
3: 消費者トレンド（グルメ・健康・サステナビリティ・節約）
4: 人材・労務（飲食業の人手不足・採用・働き方改革）
5: 規制・行政動向（食品衛生・アルコール法・補助金）
6: 海外成功事例（日本への応用示唆つき）

【記事リスト】
${articleList}

各記事について以下のJSON配列のみ返してください（コードブロック・説明文不要）:
[
  {
    "index": 番号,
    "relevant": true/false（飲食・食品・外食・フードに無関係ならfalse）,
    "cat": 0〜6のいずれか,
    "title": "記事タイトル（日本語。英語なら自然な日本語に翻訳）",
    "summary": "2〜3文の日本語要約。事実を簡潔に。",
    "insight": "この企業（国内70店舗・EC運営の飲食チェーン）が取るべき具体的アクションや注目ポイントを2〜3文で。",
    "tag": "タグ（10文字以内：AI、DX、採用、M&A、法改正等）",
    "hot": true/false（業界への影響が特に大きいニュースのみtrue）
  }
]`,
    }],
  });

  const text = message.content[0].text;

  // JSON配列を抽出（コードブロックで囲まれていることがあるため）
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error(`Claude から JSON が返されませんでした: ${text.substring(0, 200)}`);
  return JSON.parse(jsonMatch[0]);
}

// ===== メイン処理 =====

async function main() {
  console.log('🔄 Intelligence Hub ニュース更新開始');
  console.log(`  対象キーワード: ${KEYWORDS.join(', ')}\n`);

  // 1. RSS 取得 & 重複除去
  const allArticles = [];
  const seenTitles = new Set();

  for (const keyword of KEYWORDS) {
    try {
      console.log(`  📡 RSS 取得: "${keyword}"`);
      const xml = await fetchRSS(keyword);
      const items = parseRSS(xml);
      let added = 0;

      for (const item of items.slice(0, MAX_PER_KEYWORD)) {
        // タイトル先頭30文字で重複判定
        const key = item.title.replace(/\s+/g, '').substring(0, 30);
        if (!seenTitles.has(key)) {
          seenTitles.add(key);
          allArticles.push(item);
          added++;
        }
      }
      console.log(`     → ${items.length} 件取得、${added} 件追加`);

    } catch (err) {
      console.error(`  ❌ "${keyword}" の RSS 取得失敗: ${err.message}`);
    }

    await new Promise(r => setTimeout(r, RSS_DELAY_MS));
  }

  console.log(`\n📰 合計 ${allArticles.length} 件（重複除去後）\n`);

  if (allArticles.length === 0) {
    console.error('記事が取得できなかったため終了します');
    process.exit(1);
  }

  // 2. Claude で要約・分類・示唆生成（バッチ処理）
  const results = [];

  for (let i = 0; i < allArticles.length; i += BATCH_SIZE) {
    const batch = allArticles.slice(i, i + BATCH_SIZE);
    const from = i + 1;
    const to = Math.min(i + BATCH_SIZE, allArticles.length);
    console.log(`  🤖 Claude 処理中: ${from}〜${to} 件目`);

    try {
      const processed = await processWithClaude(batch);

      for (const p of processed) {
        if (!p.relevant) continue;

        const original = batch[p.index];
        if (!original) continue;

        // pubDate を安全にパース
        let dateStr = '';
        try {
          dateStr = original.pubDate
            ? new Date(original.pubDate).toISOString().slice(0, 10)
            : new Date().toISOString().slice(0, 10);
        } catch {
          dateStr = new Date().toISOString().slice(0, 10);
        }

        results.push({
          cat: Number(p.cat) || 0,
          title: String(p.title || original.title),
          summary: String(p.summary || ''),
          insight: String(p.insight || ''),
          source: String(original.source || ''),
          url: String(original.link || ''),
          date: dateStr,
          tag: String(p.tag || ''),
          hot: Boolean(p.hot),
        });
      }

    } catch (err) {
      console.error(`  ❌ Claude 処理エラー（${from}〜${to}件）: ${err.message}`);
    }

    if (i + BATCH_SIZE < allArticles.length) {
      await new Promise(r => setTimeout(r, CLAUDE_DELAY_MS));
    }
  }

  // 3. news-data.json に保存
  const now = new Date();
  // UTC+9 に変換
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);

  const output = {
    lastUpdated: jst.toISOString().replace('Z', '+09:00'),
    updateDate: jst.toLocaleDateString('ja-JP', {
      year: 'numeric', month: 'long', day: 'numeric', weekday: 'short',
    }),
    newsCount: results.length,
    news: results,
  };

  writeFileSync('news-data.json', JSON.stringify(output, null, 2), 'utf8');
  console.log(`\n✅ 完了: ${results.length} 件を news-data.json に保存しました`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
