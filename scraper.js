// KEATS (KCL Moodle) courseware scraper engine.
// Pure-Node port of the scripts in ../keats-scraper (download_all.py,
// list_all_courses.py, get_cookies.js, dump_cookies.js, download_sp.py).
// No external dependencies: uses only node: builtins.
import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

export const KEATS_BASE = 'https://keats.kcl.ac.uk';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------
// small utils
// ---------------------------------------------------------------------------

export function stripTags(s) {
  return String(s ?? '').replace(/<[^>]*>/g, '');
}

export function decodeHtml(s) {
  return String(s ?? '')
    .replace(/&#(\d+);/g, (_, n) => {
      try { return String.fromCodePoint(Number(n)); } catch { return _; }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => {
      try { return String.fromCodePoint(parseInt(n, 16)); } catch { return _; }
    })
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_, k) => (
      { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[k.toLowerCase()]
    ));
}

export function sanitize(name) {
  let s = String(name ?? '');
  try { s = decodeURIComponent(s); } catch {}
  s = s.replace(/[\\/:*?"<>|\r\n\t]/g, '_').trim();
  s = s.replace(/^[.\s]+|[.\s]+$/g, '');
  return s || 'unnamed';
}

const EXT_BY_CTYPE = {
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.ms-word': '.doc',
  'application/zip': '.zip',
  'text/plain': '.txt',
  'application/json': '.json',
};

export function filenameFrom(cd, finalUrl, fallback, ctype) {
  const m = /filename\*?=(?:UTF-8'')?"?([^";\r\n]+)"?/i.exec(cd || '');
  if (m) {
    try { return decodeURIComponent(m[1].trim()); } catch { return m[1].trim(); }
  }
  let p = '';
  try {
    p = decodeURIComponent(new URL(finalUrl).pathname.split('/').filter(Boolean).pop() || '');
  } catch { p = ''; }
  if (p && !['view.php', 'index.php', 'download.aspx', 'default.aspx', ''].includes(p)) return p;
  return sanitize(fallback) + (EXT_BY_CTYPE[(ctype || '').split(';')[0].trim()] || '');
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

function timestamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function pool(items, limit, worker) {
  let index = 0;
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, async () => {
    for (;;) {
      const item = items[index++];
      if (item === undefined) return;
      await worker(item);
    }
  }));
}

// ---------------------------------------------------------------------------
// HTTP plumbing (manual redirects, optional cookie jar, TLS verify off)
// ---------------------------------------------------------------------------

function rawRequest(urlStr, { headers = {}, method = 'GET', body = null, signal, jar, timeoutMs = 300000 }) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { reject(e); return; }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      method,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: { 'User-Agent': UA, ...headers },
      rejectUnauthorized: false,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (jar) {
          const setCookies = res.headers['set-cookie'];
          if (Array.isArray(setCookies)) storeCookies(jar, u.hostname, setCookies);
        }
        resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) });
      });
      res.on('error', reject);
    });
    req.on('socket', (s) => {
      s.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('socket timeout'), { code: 'ETIMEDOUT' })));
    });
    req.on('error', reject);
    const onAbort = () => req.destroy(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }));
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    if (body) req.write(body);
    req.end();
  });
}

function storeCookies(jar, host, setCookies) {
  for (const sc of setCookies) {
    const m = /^\s*([^=;]+)=([^;]*)/.exec(sc);
    if (!m) continue;
    const name = m[1].trim();
    const value = m[2].trim();
    let domain = host;
    const dm = /;\s*domain=([^;\s]+)/i.exec(sc);
    if (dm) domain = dm[1].trim().replace(/^\./, '');
    if (!jar.has(domain)) jar.set(domain, new Map());
    jar.get(domain).set(name, value);
  }
}

function cookieHeaderFor(jar, host) {
  const parts = [];
  for (const [domain, map] of jar) {
    if (host === domain || host.endsWith('.' + domain)) {
      for (const [k, v] of map) parts.push(`${k}=${v}`);
    }
  }
  return parts.join('; ');
}

