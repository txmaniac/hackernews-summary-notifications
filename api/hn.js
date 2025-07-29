import fetch from 'node-fetch';
import { load } from 'cheerio';

// Configuration: set your topic, title, tags here or use Vercel environment variables.
const TOPIC = process.env.NTFY_TOPIC || 'hn_daily_summaries';
const TITLE = process.env.NTFY_TITLE || 'Hacker News Top 10';
const TAGS  = process.env.NTFY_TAGS || 'news';

// Helper to fetch JSON from Hacker News API
async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}`);
  return await res.json();
}

// Extract a simple summary from a web page
async function extractSummary(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) return '';
  const html = await res.text();
  const $ = load(html);

  // Check common meta tags for descriptions
  const metaTags = [
    $('meta[name="description"]').attr('content'),
    $('meta[property="og:description"]').attr('content'),
    $('meta[name="twitter:description"]').attr('content')
  ].filter(Boolean);
  if (metaTags.length > 0) return metaTags[0];

  // Fallback: first paragraph with at least ~20 words
  const paragraphs = $('p')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter(p => p.split(/\s+/).length >= 20);
  if (paragraphs.length > 0) {
    const sentences = paragraphs[0].split('. ');
    return sentences.slice(0, 2).join('. ') + '.';
  }
  return '';
}

export default async function handler(req, res) {
  try {
    // 1. Get top story IDs
    const ids = await fetchJSON('https://hacker-news.firebaseio.com/v0/topstories.json');
    const topIds = ids.slice(0, 10);

    // 2. Fetch each story and build summaries
    const stories = [];
    for (const id of topIds) {
      const item = await fetchJSON(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
      if (!item || !item.url) continue;
      const summary = await extractSummary(item.url);
      stories.push({
        title: item.title,
        url: item.url,
        score: item.score || 0,
        summary: summary || '(No summary available)'
      });
    }

    // 3. Compose digest text
    let body = '';
    stories.forEach((story, idx) => {
      body += `${idx + 1}. ${story.title} (score: ${story.score})\n`;
      body += `   ${story.summary}\n`;
      body += `   ${story.url}\n\n`;
    });

    // 4. Send the notification via ntfy
    await fetch(`https://ntfy.sh/${TOPIC}`, {
      method: 'POST',
      headers: {
        Title: TITLE,
        Tags: TAGS
      },
      body
    });

    // Response for Vercel invocation
    res.status(200).json({ success: true, count: stories.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch or send stories' });
  }
}
