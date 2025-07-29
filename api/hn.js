import fetch from 'node-fetch';
import { load } from 'cheerio';

/*
 * Vercel Serverless Function: /api/hn
 *
 * This function retrieves the top stories from Hacker News, extracts
 * short summaries of each article, and sends one push notification
 * per story using the ntfy service.  Splitting notifications in this
 * way avoids generating a large attachment on iOS, which cannot be
 * opened directly in the ntfy app.  The code is designed to be
 * triggered by a Vercel Cron job defined in vercel.json.
 */

// Configuration via environment variables.  Set these in Vercel’s
// project settings.  Fallback values are provided for local testing.
const TOPIC  = process.env.NTFY_TOPIC || 'hn_daily_summaries';
const TAGS   = process.env.NTFY_TAGS || 'news';
const LIMIT  = parseInt(process.env.STORY_LIMIT, 10) || 10;

/**
 * Fetch JSON data from a URL and return the parsed object.
 * @param {string} url The URL to fetch
 * @returns {Promise<any>} The parsed JSON or null on error
 */
async function fetchJSON(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error(err);
    return null;
  }
}

/**
 * Extract a brief summary from an article URL.
 * First checks common meta tags (description, og:description,
 * twitter:description).  If none are found or too short, falls back to the
 * first paragraph with at least ~20 words.
 *
 * @param {string} url The article URL
 * @returns {Promise<string>} A summary string (may be empty)
 */
async function extractSummary(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return '';
    const html = await res.text();
    const $ = load(html);
    const metaTags = [
      $('meta[name="description"]').attr('content'),
      $('meta[property="og:description"]').attr('content'),
      $('meta[name="twitter:description"]').attr('content')
    ].filter(Boolean);
    if (metaTags.length > 0) return metaTags[0];
    const paragraphs = $('p')
      .map((_, el) => $(el).text().trim())
      .get()
      .filter((p) => p.split(/\s+/).length >= 20);
    if (paragraphs.length > 0) {
      const sentences = paragraphs[0].split('. ');
      return sentences.slice(0, 2).join('. ') + '.';
    }
    return '';
  } catch (err) {
    console.error(`extractSummary: ${err}`);
    return '';
  }
}

/**
 * Send a push notification via ntfy for a single story.
 * Uses the story title as the notification title and the summary plus
 * URL as the body.
 * @param {object} story An object with title, summary and url
 */
async function sendNotification(story) {
  /*
   * To make it easy for users to open the article directly from the
   * notification — especially on iOS where links in the message body
   * aren’t clickable — we leverage ntfy’s “click action” feature.
   * Passing the article URL in the `Click` header ensures that
   * tapping the notification opens the link in the default browser.
   * See the ntfy docs: Passing a URL as the value of the `X‑Click` or
   * `Click` header causes the client to open that URL when the
   * notification is clicked【636718046834246†L2470-L2483】.
   */
  const body = `${story.summary}\n${story.url}`;
  const res = await fetch(`https://ntfy.sh/${TOPIC}`, {
    method: 'POST',
    headers: {
      Title: story.title,
      Tags: TAGS,
      Click: story.url
    },
    body
  });
  if (!res.ok) {
    console.error(`Failed to send notification for ${story.title}: ${res.status}`);
  }
}

export default async function handler(req, res) {
  try {
    // 1. Retrieve top story IDs
    const ids = await fetchJSON('https://hacker-news.firebaseio.com/v0/topstories.json');
    if (!Array.isArray(ids)) {
      res.status(500).json({ error: 'Failed to fetch top stories' });
      return;
    }
    const topIds = ids.slice(0, LIMIT);

    let sent = 0;
    for (const id of topIds) {
      const item = await fetchJSON(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
      if (!item || !item.url) continue;
      const summary = await extractSummary(item.url);
      try {
        await sendNotification({ title: item.title, summary: summary || '(No summary available)', url: item.url });
      }
      catch (err){
        console.error(err);
      }
      sent++;
    }
    res.status(200).json({ success: true, sent });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}