async function hop(url, {
  jar, keatsHeader, signal, method = 'GET', body = null,
  contentType = 'application/x-www-form-urlencoded', maxRedirects = 8,
}) {
  let current = url;
  let m = method;
  let payload = body;
  for (let i = 0; i <= maxRedirects; i++) {
    if (signal?.aborted) throw new Error('aborted');
    const headers = {};
    if (keatsHeader) headers['Cookie'] = keatsHeader;
    if (jar) {
      const host = new URL(current).hostname;
      const ck = cookieHeaderFor(jar, host);
      if (ck) headers['Cookie'] = ck;
    }
    if (m === 'POST' && payload) headers['Content-Type'] = contentType;
    const res = await rawRequest(current, { headers, method: m, body: payload, signal, jar });
    const loc = res.headers.location;
    if (loc && [301, 302, 303, 307, 308].includes(res.status)) {
      current = new URL(loc, current).toString();
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && m === 'POST')) {
        m = 'GET';
        payload = null;
      }
      continue;
    }
    return { status: res.status, headers: res.headers, body: res.body, url: current };
  }
  throw new Error('too many redirects at ' + url);
}

// ---------------------------------------------------------------------------
// Login session from a locally running Chrome (DevTools protocol)
// ---------------------------------------------------------------------------

function httpGetJson(url, timeoutMs = 4000, signal) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { reject(e); return; }
    const req = http.get({
      hostname: u.hostname,
      port: Number(u.port || 80),
      path: u.pathname + u.search,
      timeout: timeoutMs,
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch { reject(new Error('invalid JSON from ' + url)); }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    const onAbort = () => req.destroy(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }));
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function cdpGetAllCookies(wsUrl, signal) {
  return new Promise((resolve, reject) => {
    const WS = globalThis.WebSocket;
    if (typeof WS !== 'function') { reject(new Error('WebSocket unavailable')); return; }
    let settled = false;
    const ws = new WS(wsUrl);
    const timer = setTimeout(() => {
      if (!settled) { settled = true; try { ws.close(); } catch {} reject(new Error('CDP timeout')); }
    }, 15000);
    const onAbort = () => {
      if (!settled) { settled = true; try { ws.close(); } catch {} reject(new Error('aborted')); }
    };
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Network.getAllCookies' }));
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.id === 1) {
          settled = true;
          clearTimeout(timer);
          try { ws.close(); } catch {}
          resolve((msg.result && msg.result.cookies) || []);
        }
      } catch { /* ignore non-JSON frames */ }
    };
    ws.onerror = () => {
      if (!settled) { settled = true; clearTimeout(timer); reject(new Error('CDP websocket error')); }
    };
  });
}

/**
 * Read the browser session from Chrome's DevTools endpoint.
 * Tries the WebSocket CDP API first, then the plain HTTP /json/cookies
 * endpoint (Chrome 104+). Cookies stay in memory only.
 */
export async function getSessionFromChrome(port, signal) {
  const targets = await httpGetJson(`http://127.0.0.1:${port}/json`, 4000, signal);
  if (!Array.isArray(targets)) throw new Error('unexpected /json response');
  const keatsPage =
    targets.find((t) => t && t.type === 'page' && /keats\.kcl\.ac\.uk/.test(t.url || '')) ||
    targets.find((t) => t && t.type === 'page');
  let cookies = [];
  let via = '';
  if (keatsPage) {
    try {
      cookies = await cdpGetAllCookies(keatsPage.webSocketDebuggerUrl, signal);
      via = 'cdp-ws';
    } catch (e) {
      via = 'cdp-ws failed: ' + (e && e.message ? e.message : e);
    }
  }
  if (!cookies.length) {
    cookies = await httpGetJson(`http://127.0.0.1:${port}/json/cookies`, 6000, signal);
    via = 'http /json/cookies';
  }
  const all = new Map();
  for (const c of cookies || []) {
    const domain = String(c.domain || '').replace(/^\./, '');
    if (!domain || c.name === undefined) continue;
    if (!all.has(domain)) all.set(domain, new Map());
    all.get(domain).set(String(c.name), String(c.value));
  }
  const keatsCookies = (cookies || []).filter((c) => String(c.domain || '').includes('keats.kcl.ac.uk'));
  return {
    keatsHeader: keatsCookies.map((c) => `${c.name}=${c.value}`).join('; '),
    allCookies: all,
    via,
    pageUrl: keatsPage ? keatsPage.url : '',
  };
}

// ---------------------------------------------------------------------------
// KEATS API (course listing + module enumeration)
// ---------------------------------------------------------------------------

