'use strict';
// Signs in via the app's own API, then screenshots the main screens at desktop width.
const puppeteer = require('puppeteer-core');
const BASE = 'http://127.0.0.1:3000';

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  const r = await page.evaluate(async () => {
    const res = await fetch('/api/auth/signin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'anita.admin@example.test', password: 'Password@123' }),
      credentials: 'same-origin',
    });
    return res.status;
  });
  console.log('signin status', r);
  const shots = [['dashboard', '#/dashboard'], ['approvals', '#/approvals'], ['team', '#/team']];
  for (const [name, hash] of shots) {
    await page.goto(BASE + '/' + hash, { waitUntil: 'networkidle2' });
    await new Promise((s) => setTimeout(s, 900));
    await page.screenshot({ path: '/tmp/final-' + name + '.png' });
    console.log('shot', name);
  }
  await browser.close();
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