export async function listCourses(keatsHeader, signal, log = () => {}) {
  const home = await hop(KEATS_BASE + '/my/', { keatsHeader, signal });
  const html = home.body.toString('utf8');
  const sesskey = (/"sesskey":"([^"]+)"/.exec(html) || [])[1] || '';
  const byId = new Map();
  if (sesskey) {
    for (const cls of ['all', 'inprogress', 'future', 'past', 'hidden', 'favourites']) {
      try {
        const payload = JSON.stringify([{
          index: 0,
          methodname: 'core_course_get_enrolled_courses_by_timeline_classification',
          args: { offset: 0, limit: 500, classification: cls, sort: 'fullname' },
        }]);
        const res = await hop(KEATS_BASE + '/lib/ajax/service.php?sesskey=' + sesskey, {
          keatsHeader, signal, method: 'POST', body: payload, contentType: 'application/json',
        });
        const item = (JSON.parse(res.body.toString('utf8')) || [])[0];
        if (item && item.error) { log(`list ${cls}: ${item.exception || 'error'}`); continue; }
        for (const c of (item && item.data && item.data.courses) || []) {
          if (!byId.has(c.id)) byId.set(c.id, { id: c.id, fullname: c.fullname, shortname: c.shortname });
        }
      } catch (e) {
        log(`list ${cls} ERR ${e && e.message ? e.message : e}`);
      }
    }
  }
  if (!byId.size) {
    log('AJAX course API unavailable; falling back to page parsing…');
    const re = /<a[^>]+href="[^"]*\/course\/view\.php\?id=(\d+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
    for (const m of html.matchAll(re)) {
      const id = Number(m[1]);
      if (byId.has(id)) continue;
      byId.set(id, { id, fullname: stripTags(m[2]).replace(/\s+/g, ' ').trim().slice(0, 90), shortname: '' });
    }
  }
  return [...byId.values()];
}

export async function enumerateModules(keatsHeader, courseId, signal, log = () => {}) {
  const html = (
    await hop(KEATS_BASE + `/course/view.php?id=${courseId}`, { keatsHeader, signal })
  ).body.toString('utf8');
  const secIds = [];
  for (const m of html.matchAll(/href="[^"]*\/course\/section\.php\?id=(\d+)/g)) {
    const id = m[1];
    if (!secIds.includes(id)) secIds.push(id);
  }
  const seen = new Set();
  const mods = [];
  for (const sid of secIds) {
    if (signal?.aborted) throw new Error('aborted');
    let shtml;
    try {
      shtml = (
        await hop(KEATS_BASE + `/course/section.php?id=${sid}`, { keatsHeader, signal })
      ).body.toString('utf8');
    } catch (e) {
      log(`  [sec ${sid}] fetch ERR ${e && e.message ? e.message : e}`);
      continue;
    }
    const re = /<a[^>]*href="([^"]*\/mod\/(resource|folder|url)\/view\.php\?id=(\d+))"[^>]*>([\s\S]*?)<\/a>/gi;
    for (const m of shtml.matchAll(re)) {
      const type = m[2];
      const cmid = m[3];
      const key = `${type}:${cmid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const span = /<span[^>]*class="[^"]*instancename[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(m[4]);
      let name = span ? stripTags(span[1]) : stripTags(m[4]);
      name = name.replace(/\s+/g, ' ').trim();
      name = name.replace(/\s+(File|Folder|URL|Page|Book)\s*$/i, '').trim() || cmid;
      mods.push({ type, cmid, name });
    }
  }
  return mods;
}

// ---------------------------------------------------------------------------
// SharePoint / OneDrive links (OAuth form_post flow with browser cookies)
// ---------------------------------------------------------------------------

export function parseForm(html) {
  const m = /<form[^>]*>[\s\S]*?<\/form>/i.exec(html);
  if (!m) return null;
  const form = m[0];
  const actionM = /action="([^"]*)"/i.exec(form);
  const inputs = [];
  const inputRe = /<input[^>]*>/gi;
  let mm;
  while ((mm = inputRe.exec(form)) !== null) {
    const tag = mm[0];
    const nameM = /name="([^"]*)"/i.exec(tag);
    if (!nameM) continue;
    const valueM = /value="([^"]*)"/i.exec(tag);
    inputs.push([decodeHtml(nameM[1]), decodeHtml(valueM ? valueM[1] : '')]);
  }
  return { action: decodeHtml(actionM ? actionM[1] : ''), inputs };
}

async function ensureSharePointSession(jar, startUrl, signal) {
  let res = await hop(startUrl, { jar, signal });
  for (let i = 0; i < 6; i++) {
    const text = res.body.toString('utf8');
    if (!res.url.includes('login.microsoftonline.com') || !/<form/i.test(text)) break;
    const form = parseForm(text);
    if (!form || !form.action) break;
    const action = new URL(form.action, res.url).toString();
    const body = new URLSearchParams(form.inputs).toString();
    res = await hop(action, { jar, signal, method: 'POST', body });
  }
}

// ---------------------------------------------------------------------------
// download helpers
// ---------------------------------------------------------------------------

function saveDownload(res, outdir, fallbackName, cmid) {
  const data = res.body;
  const ctype = (res.headers['content-type'] || '').split(';')[0].trim();
  let fn = filenameFrom(res.headers['content-disposition'] || '', res.url, fallbackName, ctype);
  fn = sanitize(fn);
  if (!path.extname(fn) && data.subarray(0, 4).toString('latin1') === '%PDF') fn += '.pdf';
  let target = path.join(outdir, fn);
  if (fs.existsSync(target) && fs.statSync(target).size !== data.length) {
    const ext = path.extname(fn);
    const base = ext ? fn.slice(0, -ext.length) : fn;
    target = path.join(outdir, `${base}_${cmid}${ext}`);
  }
  fs.writeFileSync(target, data);
  return { file: fn, path: target, bytes: data.length };
}

// ---------------------------------------------------------------------------
// main pipeline
// ---------------------------------------------------------------------------

export async function runScrape(options) {
  const {
    chromeDebugPort = 9222,
    cookieFile = '',
    keatsHeader: presetHeader = '',
    baseDir = '',
    courseIds = [],
    filterKeywords = [],
    listOnly = false,
    downloadSharePoint = true,
    concurrency = 4,
    signal,
    log = () => {},
  } = options || {};

  if (!baseDir) throw new Error('missing output base directory (baseDir)');

  const runDir = path.join(baseDir, 'keats-downloads', timestamp());
  fs.mkdirSync(runDir, { recursive: true });
  const logPath = path.join(runDir, 'progress.log');
  const logLine = (msg) => {
    try { log(msg); } catch {}
    fs.appendFileSync(logPath, String(msg) + '\n');
  };

  // 1) login session
  let session = { keatsHeader: presetHeader, allCookies: new Map(), via: 'preset' };
  if (!session.keatsHeader) {
    try {
      session = await getSessionFromChrome(chromeDebugPort, signal);
      logLine(`[cookies] via ${session.via}`);
    } catch (e) {
      logLine(`[cookies] Chrome CDP unavailable: ${e && e.message ? e.message : e}`);
      if (cookieFile && fs.existsSync(cookieFile)) {
        session.keatsHeader = fs.readFileSync(cookieFile, 'utf8').trim();
        logLine(`[cookies] using cookieFile: ${cookieFile}`);
      }
    }
  }
  if (!session.keatsHeader) {
    throw new Error(
      '未找到 KEATS 登录 Cookie。请先启动带远程调试的 Chrome 并登录 KEATS：\n' +
      `chrome.exe --remote-debugging-port=${chromeDebugPort} --user-data-dir=%TEMP%\\keats-chrome https://keats.kcl.ac.uk/` +
      '\n在 Chrome 中完成微软 SSO 登录后，重新执行本指令即可。'
    );
  }

  // 2) course discovery
  logLine('正在读取已选课程列表……');
  const allCourses = await listCourses(session.keatsHeader, signal, logLine);
  if (!allCourses.length) throw new Error('未找到任何已选课程，请确认 KEATS 登录有效');
  fs.writeFileSync(path.join(runDir, 'courses.json'), JSON.stringify(allCourses, null, 2), 'utf8');

  let targets = allCourses;
  if (courseIds && courseIds.length) {
    targets = allCourses.filter((c) => courseIds.includes(Number(c.id)));
  } else if (filterKeywords && filterKeywords.length) {
    const kws = filterKeywords.map((k) => String(k).toLowerCase());
    targets = allCourses.filter((c) => {
      const hay = `${c.fullname || ''} ${c.shortname || ''} ${c.id}`.toLowerCase();
      return kws.every((k) => hay.includes(k));
    });
  }
  if (!targets.length) {
    throw new Error('没有匹配的课程。当前已选课程：\n' +
      allCourses.map((c) => `  ${c.id}  ${c.fullname}`).join('\n'));
  }

  if (listOnly) {
    const text = '=== KEATS 已选课程 ===\n' +
      targets.map((c) => `  ${c.id}  ${c.fullname} (${c.shortname || '-'})`).join('\n') +
      `\n共 ${targets.length} 门。`;
    return {
      runDir, courses: targets, totalCourses: targets.length,
      totalFiles: 0, totalBytes: 0, failures: 0, externalLinks: 0, summary: text,
    };
  }

  // 3) download each course
  const failures = [];
  const externalLinks = [];
  const courseSummaries = [];
  const startedAt = new Date().toISOString();

  for (const course of targets) {
    if (signal?.aborted) throw new Error('aborted');
    const cdir = path.join(runDir, sanitize(course.shortname || course.fullname || `course-${course.id}`));
    fs.mkdirSync(cdir, { recursive: true });
    logLine(`===== ${course.fullname} (id=${course.id}) =====`);
    let mods = [];
    try {
      mods = await enumerateModules(session.keatsHeader, course.id, signal, logLine);
    } catch (e) {
      failures.push({ course: course.fullname, kind: 'course', name: course.fullname, error: e.message });
      logLine(`  FAIL course ${course.fullname}: ${e.message}`);
      courseSummaries.push({ id: course.id, name: course.fullname, files: 0, bytes: 0 });
      continue;
    }
    const counts = { files: 0, bytes: 0 };
    await pool(mods.map((mod) => ({ mod })), concurrency, async ({ mod }) => {
      try {
        if (mod.type === 'resource') {
          const r = await hop(KEATS_BASE + `/mod/resource/view.php?id=${mod.cmid}&redirect=1`, {
            keatsHeader: session.keatsHeader, signal,
          });
          const saved = saveDownload(r, cdir, mod.name, mod.cmid);
          counts.files += 1; counts.bytes += saved.bytes;
          logLine(`  OK resource: ${saved.file} (${saved.bytes} B)`);
        } else if (mod.type === 'folder') {
          const f = await hop(KEATS_BASE + `/mod/folder/view.php?id=${mod.cmid}`, {
            keatsHeader: session.keatsHeader, signal,
          });
          const links = [];
          for (const m of f.body.toString('utf8').matchAll(/href="([^"]*pluginfile\.php[^"]*)"/gi)) {
            const href = decodeHtml(m[1]);
            if (href.includes('theme_') || links.includes(href)) continue;
            links.push(href);
          }
          for (const href of links) {
            const r = await hop(new URL(href, KEATS_BASE).toString(), {
              keatsHeader: session.keatsHeader, signal,
            });
            const saved = saveDownload(r, cdir, 'folderfile', mod.cmid);
            counts.files += 1; counts.bytes += saved.bytes;
            logLine(`  OK folder[${mod.name}]: ${saved.file} (${saved.bytes} B)`);
          }
          // keep the original folder ZIP too, so nested layouts are preserved
          try {
            const z = await hop(KEATS_BASE + `/mod/folder/download_folder.php?id=${mod.cmid}`, {
              keatsHeader: session.keatsHeader, signal,
            });
            if (z.status === 200 &&
                (z.body.subarray(0, 2).toString('latin1') === 'PK' || (z.headers['content-type'] || '').includes('zip'))) {
              const saved = saveDownload(z, cdir, sanitize(mod.name) + '.zip', mod.cmid);
              counts.files += 1; counts.bytes += saved.bytes;
              logLine(`  OK folder-zip[${mod.name}]: ${saved.file} (${saved.bytes} B)`);
            }
          } catch (e) {
            logLine(`  folder-zip[${mod.name}] skip: ${e && e.message ? e.message : e}`);
          }
        } else if (mod.type === 'url') {
          const u = await hop(KEATS_BASE + `/mod/url/view.php?id=${mod.cmid}`, {
            keatsHeader: session.keatsHeader, signal,
          });
          for (const m of u.body.toString('utf8').matchAll(/href="([^"]+)"/gi)) {
            const href = decodeHtml(m[1]);
            if (/sharepoint|onedrive|dropbox|drive\.google|1drv/i.test(href)) {
              const abs = new URL(href, KEATS_BASE).toString();
              if (!externalLinks.some((l) => l.url === abs)) {
                externalLinks.push({ course: course.fullname, courseDir: cdir, cmid: mod.cmid, name: mod.name, url: abs });
              }
              logLine(`  URL: ${mod.name} -> ${abs.slice(0, 100)}`);
              break;
            }
          }
        }
      } catch (e) {
        failures.push({ course: course.fullname, kind: mod.type, name: mod.name, error: e && e.message ? e.message : String(e) });
        logLine(`  FAIL ${mod.type} ${mod.name}: ${e && e.message ? e.message : e}`);
      }
    });
    courseSummaries.push({ id: course.id, name: course.fullname, files: counts.files, bytes: counts.bytes });
    logLine(`  => ${course.fullname}: ${counts.files} files, ${formatBytes(counts.bytes)}`);
  }

  // 4) SharePoint / OneDrive links
  let spDone = 0;
  if (downloadSharePoint && externalLinks.length) {
    const hasMs = [...session.allCookies.keys()].some((d) =>
      /microsoft|sharepoint|onedrive|office|live|kcl|azure/i.test(d));
    if (!hasMs) {
      logLine(`SharePoint/OneDrive 链接 ${externalLinks.length} 条：未检测到微软登录 Cookie，跳过下载（链接已记录于 manifest.json）`);
    } else {
      logLine(`正在尝试下载 ${externalLinks.length} 个 SharePoint/OneDrive 链接……`);
      const jar = new Map(session.allCookies);
      try {
        await ensureSharePointSession(jar, externalLinks[0].url, signal);
      } catch (e) {
        logLine(`  SharePoint 会话建立失败: ${e && e.message ? e.message : e}`);
      }
      for (const item of externalLinks) {
        if (signal?.aborted) throw new Error('aborted');
        try {
          let r = await hop(item.url + '&download=1', { jar, signal });
          let ct = (r.headers['content-type'] || '').split(';')[0].trim();
          if (ct.includes('html') && r.body.length < 20000) {
            await ensureSharePointSession(jar, item.url, signal);
            r = await hop(item.url + '&download=1', { jar, signal });
            ct = (r.headers['content-type'] || '').split(';')[0].trim();
          }
          if (ct.includes('html')) {
            failures.push({ course: item.course, kind: 'sharepoint', name: item.name, error: `html response, len=${r.body.length}` });
            logLine(`  FAIL(sp) ${item.name}: html response len=${r.body.length}`);
            continue;
          }
          const saved = saveDownload(r, item.courseDir, item.name, item.cmid);
          spDone += 1;
          logLine(`  OK sp: ${saved.file} (${saved.bytes} B)`);
        } catch (e) {
          failures.push({ course: item.course, kind: 'sharepoint', name: item.name, error: e && e.message ? e.message : String(e) });
          logLine(`  FAIL(sp) ${item.name}: ${e && e.message ? e.message : e}`);
        }
      }
    }
  }

  // 5) manifest + summary
  const totalFiles = courseSummaries.reduce((s, c) => s + c.files, 0) + spDone;
  const totalBytes = courseSummaries.reduce((s, c) => s + c.bytes, 0);
  const manifest = {
    runDir,
    startedAt,
    finishedAt: new Date().toISOString(),
    courses: courseSummaries,
    totalFiles,
    totalBytes,
    failures,
    externalLinks: externalLinks.map((l) => ({ course: l.course, cmid: l.cmid, name: l.name, url: l.url })),
  };
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  const summaryLines = [
    '=== KEATS 课件爬取完成 ===',
    `输出文件夹: ${runDir}`,
    `课程数: ${targets.length} | 文件数: ${totalFiles} | 总大小: ${formatBytes(totalBytes)}`,
  ];
  for (const c of courseSummaries) summaryLines.push(`  - ${c.name}: ${c.files} 个文件`);
  if (externalLinks.length) {
    summaryLines.push(`外部链接(SharePoint/OneDrive 等): ${externalLinks.length} 条` +
      (downloadSharePoint ? '（已尝试下载，结果见 manifest.json）' : '（未尝试下载）'));
  }
  if (failures.length) summaryLines.push(`失败: ${failures.length} 项（详见 manifest.json 与 progress.log）`);
  summaryLines.push('注: 视频/直播回放（Lecture Capture）默认不下载。');

  return {
    runDir,
    totalCourses: targets.length,
    totalFiles,
    totalBytes,
    failures: failures.length,
    externalLinks: externalLinks.length,
    summary: summaryLines.join('\n'),
  };
}
