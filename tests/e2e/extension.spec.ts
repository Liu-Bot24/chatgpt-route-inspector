import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const extensionPath = path.join(root, 'dist', 'e2e');
const storageKey = 'chatgptRouteInspectorStateV1';
let context: BrowserContext;
let worker: Worker;
let extensionId: string;
let profileDir: string;
let server: Server;
let webSocketFrame: string;

async function expectPopupFits(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    const selectors = [
      '.masthead .brand',
      '.brand-mark',
      '.brand-copy',
      '.masthead-controls',
      '.popup-control-grid',
      '.popup-result-grid',
      '.route-model',
      '.route-model strong',
      '.verdict-line',
      '.button-stack',
      '.pow-readout',
      '.footer-link'
    ];
    const clipped = selectors.flatMap((selector) => {
      const elements = [...document.querySelectorAll<HTMLElement>(selector)];
      if (elements.length === 0) return [selector];
      return elements.flatMap((element, index) => {
        const box = element.getBoundingClientRect();
        return box.left < 0 || box.right > window.innerWidth || box.top < 0 || box.bottom > window.innerHeight
          ? [`${selector}:${index}`]
          : [];
      });
    });
    const brand = document.querySelector<HTMLElement>('.masthead .brand')?.getBoundingClientRect();
    const controls = document.querySelector<HTMLElement>('.masthead-controls')?.getBoundingClientRect();
    return {
      bodyWidth: Math.round(body.getBoundingClientRect().width),
      clipped,
      headerOverlap: Boolean(brand && controls && brand.right > controls.left),
      horizontalOverflow: Math.max(root.scrollWidth, body.scrollWidth) > window.innerWidth,
      scrollX: window.scrollX,
      verticalOverflow: Math.max(root.scrollHeight, body.scrollHeight) > window.innerHeight
    };
  })).toEqual({
    bodyWidth: 640,
    clipped: [],
    headerOverlap: false,
    horizontalOverflow: false,
    scrollX: 0,
    verticalOverflow: false
  });
}

async function findExtensionCapableChromium(): Promise<string> {
  const configured = process.env.ROUTE_INSPECTOR_CHROMIUM;
  const playwrightDefault = chromium.executablePath();
  const candidates = [configured, playwrightDefault].filter((value): value is string => Boolean(value));
  const cacheRoot = path.join(homedir(), 'AppData', 'Local', 'ms-playwright');
  try {
    const installations = (await readdir(cacheRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^chromium-\d+$/.test(entry.name))
      .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
    for (const installation of installations) {
      candidates.push(path.join(cacheRoot, installation.name, 'chrome-win64', 'chrome.exe'));
      candidates.push(path.join(cacheRoot, installation.name, 'chrome-win', 'chrome.exe'));
    }
  } catch {
    // The standard Playwright cache does not exist on this machine.
  }
  const match = candidates.find((candidate) => existsSync(candidate));
  if (!match) throw new Error('No extension-capable Chromium found. Run: npx playwright install chromium');
  return match;
}

test.beforeAll(async () => {
  const [requestBody, responseBody, conversationMessages, frame, deltaBody] = await Promise.all([
    readFile(path.join(root, 'tests', 'fixtures', 'conversation-request.json'), 'utf8'),
    readFile(path.join(root, 'tests', 'fixtures', 'handoff-response.sse'), 'utf8'),
    readFile(path.join(root, 'tests', 'fixtures', 'conversation-messages.json'), 'utf8'),
    readFile(path.join(root, 'tests', 'fixtures', 'websocket-route-frame.json'), 'utf8'),
    readFile(path.join(root, 'tests', 'fixtures', 'delta-response.sse'), 'utf8')
  ]);
  webSocketFrame = frame;
  server = createServer((request, response) => {
    if (request.method === 'POST' && request.url?.startsWith('/backend-api/f/conversation?delta=')) {
      const variant = new URL(request.url, 'http://127.0.0.1:43996').searchParams.get('delta') ?? 'normal';
      let body = deltaBody.replaceAll('conv-delta', `conv-${variant}`).replaceAll('req-delta', `req-${variant}`);
      if (variant === 'missing-resolved') body = body.replace(',"resolved_model_slug":"gpt-6-pro"', '');
      if (variant === 'conflict') body = body.replace('"resolved_model_slug":"gpt-6-pro"', '"resolved_model_slug":"gpt-5-5-mini"');
      if (variant === 'unsupported') body = body.replace('data: "v1"', 'data: "v2"');
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' });
      let offset = 0;
      const writeChunk = () => {
        if (response.destroyed) return;
        if (offset >= body.length) { response.end(); return; }
        response.write(body.slice(offset, offset + 31));
        offset += 31;
        setTimeout(writeChunk, 2);
      };
      writeChunk();
      return;
    }
    if (request.url === '/delta-fixture') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html><body><h1>Delta response fixture</h1></body></html>');
      return;
    }
    if (request.method === 'POST' && request.url === '/backend-api/sentinel/chat-requirements/prepare') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify({
        prepare_token: 'PRIVATE_PREPARE_TOKEN',
        proofofwork: { required: true, seed: 'PRIVATE_POW_SEED', difficulty: '063556' },
        turnstile: { dx: 'PRIVATE_TURNSTILE_PAYLOAD' }
      }));
      return;
    }
    if (request.method === 'POST' && ['/backend-api/f/conversation', '/backend-api/f/conversations'].includes(request.url ?? '')) {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' });
      response.end(responseBody);
      return;
    }
    if (request.method === 'GET' && request.url === '/backend-api/conversations/e2e-conversation?include_has_versions=true&num_turns=100') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(conversationMessages);
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(`<!doctype html><html><body><h1>Route fixture</h1><button id="ask">Run live fixture</button><pre id="done"></pre><script>const capturedFetch1=window.fetch;window.fetch=async function o1(...args){window.__routeReceiverOne=this===window;const response=await capturedFetch1.apply(this,args);const url=String(args[0] instanceof Request?args[0].url:args[0]);if(url.includes('/backend-api/f/conversation'))return new Response('data: [DONE]',{status:response.status,headers:{'content-type':'text/event-stream'}});return response};const capturedFetch2=window.fetch;window.fetch=async function o2(...args){window.__routeReceiverTwo=this===window;return capturedFetch2.apply(this,args)};const capturedWebSocket1=window.WebSocket;function ws1(...args){window.__routeWebSocketOne=true;return Reflect.construct(capturedWebSocket1,args,capturedWebSocket1)}ws1.prototype=capturedWebSocket1.prototype;for(const key of ['CONNECTING','OPEN','CLOSING','CLOSED'])Object.defineProperty(ws1,key,{value:capturedWebSocket1[key]});window.WebSocket=ws1;const capturedWebSocket2=window.WebSocket;function ws2(...args){window.__routeWebSocketTwo=true;return Reflect.construct(capturedWebSocket2,args,capturedWebSocket2)}ws2.prototype=capturedWebSocket2.prototype;for(const key of ['CONNECTING','OPEN','CLOSING','CLOSED'])Object.defineProperty(ws2,key,{value:capturedWebSocket2[key]});window.WebSocket=ws2;window.__routeSocketMessages=[];const openSocket=()=>new Promise((resolve,reject)=>{const socket=new window.WebSocket('ws://127.0.0.1:43996/backend-api/ws');window.__routeSocket=socket;socket.addEventListener('message',(event)=>window.__routeSocketMessages.push(event.data));socket.addEventListener('open',()=>resolve(socket),{once:true});socket.addEventListener('error',reject,{once:true})});const body=${JSON.stringify(requestBody)};document.querySelector('#ask').onclick=async()=>{const socket=await openSocket();const response=await window.fetch('/backend-api/f/conversations',{method:'POST',headers:{'content-type':'application/json'},body});document.querySelector('#done').textContent=await response.text();socket.send('emit-route')};const appendAssistant=(id)=>{const assistant=document.createElement('div');assistant.dataset.messageAuthorRole='assistant';assistant.dataset.messageId=id;assistant.dataset.messageModelSlug='gpt-5-6-pro';assistant.textContent='PRIVATE_ASSISTANT_TEXT';document.body.append(assistant)};if(localStorage.getItem('route-fixture-dom-only')==='1'){localStorage.removeItem('route-fixture-dom-only');appendAssistant('fixture-dom-only-message')}if(localStorage.getItem('route-fixture-reload')==='1'){localStorage.removeItem('route-fixture-reload');appendAssistant('fixture-assistant-message');void window.fetch('/backend-api/conversations/e2e-conversation?include_has_versions=true&num_turns=100').then((response)=>response.json());}</script></body></html>`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(43996, '127.0.0.1', resolve);
  });

  profileDir = await mkdtemp(path.join(tmpdir(), 'route-inspector-e2e-'));
  const chromePath = await findExtensionCapableChromium();
  context = await chromium.launchPersistentContext(profileDir, {
    executablePath: chromePath,
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`
    ]
  });
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  extensionId = new URL(worker.url()).host;
});

test.afterAll(async () => {
  await context?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  const resolvedProfile = path.resolve(profileDir);
  const resolvedTemp = path.resolve(tmpdir());
  if (resolvedProfile.startsWith(`${resolvedTemp}${path.sep}`)) {
    await rm(resolvedProfile, { recursive: true, force: true });
  }
});

test('keeps live and reload captures distinct and stores no chat text', async () => {
  const languageSetup = await context.newPage();
  await languageSetup.goto(`chrome-extension://${extensionId}/ui/popup/index.html`);
  await languageSetup.locator('[data-language="zh"]').click();
  await expect(languageSetup.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(languageSetup.locator('.author-link')).toHaveAttribute('href', 'https://blog.liu-qi.cn/tools/');
  const popupFontSizes = await languageSetup.locator('body').evaluate((body) => Array.from(body.querySelectorAll<HTMLElement>('*'))
    .filter((element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
    })
    .map((element) => getComputedStyle(element).fontSize)
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort((left, right) => Number.parseFloat(left) - Number.parseFloat(right)));
  expect(popupFontSizes).toEqual(['10px', '12px', '14px', '16px', '18px']);
  await languageSetup.close();

  const page = await context.newPage();
  await page.routeWebSocket('ws://127.0.0.1:43996/backend-api/ws', (socket) => {
    socket.onMessage((message) => {
      if (message === 'emit-route') socket.send(webSocketFrame);
    });
  });
  await page.goto('http://127.0.0.1:43996/c/e2e-conversation');
  const overlay = page.locator('#chatgpt-route-inspector-root');
  await expect(overlay).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => window.fetch.name)).toBe('routeInspectorFetch');
  await page.evaluate(async () => {
    await window.fetch('/backend-api/sentinel/chat-requirements/prepare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ p: 'PRIVATE_POW_FINGERPRINT' })
    });
  });
  await page.locator('#ask').click();
  await expect.poll(() => page.evaluate(() => [
    (window as Window & { __routeReceiverOne?: boolean }).__routeReceiverOne,
    (window as Window & { __routeReceiverTwo?: boolean }).__routeReceiverTwo
  ])).toEqual([true, true]);
  await expect(page.locator('#done')).toHaveText('data: [DONE]');
  await expect.poll(() => page.evaluate(() => {
    const scope = window as Window & {
      __routeSocket?: WebSocket;
      __routeSocketMessages?: unknown[];
      __routeWebSocketOne?: boolean;
      __routeWebSocketTwo?: boolean;
    };
    const socket = scope.__routeSocket;
    let noNewThrows = false;
    try {
      Reflect.apply(window.WebSocket as unknown as (...args: unknown[]) => unknown, window, ['ws://127.0.0.1:43996/backend-api/ws']);
    } catch {
      noNewThrows = true;
    }
    return [
      scope.__routeWebSocketOne,
      scope.__routeWebSocketTwo,
      Boolean(socket && socket instanceof window.WebSocket),
      Boolean(socket && Object.getPrototypeOf(socket) === window.WebSocket.prototype),
      window.WebSocket.OPEN,
      scope.__routeSocketMessages?.length ?? 0,
      noNewThrows
    ];
  })).toEqual([true, true, true, true, 1, 1, true]);

  await expect.poll(async () => worker.evaluate(async (key) => {
    const result = await chrome.storage.local.get(key);
    const state = result[key] as {
      turns?: Array<{ verdict?: string; captureMode?: string; routeModel?: string | null; modelLabel?: string | null; sources?: string[] }>;
    } | undefined;
    const live = state?.turns?.find((turn) => turn.captureMode === 'live');
    return live ? `${live.verdict}:${live.routeModel}:${live.modelLabel}:${live.sources?.join('+')}` : 'missing';
  }, storageKey)).toBe('conflict:null:gpt-5-6-pro:page_fetch+page_websocket');

  await expect.poll(async () => worker.evaluate(async (key) => {
    const state = (await chrome.storage.local.get(key))[key] as {
      powReadings?: Array<{ rawHex?: string; decimal?: string; tabId?: number | null }>;
    } | undefined;
    const reading = state?.powReadings?.[0];
    return reading ? `${reading.rawHex}:${reading.decimal}:${typeof reading.tabId}` : 'missing';
  }, storageKey)).toBe('063556:406870:number');

  let stored = await worker.evaluate(async (key) => JSON.stringify((await chrome.storage.local.get(key))[key]), storageKey);
  expect(stored).toContain('gpt-5-6-pro');
  expect(stored).toContain('gpt-5-5-mini');
  expect(stored).not.toMatch(/SECRET_PROMPT|SECRET_ANSWER|HANDOFF_SECRET|PRIVATE_POW_SEED|PRIVATE_POW_FINGERPRINT|PRIVATE_PREPARE_TOKEN|PRIVATE_TURNSTILE_PAYLOAD|private\.pdf|confidence|effectiveModel/i);

  let overlayText = await overlay.evaluate((element) => element.shadowRoot?.textContent ?? '');
  expect(overlayText).toContain('路由字段冲突');
  expect(overlayText).toContain('resolved_model_slug');
  expect(overlayText).toContain('PoW 难度');
  expect(overlayText).toContain('063556（406870）');
  const fullOverlayFontSizes = await overlay.evaluate((element) => Array.from(element.shadowRoot?.querySelectorAll<HTMLElement>('*') ?? [])
    .filter((child) => {
      const style = getComputedStyle(child);
      const box = child.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
    })
    .map((child) => getComputedStyle(child).fontSize)
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort((left, right) => Number.parseFloat(left) - Number.parseFloat(right)));
  expect(fullOverlayFontSizes).toEqual(['10px', '12px', '14px', '16px']);
  const chineseStatusLayout = await overlay.evaluate((element, labels) => {
    const status = element.shadowRoot?.querySelector<HTMLElement>('.status');
    const title = element.shadowRoot?.querySelector<HTMLElement>('.title');
    const author = element.shadowRoot?.querySelector<HTMLElement>('.author');
    const compact = element.shadowRoot?.querySelector<HTMLElement>('#compact');
    const probe = element.shadowRoot?.querySelector<HTMLElement>('.probe');
    if (!status || !title || !author || !compact || !probe) return null;
    const original = status.textContent;
    const cases = labels.map((label) => {
      status.textContent = label;
      const statusBox = status.getBoundingClientRect();
      const compactBox = compact.getBoundingClientRect();
      const contentRight = Math.max(title.getBoundingClientRect().right, author.getBoundingClientRect().right);
      const probeBox = probe.getBoundingClientRect();
      return {
        contained: statusBox.left >= probeBox.left && statusBox.right <= probeBox.right,
        label,
        noBrandOverlap: contentRight <= statusBox.left,
        rightGap: Math.round(compactBox.left - statusBox.right)
      };
    });
    status.textContent = original;
    const style = getComputedStyle(status);
    return { cases, fontSize: style.fontSize, lang: probe.lang, textAlign: style.textAlign };
  }, [
    '等待下一次回答',
    '等待刷新会话',
    '路由正常',
    '检测到路由错配',
    '路由字段冲突',
    '已读取响应路由',
    '仅取得模型标签',
    '未取得实际路由',
    '正在捕获'
  ]);
  expect(chineseStatusLayout).not.toBeNull();
  expect(chineseStatusLayout?.fontSize).toBe('12px');
  expect(chineseStatusLayout?.lang).toBe('zh-CN');
  expect(chineseStatusLayout?.textAlign).toBe('right');
  expect(chineseStatusLayout?.cases.every((entry) => entry.contained && entry.noBrandOverlap && entry.rightGap === 12)).toBe(true);

  await expect(overlay.locator('#compact')).toHaveAttribute('data-tooltip', '极简模式');
  await expect(overlay.locator('#mini')).toHaveAttribute('data-tooltip', '迷你模式');
  await expect(overlay.locator('#compact')).not.toHaveAttribute('title', /.+/);
  await expect(overlay.locator('#mini')).not.toHaveAttribute('title', /.+/);
  await expect.poll(() => overlay.evaluate((element) => [...(element.shadowRoot?.querySelectorAll<HTMLButtonElement>('.head-tools button') ?? [])]
    .map((button) => button.id)))
    .toEqual(['compact', 'mini']);
  await expect.poll(() => overlay.locator('.mode-icon').evaluateAll((icons) => icons.map((icon) => {
    const rect = icon.getBoundingClientRect();
    const style = getComputedStyle(icon);
    return `${icon.className}:${rect.width}x${rect.height}:${style.borderRadius}`;
  }))).toEqual(['mode-icon compact-icon:8x3:0px', 'mode-icon mini-icon:6x6:1px']);
  const compactButton = overlay.locator('#compact');
  await compactButton.hover();
  await expect.poll(() => compactButton.evaluate((button) => getComputedStyle(button, '::after').transitionDelay)).toBe('0.42s');
  await page.waitForTimeout(300);
  await expect.poll(() => compactButton.evaluate((button) => getComputedStyle(button, '::after').opacity)).toBe('0');
  await page.waitForTimeout(200);
  await expect.poll(() => compactButton.evaluate((button) => {
    const style = getComputedStyle(button, '::after');
    const rect = button.getBoundingClientRect();
    return {
      backgroundColor: style.backgroundColor,
      color: style.color,
      content: style.content,
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
      opacity: style.opacity,
      padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
      staysInViewport: rect.right <= window.innerWidth,
      visibility: style.visibility
    };
  })).toEqual({
    backgroundColor: 'rgba(255, 255, 255, 0.937)',
    color: 'rgba(0, 0, 0, 0.847)',
    content: '"极简模式"',
    fontSize: '11px',
    lineHeight: '14px',
    opacity: '1',
    padding: ['2px', '6px', '2px', '6px'],
    staysInViewport: true,
    visibility: 'visible'
  });
  await page.screenshot({ path: path.join(root, 'output', 'playwright', 'overlay-tooltip-e2e.png'), fullPage: true });
  await page.mouse.move(0, 0);
  await expect.poll(() => compactButton.evaluate((button) => getComputedStyle(button, '::after').opacity)).toBe('0');
  const miniButton = overlay.locator('#mini');
  await miniButton.hover();
  await expect.poll(() => miniButton.evaluate((button) => getComputedStyle(button, '::after').transitionDelay)).toBe('0.42s');
  await page.waitForTimeout(300);
  await expect.poll(() => miniButton.evaluate((button) => getComputedStyle(button, '::after').opacity)).toBe('0');
  await page.waitForTimeout(200);
  await expect.poll(() => miniButton.evaluate((button) => getComputedStyle(button, '::after').opacity)).toBe('1');
  await page.mouse.move(0, 0);
  await compactButton.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await expect.poll(() => compactButton.evaluate((button) => getComputedStyle(button, '::after').opacity)).toBe('1');
  await compactButton.evaluate((button) => button.blur());
  await overlay.locator('#compact').click();
  await expect.poll(async () => worker.evaluate(async (key) => {
    const current = (await chrome.storage.local.get(key))[key] as {
      settings?: { overlayMode?: string; overlayMinimized?: boolean; captureMode?: string };
    } | undefined;
    return `${current?.settings?.overlayMode}:${current?.settings?.overlayMinimized}:${current?.settings?.captureMode}`;
  }, storageKey)).toBe('compact:true:live');
  overlayText = await overlay.evaluate((element) => element.shadowRoot?.textContent ?? '');
  expect(overlayText).toContain('gpt-5-6-pro');
  expect(overlayText).toContain('路由字段冲突');
  expect(overlayText).toContain('063556');
  expect(overlayText).toContain('|');
  expect(overlayText).toContain('406870');
  expect(overlayText).not.toContain('诊断台');
  expect(overlayText).not.toContain('隐藏浮窗');
  const compactOverlayFontSizes = await overlay.evaluate((element) => Array.from(element.shadowRoot?.querySelectorAll<HTMLElement>('*') ?? [])
    .filter((child) => {
      const style = getComputedStyle(child);
      const box = child.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
    })
    .map((child) => getComputedStyle(child).fontSize)
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort((left, right) => Number.parseFloat(left) - Number.parseFloat(right)));
  expect(compactOverlayFontSizes).toEqual(['10px', '12px', '14px', '16px']);
  await expect.poll(() => overlay.locator('.compact').evaluate((element) => {
    const route = element.querySelector<HTMLElement>('.route');
    const models = [...element.querySelectorAll<HTMLElement>('.model')];
    const values = [...element.querySelectorAll<HTMLElement>('.model b')];
    const boxes = models.map((model) => model.getBoundingClientRect());
    return {
      clippedValues: values.every((value) => getComputedStyle(value).overflow === 'hidden'),
      contained: Boolean(route && boxes.every((box) => box.left >= route.getBoundingClientRect().left && box.right <= route.getBoundingClientRect().right)),
      noModelOverlap: boxes.length === 2 && boxes[0]!.right <= boxes[1]!.left,
      noHorizontalOverflow: element.scrollWidth <= element.clientWidth
    };
  })).toEqual({ clippedValues: true, contained: true, noModelOverlap: true, noHorizontalOverflow: true });
  await expect(overlay.locator('#mini-dock')).toHaveCount(0);
  await expect(overlay.locator('#expand')).not.toHaveAttribute('title', /.+/);
  await expect(overlay.locator('#expand')).toHaveAttribute('aria-label', '展开浮窗');
  const compactTop = await overlay.locator('.compact').evaluate((element) => element.getBoundingClientRect().top);
  await page.screenshot({ path: path.join(root, 'output', 'playwright', 'overlay-compact-e2e.png'), fullPage: true });
  await overlay.locator('#expand').click();
  await expect.poll(async () => worker.evaluate(async (key) => {
    const current = (await chrome.storage.local.get(key))[key] as {
      settings?: { overlayMode?: string; overlayMinimized?: boolean };
    } | undefined;
    return `${current?.settings?.overlayMode}:${current?.settings?.overlayMinimized}`;
  }, storageKey)).toBe('full:false');

  await overlay.locator('#mini').click();
  await expect.poll(async () => worker.evaluate(async (key) => {
    const current = (await chrome.storage.local.get(key))[key] as {
      settings?: { overlayMode?: string; overlayMinimized?: boolean; captureMode?: string };
    } | undefined;
    return `${current?.settings?.overlayMode}:${current?.settings?.overlayMinimized}:${current?.settings?.captureMode}`;
  }, storageKey)).toBe('mini:true:live');
  const miniText = await overlay.locator('.mini-hit').textContent();
  expect(miniText).toContain('路由字段冲突');
  expect(miniText).toContain('406870');
  expect(miniText).not.toContain('请求模型');
  expect(miniText).not.toContain('响应路由');
  expect(miniText).not.toContain('PoW 难度');
  expect(miniText).not.toContain('063556');
  await expect(overlay.locator('.mini-divider')).toHaveCount(1);
  await expect.poll(() => overlay.locator('.mini').evaluate((element) => {
    const values = [...element.querySelectorAll<HTMLElement>('.mini-value')];
    const boxes = values.map((value) => value.getBoundingClientRect());
    const root = element.getBoundingClientRect();
    return {
      clippedValues: values.every((value) => getComputedStyle(value).overflow === 'hidden'),
      contained: boxes.every((box) => box.left >= root.left && box.right <= root.right),
      noValueOverlap: boxes.length === 2 && boxes[0]!.bottom <= boxes[1]!.top,
      noHorizontalOverflow: element.scrollWidth <= element.clientWidth
    };
  })).toEqual({ clippedValues: true, contained: true, noValueOverlap: true, noHorizontalOverflow: true });
  await expect(overlay.locator('#mini-dock')).not.toHaveAttribute('title', /.+/);
  await expect(overlay.locator('#mini-dock')).not.toHaveAttribute('data-tooltip', /.+/);
  await expect(overlay.locator('#mini-dock')).toHaveAttribute('aria-label', '停靠到边缘');
  await expect(overlay.locator('#expand')).not.toHaveAttribute('title', /.+/);
  await expect(overlay.locator('#expand')).toHaveAttribute('aria-label', '展开浮窗');
  await expect.poll(() => overlay.locator('.mini').evaluate((element, expectedTop) => {
    const rect = element.getBoundingClientRect();
    return {
      alignedTop: Math.abs(rect.top - expectedTop) <= 1,
      dockedRight: Math.abs(window.innerWidth - rect.right) <= 1,
      narrow: rect.width <= 160
    };
  }, compactTop)).toEqual({ alignedTop: true, dockedRight: true, narrow: true });
  const miniGeometry = await overlay.evaluate((element) => {
    const mini = element.shadowRoot?.querySelector<HTMLElement>('.mini');
    const divider = element.shadowRoot?.querySelector<HTMLElement>('.mini-divider');
    const dock = element.shadowRoot?.querySelector<HTMLElement>('.mini-dock-hit');
    if (!mini || !divider || !dock) return null;
    const miniBox = mini.getBoundingClientRect();
    const dividerBox = divider.getBoundingClientRect();
    const dockBox = dock.getBoundingClientRect();
    return {
      accentWidth: Math.round(miniBox.left - dockBox.left),
      dockBoundaryMatchesDivider: Math.abs(dockBox.right - dividerBox.left) <= 1,
      dockHeightCoversMini: dockBox.top <= miniBox.top && dockBox.bottom >= miniBox.bottom,
      height: miniBox.height,
      top: miniBox.top
    };
  });
  expect(miniGeometry).not.toBeNull();
  expect(miniGeometry?.accentWidth).toBe(5);
  expect(miniGeometry?.dockBoundaryMatchesDivider).toBe(true);
  expect(miniGeometry?.dockHeightCoversMini).toBe(true);
  await expect.poll(() => overlay.locator('.mini').evaluate((element) => {
    const original = element.className;
    const read = () => getComputedStyle(element).getPropertyValue('--mini-accent').trim();
    element.setAttribute('class', 'probe mini normal');
    const normal = read();
    element.setAttribute('class', 'probe mini danger');
    const danger = read();
    element.setAttribute('class', 'probe mini warn');
    const warn = read();
    element.setAttribute('class', original);
    return { danger, normal, warn };
  })).toEqual({ danger: '#f07868', normal: '#a9f04d', warn: '#efb55d' });
  await page.screenshot({ path: path.join(root, 'output', 'playwright', 'overlay-mini-e2e.png'), fullPage: true });
  await overlay.locator('#mini-dock').click();
  await expect.poll(async () => worker.evaluate(async (key) => {
    const current = (await chrome.storage.local.get(key))[key] as {
      settings?: { overlayMode?: string; overlayMinimized?: boolean };
    } | undefined;
    return `${current?.settings?.overlayMode}:${current?.settings?.overlayMinimized}`;
  }, storageKey)).toBe('docked:true');
  await expect(overlay.locator('.mini-docked')).toHaveCount(1);
  await expect(overlay.locator('.mini-docked')).toHaveText('');
  await expect(overlay.locator('#mini-undock')).not.toHaveAttribute('title', /.+/);
  await expect(overlay.locator('#mini-undock')).not.toHaveAttribute('data-tooltip', /.+/);
  await expect(overlay.locator('#mini-undock')).toHaveAttribute('aria-label', '恢复迷你浮窗');
  await expect.poll(() => overlay.locator('.mini-docked').evaluate((element, expected) => {
    const rect = element.getBoundingClientRect();
    const hit = element.querySelector<HTMLElement>('.mini-undock-hit')?.getBoundingClientRect();
    return {
      accentWidth: hit ? Math.round(rect.left - hit.left) : 0,
      alignedTop: Math.abs(rect.top - expected.top) <= 1,
      blackWidth: Math.round(rect.width),
      dockedRight: Math.abs(window.innerWidth - rect.right) <= 1,
      fullHandleWidth: hit ? Math.round(hit.right - hit.left) : 0,
      sameHeight: Math.abs(rect.height - expected.height) <= 1
    };
  }, miniGeometry!)).toEqual({ accentWidth: 5, alignedTop: true, blackWidth: 11, dockedRight: true, fullHandleWidth: 16, sameHeight: true });
  await page.screenshot({ path: path.join(root, 'output', 'playwright', 'overlay-mini-docked-e2e.png'), fullPage: true });
  await page.reload();
  await expect(overlay).toHaveCount(1);
  await expect(overlay.locator('.mini-docked')).toHaveCount(1);
  await expect.poll(async () => worker.evaluate(async (key) => {
    const current = (await chrome.storage.local.get(key))[key] as {
      settings?: { overlayMode?: string; overlayMinimized?: boolean };
    } | undefined;
    return `${current?.settings?.overlayMode}:${current?.settings?.overlayMinimized}`;
  }, storageKey)).toBe('docked:true');
  await overlay.locator('#mini-undock').click();
  await expect.poll(async () => worker.evaluate(async (key) => {
    const current = (await chrome.storage.local.get(key))[key] as {
      settings?: { overlayMode?: string; overlayMinimized?: boolean };
    } | undefined;
    return `${current?.settings?.overlayMode}:${current?.settings?.overlayMinimized}`;
  }, storageKey)).toBe('mini:true');
  await expect(overlay.locator('.mini')).toHaveCount(1);
  const regularViewport = page.viewportSize();
  await page.setViewportSize({ width: 360, height: 640 });
  await expect.poll(() => overlay.locator('.mini').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      contained: rect.left >= 0 && rect.right <= window.innerWidth,
      dockedRight: Math.abs(window.innerWidth - rect.right) <= 1,
      noHorizontalOverflow: element.scrollWidth <= element.clientWidth
    };
  })).toEqual({ contained: true, dockedRight: true, noHorizontalOverflow: true });
  await overlay.locator('#expand').click();
  await expect.poll(async () => worker.evaluate(async (key) => {
    const current = (await chrome.storage.local.get(key))[key] as {
      settings?: { overlayMode?: string; overlayMinimized?: boolean };
    } | undefined;
    return `${current?.settings?.overlayMode}:${current?.settings?.overlayMinimized}`;
  }, storageKey)).toBe('full:false');
  await expect.poll(() => overlay.locator('.probe').evaluate((element) => {
    const status = element.querySelector<HTMLElement>('.status');
    const title = element.querySelector<HTMLElement>('.title');
    const author = element.querySelector<HTMLElement>('.author');
    if (!status || !title || !author) return null;
    const original = status.textContent;
    status.textContent = '路由字段冲突';
    const statusBox = status.getBoundingClientRect();
    const contentRight = Math.max(title.getBoundingClientRect().right, author.getBoundingClientRect().right);
    const probeBox = element.getBoundingClientRect();
    const statusFullyVisible = status.scrollWidth <= status.clientWidth;
    status.textContent = original;
    return {
      contained: probeBox.left >= 0 && probeBox.right <= window.innerWidth,
      noBrandOverlap: contentRight <= statusBox.left,
      noHorizontalOverflow: element.scrollWidth <= element.clientWidth,
      statusFullyVisible
    };
  })).toEqual({ contained: true, noBrandOverlap: true, noHorizontalOverflow: true, statusFullyVisible: true });
  if (regularViewport) await page.setViewportSize(regularViewport);

  const untouchedTab = await context.newPage();
  await untouchedTab.goto('http://127.0.0.1:43996/');
  const untouchedOverlayHost = untouchedTab.locator('#chatgpt-route-inspector-root');
  const untouchedOverlay = await untouchedOverlayHost.evaluate((element) => element.shadowRoot?.textContent ?? '');
  expect(untouchedOverlay).toContain('等待下一次回答');
  expect(untouchedOverlay).not.toContain('检测到路由错配');
  await expect.poll(() => untouchedOverlayHost.evaluate((element) => {
    const status = element.shadowRoot?.querySelector<HTMLElement>('.status');
    if (!status) return null;
    const style = getComputedStyle(status);
    return {
      fits: status.scrollWidth <= status.clientWidth,
      singleLine: status.getBoundingClientRect().height <= Number.parseFloat(style.lineHeight) * 1.1,
      textAlign: style.textAlign,
      whiteSpace: style.whiteSpace
    };
  })).toEqual({ fits: true, singleLine: true, textAlign: 'right', whiteSpace: 'nowrap' });

  await overlay.locator('#mode-reload').click();
  await expect.poll(async () => worker.evaluate(async (key) => {
    const state = (await chrome.storage.local.get(key))[key] as { settings?: { captureMode?: string } } | undefined;
    return state?.settings?.captureMode ?? 'missing';
  }, storageKey)).toBe('reload');
  await expect.poll(async () => overlay.evaluate((element) => element.shadowRoot?.textContent ?? ''))
    .toContain('等待刷新会话');
  await expect.poll(() => overlay.evaluate((element) => {
    const hint = element.shadowRoot?.querySelector<HTMLElement>('.hint');
    if (!hint) return null;
    const style = getComputedStyle(hint);
    return {
      fits: hint.scrollWidth <= hint.clientWidth,
      singleLine: hint.getBoundingClientRect().height <= Number.parseFloat(style.lineHeight) * 1.1,
      text: hint.textContent,
      whiteSpace: style.whiteSpace
    };
  })).toEqual({ fits: true, singleLine: true, text: '刷新当前会话，读取响应路由。', whiteSpace: 'nowrap' });

  const domFallbackTab = await context.newPage();
  await domFallbackTab.goto('http://127.0.0.1:43996/c/dom-only-conversation');
  await domFallbackTab.evaluate(() => localStorage.setItem('route-fixture-dom-only', '1'));
  await domFallbackTab.reload();
  await expect.poll(async () => worker.evaluate(async (key) => {
    const state = (await chrome.storage.local.get(key))[key] as {
      turns?: Array<{ captureMode?: string; routeModel?: string | null; modelLabel?: string | null; sources?: string[] }>;
    } | undefined;
    const fallback = state?.turns?.find((turn) => turn.captureMode === 'reload' && turn.sources?.includes('assistant_dom'));
    return fallback ? `${fallback.routeModel}:${fallback.modelLabel}` : 'missing';
  }, storageKey)).toBe('gpt-5-6-pro:gpt-5-6-pro');
  await domFallbackTab.close();

  const projectReloadTab = await context.newPage();
  await projectReloadTab.goto('http://127.0.0.1:43996/g/g-p-e2e-project/c/e2e-conversation');
  await projectReloadTab.evaluate(() => localStorage.setItem('route-fixture-reload', '1'));
  await projectReloadTab.reload();
  const projectOverlay = projectReloadTab.locator('#chatgpt-route-inspector-root');
  await expect(projectOverlay).toHaveCount(1);
  await expect.poll(() => projectOverlay.evaluate((element) => element.shadowRoot?.textContent ?? ''))
    .toContain('路由字段冲突');
  await expect.poll(() => projectOverlay.evaluate((element) => element.shadowRoot?.textContent ?? ''))
    .toContain('resolved_model_slug');
  await projectReloadTab.close();

  await page.evaluate(() => localStorage.setItem('route-fixture-reload', '1'));
  await page.reload();
  await expect(overlay).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => window.fetch.name)).toBe('routeInspectorFetch');
  await expect.poll(async () => worker.evaluate(async (key) => {
    const state = (await chrome.storage.local.get(key))[key] as {
      turns?: Array<{ captureMode?: string; routeModel?: string | null; modelLabel?: string | null; verdict?: string; sources?: string[] }>;
    } | undefined;
    const reload = state?.turns?.find((turn) => turn.captureMode === 'reload');
    return reload ? `${reload.routeModel}:${reload.modelLabel}:${reload.verdict}:${reload.sources?.join('+')}` : 'missing';
  }, storageKey)).toBe('null:gpt-5-6-pro:conflict:conversation_record');
  await page.waitForTimeout(1400);
  expect(await worker.evaluate(async (key) => {
    const state = (await chrome.storage.local.get(key))[key] as {
      turns?: Array<{ captureMode?: string; sources?: string[] }>;
    } | undefined;
    const reload = state?.turns?.filter((turn) => turn.captureMode === 'reload') ?? [];
    return {
      latest: reload[0]?.sources?.join('+') ?? null,
      domFallbackCount: reload.filter((turn) => turn.sources?.includes('assistant_dom')).length
    };
  }, storageKey)).toEqual({ latest: 'conversation_record', domFallbackCount: 1 });

  overlayText = await overlay.evaluate((element) => element.shadowRoot?.textContent ?? '');
  expect(overlayText).toContain('路由字段冲突');
  expect(overlayText).toContain('重载不提供');
  expect(overlayText).toContain('resolved_model_slug');
  expect(overlayText).toContain('gpt-5-6-pro');

  stored = await worker.evaluate(async (key) => JSON.stringify((await chrome.storage.local.get(key))[key]), storageKey);
  expect(stored).not.toMatch(/PRIVATE_USER_TEXT|PRIVATE_ASSISTANT_TEXT|confidence|effectiveModel/i);
  const counts = await worker.evaluate(async (key) => {
    const state = (await chrome.storage.local.get(key))[key] as { turns?: Array<{ captureMode?: string }> } | undefined;
    return {
      live: state?.turns?.filter((turn) => turn.captureMode === 'live').length ?? 0,
      reload: state?.turns?.filter((turn) => turn.captureMode === 'reload').length ?? 0
    };
  }, storageKey);
  expect(counts.live).toBe(1);
  expect(counts.reload).toBeGreaterThan(0);

  const dashboard = await context.newPage();
  await dashboard.setViewportSize({ width: 2048, height: 1200 });
  await dashboard.goto(`chrome-extension://${extensionId}/ui/dashboard/index.html`);
  await expect(dashboard.getByText('路由诊断台')).toBeVisible();
  await expect(dashboard.getByText('实时请求').first()).toBeVisible();
  await expect(dashboard.getByText('会话重载').first()).toBeVisible();
  await expect(dashboard.getByText('GPT 5.6 Pro').first()).toBeVisible();
  await expect.poll(() => dashboard.evaluate(() => {
    const left = document.querySelector<HTMLElement>('.dashboard-grid > .column');
    const right = document.querySelector<HTMLElement>('.dashboard-grid > aside');
    const scroller = document.querySelector<HTMLElement>('.table-scroll');
    if (!left || !right || !scroller) return null;
    const leftBox = left.getBoundingClientRect();
    const rightBox = right.getBoundingClientRect();
    const scrollerBox = scroller.getBoundingClientRect();
    const shellBox = document.querySelector<HTMLElement>('.dashboard-shell')?.getBoundingClientRect();
    return {
      columnsSeparated: leftBox.right <= rightBox.left,
      scrollerContained: scrollerBox.right <= rightBox.left,
      overflowX: getComputedStyle(scroller).overflowX,
      pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
      shellWidth: Math.round(shellBox?.width ?? 0)
    };
  })).toEqual({ columnsSeparated: true, scrollerContained: true, overflowX: 'auto', pageOverflow: false, shellWidth: 1600 });
  await expect(dashboard.locator('#detail .notice')).toHaveCount(0);
  await expect(dashboard.getByText('工具名称', { exact: true })).toHaveCount(0);
  await dashboard.screenshot({ path: path.join(root, 'output', 'playwright', 'dashboard-e2e.png'), fullPage: true });

  const popup = await context.newPage();
  await popup.setViewportSize({ width: 640, height: 600 });
  await popup.goto(`chrome-extension://${extensionId}/ui/popup/index.html`);
  await expect(popup.locator('.route-model strong')).toHaveText(['—', '—']);
  await expect(popup.locator('#pow-hex')).toHaveText('未捕获');
  await expect(popup.getByText('GPT 5.6 Pro')).toHaveCount(0);

  // A real action popup reads the underlying active tab. This test page is an ordinary
  // extension tab, so bring the ChatGPT fixture back to the foreground before reloading it.
  await page.bringToFront();
  await popup.reload();
  await expect(popup.locator('.route-model strong').last()).toHaveText('路由字段冲突');
  await expect(popup.locator('.verdict-line b')).toHaveText('路由字段冲突');
  await expect(popup.getByText('重载不提供')).toBeVisible();
  await expect(popup.getByText('会话重载').first()).toBeVisible();
  await expect(popup.locator('#pow-hex')).toHaveText('063556');
  await expect(popup.locator('#pow-decimal')).toHaveText('406870');
  await expect(popup.locator('#footer-machine')).toBeVisible();
  await expect(popup.locator('.toast')).toHaveCount(0);
  await expect(popup.locator('#mode-hint')).toHaveText('刷新当前会话，读取响应路由。');
  await expect.poll(() => popup.locator('#mode-hint').evaluate((hint) => {
    const style = getComputedStyle(hint);
    return {
      fits: hint.scrollWidth <= hint.clientWidth,
      singleLine: hint.getBoundingClientRect().height <= Number.parseFloat(style.lineHeight) * 1.1,
      whiteSpace: style.whiteSpace
    };
  })).toEqual({ fits: true, singleLine: true, whiteSpace: 'nowrap' });
  const secondaryButtonStyles = await popup.evaluate(() => {
    const copy = getComputedStyle(document.querySelector<HTMLElement>('#copy')!);
    const options = getComputedStyle(document.querySelector<HTMLElement>('#options')!);
    return {
      copy: [copy.backgroundColor, copy.borderColor, copy.color],
      options: [options.backgroundColor, options.borderColor, options.color]
    };
  });
  expect(secondaryButtonStyles.options).toEqual(secondaryButtonStyles.copy);
  await expect(popup.getByText('本地 / 自动')).toHaveCount(0);
  await expect.poll(() => popup.evaluate(() => {
    const buttons = document.querySelector<HTMLElement>('.button-stack')!.getBoundingClientRect();
    const pow = document.querySelector<HTMLElement>('.pow-readout')!.getBoundingClientRect();
    const footer = document.querySelector<HTMLElement>('.footer-link')!.getBoundingClientRect();
    const status = document.querySelector<HTMLElement>('#footer-machine')!.getBoundingClientRect();
    const records = document.querySelector<HTMLElement>('#record-count')!.getBoundingClientRect();
    return {
      footerAtBottom: Math.abs(window.innerHeight - footer.bottom) <= 1,
      powCenteredInGap: Math.abs((pow.top - buttons.bottom) - (footer.top - pow.bottom)) <= 1,
      recordsAtRight: Math.abs(records.right - (window.innerWidth - 17)) <= 1,
      statusAtLeft: Math.abs(status.left - 17) <= 1
    };
  })).toEqual({ footerAtBottom: true, powCenteredInGap: true, recordsAtRight: true, statusAtLeft: true });
  await expectPopupFits(popup);
  await overlay.locator('#hide').click();
  await expect(overlay).toHaveCount(0);
  await expect(popup.locator('#overlay-hide')).toHaveClass(/active/);
  await popup.locator('#overlay-show').click();
  await expect(overlay).toHaveCount(1);
  await expect(popup.locator('#overlay-show')).toHaveClass(/active/);
  await expect.poll(async () => worker.evaluate(async (key) => {
    const current = (await chrome.storage.local.get(key))[key] as {
      settings?: { overlayEnabled?: boolean; overlayMinimized?: boolean };
    } | undefined;
    return `${current?.settings?.overlayEnabled}:${current?.settings?.overlayMinimized}`;
  }, storageKey)).toBe('true:false');
  await popup.screenshot({ path: path.join(root, 'output', 'playwright', 'popup-e2e.png'), fullPage: true });

  await page.evaluate(() => {
    history.pushState({}, '', '/c/spa-conversation-b');
    const assistant = document.createElement('div');
    assistant.dataset.messageAuthorRole = 'assistant';
    assistant.dataset.messageId = 'spa-conversation-b-message';
    assistant.dataset.messageModelSlug = 'gpt-5-5-instant';
    assistant.textContent = 'PRIVATE_SPA_ASSISTANT_TEXT';
    document.body.append(assistant);
  });
  await expect.poll(async () => worker.evaluate(async (key) => {
    const state = (await chrome.storage.local.get(key))[key] as {
      turns?: Array<{
        captureMode?: string;
        conversationId?: string | null;
        routeModel?: string | null;
        modelLabel?: string | null;
        sources?: string[];
      }>;
    } | undefined;
    const spaTurn = state?.turns?.find((turn) =>
      turn.captureMode === 'reload' && turn.conversationId === 'spa-conversation-b'
    );
    return spaTurn
      ? `${spaTurn.routeModel}:${spaTurn.modelLabel}:${spaTurn.sources?.join('+')}`
      : 'missing';
  }, storageKey)).toBe('gpt-5-5-instant:gpt-5-5-instant:assistant_dom');
  expect(await worker.evaluate(async (key) => {
    const state = (await chrome.storage.local.get(key))[key] as {
      turns: Array<{ conversationId: string; modelLabel: string }>;
    };
    return state.turns.filter((turn) => turn.conversationId === 'spa-conversation-b').map((turn) => turn.modelLabel);
  }, storageKey)).toEqual(['gpt-5-5-instant']);
  overlayText = await overlay.evaluate((element) => element.shadowRoot?.textContent ?? '');
  expect(overlayText).toContain('已读取响应路由');
  expect(overlayText).toContain('gpt-5-5-instant');
  expect(overlayText).not.toContain('gpt-5-5-mini');

  stored = await worker.evaluate(async (key) => JSON.stringify((await chrome.storage.local.get(key))[key]), storageKey);
  expect(stored).not.toContain('PRIVATE_SPA_ASSISTANT_TEXT');

  const reloadOverlayRouteGeometry = await overlay.evaluate((element) => {
    const route = element.shadowRoot?.querySelector<HTMLElement>('.route');
    const values = [...(element.shadowRoot?.querySelectorAll<HTMLElement>('.model b') ?? [])];
    return {
      routeHeight: route?.getBoundingClientRect().height ?? 0,
      valueHeights: values.map((value) => value.getBoundingClientRect().height)
    };
  });
  const reloadPopupGeometry = await popup.evaluate(() => ({
    resultHeight: document.querySelector<HTMLElement>('.popup-result-grid')?.getBoundingClientRect().height ?? 0,
    heroHeight: document.querySelector<HTMLElement>('.hero-readout')?.getBoundingClientRect().height ?? 0,
    lockupHeight: document.querySelector<HTMLElement>('.route-lockup')?.getBoundingClientRect().height ?? 0,
    valueHeights: [...document.querySelectorAll<HTMLElement>('.route-model strong')].map((value) => value.getBoundingClientRect().height)
  }));
  await popup.locator('#mode-live').click();
  await expect(popup.locator('#mode-live')).toHaveClass(/active/);
  const liveOverlayRouteGeometry = await overlay.evaluate((element) => {
    const route = element.shadowRoot?.querySelector<HTMLElement>('.route');
    const values = [...(element.shadowRoot?.querySelectorAll<HTMLElement>('.model b') ?? [])];
    return {
      routeHeight: route?.getBoundingClientRect().height ?? 0,
      valueHeights: values.map((value) => value.getBoundingClientRect().height)
    };
  });
  const livePopupGeometry = await popup.evaluate(() => ({
    resultHeight: document.querySelector<HTMLElement>('.popup-result-grid')?.getBoundingClientRect().height ?? 0,
    heroHeight: document.querySelector<HTMLElement>('.hero-readout')?.getBoundingClientRect().height ?? 0,
    lockupHeight: document.querySelector<HTMLElement>('.route-lockup')?.getBoundingClientRect().height ?? 0,
    valueHeights: [...document.querySelectorAll<HTMLElement>('.route-model strong')].map((value) => value.getBoundingClientRect().height)
  }));
  expect(liveOverlayRouteGeometry).toEqual(reloadOverlayRouteGeometry);
  expect(reloadOverlayRouteGeometry).toEqual({ routeHeight: 64, valueHeights: [18, 18] });
  expect(livePopupGeometry).toEqual(reloadPopupGeometry);
  expect(reloadPopupGeometry.resultHeight).toBe(156);
  expect(Math.abs(reloadPopupGeometry.heroHeight - 156)).toBeLessThan(1);
  expect(reloadPopupGeometry.lockupHeight).toBe(37);
  expect(reloadPopupGeometry.valueHeights).toEqual([21, 21]);
  await popup.locator('#mode-reload').click();
  await expect(popup.locator('#mode-reload')).toHaveClass(/active/);

  await popup.locator('[data-language="en"]').click();
  await expect(popup.locator('html')).toHaveAttribute('lang', 'en');
  await expect(popup.getByText('Route captured')).toBeVisible();
  await expect(dashboard.getByText('Route diagnostics')).toBeVisible();
  await expect.poll(async () => overlay.evaluate((element) => element.shadowRoot?.textContent ?? ''))
    .toContain('Route captured');
  await expect.poll(async () => untouchedOverlayHost.evaluate((element) => element.shadowRoot?.textContent ?? ''))
    .toContain('Awaiting reload');
  const englishRegularViewport = page.viewportSize();
  await page.setViewportSize({ width: 360, height: 640 });
  const englishOverlayLayout = await overlay.evaluate((element, labels) => {
    const status = element.shadowRoot?.querySelector<HTMLElement>('.status');
    const title = element.shadowRoot?.querySelector<HTMLElement>('.title');
    const author = element.shadowRoot?.querySelector<HTMLElement>('.author');
    const compact = element.shadowRoot?.querySelector<HTMLElement>('#compact');
    const probe = element.shadowRoot?.querySelector<HTMLElement>('.probe');
    const hint = element.shadowRoot?.querySelector<HTMLElement>('.hint');
    if (!status || !title || !author || !compact || !probe || !hint) return null;
    const original = status.textContent;
    const cases = labels.map((label) => {
      status.textContent = label;
      const statusBox = status.getBoundingClientRect();
      const statusStyle = getComputedStyle(status);
      const contentRight = Math.max(title.getBoundingClientRect().right, author.getBoundingClientRect().right);
      return {
        fullyVisible: status.scrollWidth <= status.clientWidth,
        label,
        lines: Math.round(statusBox.height / Number.parseFloat(statusStyle.lineHeight)),
        noBrandOverlap: contentRight <= statusBox.left,
        noButtonOverlap: statusBox.right <= compact.getBoundingClientRect().left
      };
    });
    status.textContent = original;
    const hintBox = hint.getBoundingClientRect();
    const probeBox = probe.getBoundingClientRect();
    return {
      cases,
      hintContained: hintBox.left >= probeBox.left && hintBox.right <= probeBox.right && hint.scrollWidth <= hint.clientWidth,
      lang: probe.lang,
      noHorizontalOverflow: probe.scrollWidth <= probe.clientWidth,
      textAlign: getComputedStyle(status).textAlign,
      whiteSpace: getComputedStyle(status).whiteSpace
    };
  }, [
    'Awaiting answer',
    'Awaiting reload',
    'Route normal',
    'Route mismatch',
    'Route conflict',
    'Route captured',
    'Label only',
    'Route missing',
    'Capturing'
  ]);
  expect(englishOverlayLayout).not.toBeNull();
  expect(englishOverlayLayout?.lang).toBe('en');
  expect(englishOverlayLayout?.textAlign).toBe('right');
  expect(englishOverlayLayout?.whiteSpace).toBe('nowrap');
  expect(englishOverlayLayout?.hintContained).toBe(true);
  expect(englishOverlayLayout?.noHorizontalOverflow).toBe(true);
  expect(englishOverlayLayout?.cases.filter((entry) =>
    !entry.fullyVisible || entry.lines !== 1 || !entry.noBrandOverlap || !entry.noButtonOverlap
  )).toEqual([]);
  await expect(overlay.locator('.full-pow > span')).toHaveText('POW');
  await expect.poll(() => overlay.locator('.full-pow > span').evaluate((label) => {
    const range = document.createRange();
    range.selectNodeContents(label);
    return { lines: range.getClientRects().length, whiteSpace: getComputedStyle(label).whiteSpace };
  })).toEqual({ lines: 1, whiteSpace: 'nowrap' });
  await page.screenshot({ path: path.join(root, 'output', 'playwright', 'overlay-english-narrow-e2e.png'), fullPage: true });
  if (englishRegularViewport) await page.setViewportSize(englishRegularViewport);
  await page.screenshot({ path: path.join(root, 'output', 'playwright', 'overlay-english-e2e.png'), fullPage: true });
  await untouchedTab.screenshot({ path: path.join(root, 'output', 'playwright', 'overlay-english-awaiting-reload-e2e.png'), fullPage: true });
  await expectPopupFits(popup);

  await popup.locator('#mode-live').click();
  await expect(popup.locator('#footer-status')).toHaveText('Switched: Live request');
  await expect(popup.locator('.route-model strong').last()).toHaveText('Route conflict');
  await expect(popup.locator('.verdict-line b')).toHaveText('Route conflict');
  const adapterValue = popup.getByText('page_fetch+page_websocket');
  await expect(adapterValue).toBeVisible();
  await expect.poll(() => adapterValue.evaluate((element) => ({
    singleLine: element.getBoundingClientRect().height <= Number.parseFloat(getComputedStyle(element).lineHeight) * 1.1,
    fullyVisible: element.scrollWidth <= element.clientWidth
  }))).toEqual({ singleLine: true, fullyVisible: true });
  await expectPopupFits(popup);

  const options = await context.newPage();
  await options.setViewportSize({ width: 1600, height: 900 });
  await options.goto(`chrome-extension://${extensionId}/ui/options/index.html`);
  await expect(options.getByText('Settings & privacy').first()).toBeVisible();
  await expect(options.getByText('Configuration', { exact: true })).toHaveCount(0);
  await expect(options.locator('#mode')).toHaveCount(0);
  await expect(options.getByText('Automatic capture', { exact: true })).toBeVisible();
  await expect(options.getByText('Route records stay on this device. Request IDs are redacted by default when exported.', { exact: true })).toBeVisible();
  await expect(options.locator('.author-link')).toHaveAttribute('href', 'https://blog.liu-qi.cn/tools/');
  await expect.poll(() => options.evaluate(() => ({
    shellWidth: Math.round(document.querySelector<HTMLElement>('.options-shell')?.getBoundingClientRect().width ?? 0),
    pageOverflow: document.documentElement.scrollWidth > window.innerWidth
  }))).toEqual({ shellWidth: 1040, pageOverflow: false });
  await options.locator('[data-language="zh"]').click();
  await expect(options.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(options.getByText('设置与隐私', { exact: true })).toBeVisible();
  await expect(options.getByText('配置', { exact: true })).toHaveCount(0);
  await expect(options.locator('#mode')).toHaveCount(0);
  await options.locator('[data-language="en"]').click();
  await expect(options.locator('html')).toHaveAttribute('lang', 'en');

  const onboarding = await context.newPage();
  await onboarding.goto(`chrome-extension://${extensionId}/ui/onboarding/index.html`);
  await expect(onboarding.getByText('See the route reported by the response.')).toBeVisible();
  await expect(onboarding.locator('.author-link')).toHaveText('Created by @liuqi');
  await popup.screenshot({ path: path.join(root, 'output', 'playwright', 'popup-en-e2e.png'), fullPage: true });
  await dashboard.screenshot({ path: path.join(root, 'output', 'playwright', 'dashboard-en-e2e.png'), fullPage: true });
  await options.screenshot({ path: path.join(root, 'output', 'playwright', 'options-en-e2e.png'), fullPage: true });
  await onboarding.screenshot({ path: path.join(root, 'output', 'playwright', 'onboarding-en-e2e.png'), fullPage: true });
  await page.screenshot({ path: path.join(root, 'output', 'playwright', 'overlay-en-e2e.png'), fullPage: true });

  const language = await worker.evaluate(async (key) => {
    const current = (await chrome.storage.local.get(key))[key] as { settings?: { uiLanguage?: string } } | undefined;
    return current?.settings?.uiLanguage ?? 'missing';
  }, storageKey);
  expect(language).toBe('en');
});

test('restores a detached overlay host while respecting manual hide', async () => {
  const page = await context.newPage();
  await page.routeWebSocket('ws://127.0.0.1:43996/backend-api/ws', (socket) => {
    socket.onMessage((message) => {
      if (message === 'emit-route') socket.send(webSocketFrame);
    });
  });
  await page.goto('http://127.0.0.1:43996/c/overlay-lifecycle');

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/ui/popup/index.html`);
  await popup.locator('#mode-live').click();
  await popup.locator('#overlay-show').click();

  const overlay = page.locator('#chatgpt-route-inspector-root');
  await expect(overlay).toHaveCount(1);

  async function runLiveFixture(): Promise<void> {
    const before = await worker.evaluate(async (key) => {
      const current = (await chrome.storage.local.get(key))[key] as {
        turns?: Array<{ captureMode?: string }>;
      } | undefined;
      return current?.turns?.filter((turn) => turn.captureMode === 'live').length ?? 0;
    }, storageKey);
    await page.locator('#done').evaluate((element) => { element.textContent = ''; });
    await page.locator('#ask').click();
    await expect(page.locator('#done')).toHaveText('data: [DONE]');
    await expect.poll(() => worker.evaluate(async ({ key, previous }) => {
      const current = (await chrome.storage.local.get(key))[key] as {
        turns?: Array<{ captureMode?: string }>;
      } | undefined;
      return (current?.turns?.filter((turn) => turn.captureMode === 'live').length ?? 0) > previous;
    }, { key: storageKey, previous: before })).toBe(true);
  }

  await popup.locator('#overlay-hide').click();
  await expect(overlay).toHaveCount(0);
  await runLiveFixture();
  await expect(overlay).toHaveCount(0);

  await popup.locator('#overlay-show').click();
  await expect(overlay).toHaveCount(1);
  const removed = await page.evaluate(() => {
    const element = document.getElementById('chatgpt-route-inspector-root');
    if (!element) return false;
    element.remove();
    return true;
  });
  expect(removed).toBe(true);

  await expect(overlay).toHaveCount(1);
  await runLiveFixture();
  await expect(overlay).toHaveCount(1);
});

test('captures delta metadata through real fetch chunks and interleaved WebSocket frames', async () => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/ui/popup/index.html`);
  await popup.locator('#mode-live').click();
  await popup.locator('#overlay-show').click();
  const page = await context.newPage();
  const frames: string[] = [];
  await page.routeWebSocket('ws://127.0.0.1:43996/delta-ws', (socket) => {
    let index = 0;
    socket.onMessage(() => { if (index < frames.length) socket.send(frames[index++]!); });
  });
  await page.goto('http://127.0.0.1:43996/delta-fixture');

  for (const variant of ['normal', 'missing-resolved', 'conflict']) {
    await page.evaluate(async (variant) => {
      const response = await window.fetch(`/backend-api/f/conversation?delta=${variant}`, {
        method: 'POST', body: JSON.stringify({ model: 'gpt-6-pro', conversation_id: `conv-${variant}` })
      });
      await response.text();
    }, variant);
    await expect.poll(() => worker.evaluate(async ({ key, variant }) => {
      const current = (await chrome.storage.local.get(key))[key] as {
        turns: Array<{ requestId: string; phase: string; responseModelSlug: string; resolvedModelSlug: string | null; serverModelSlug: string; verdict: string }>;
      };
      const turn = current.turns.find((item) => item.requestId === `req-${variant}`);
      return turn && {
        phase: turn.phase, label: turn.responseModelSlug, resolved: turn.resolvedModelSlug,
        server: turn.serverModelSlug, verdict: turn.verdict
      };
    }, { key: storageKey, variant })).toEqual({
      phase: 'completed', label: 'gpt-6-pro', server: 'gpt-6-pro',
      resolved: variant === 'missing-resolved' ? null : variant === 'conflict' ? 'gpt-5-5-mini' : 'gpt-6-pro',
      verdict: variant === 'conflict' ? 'conflict' : 'normal'
    });
  }
  await expect(page.locator('#chatgpt-route-inspector-root')).toContainText('gpt-6-pro');
  await expect(page.locator('#chatgpt-route-inspector-root')).toContainText('assistant.metadata.model_slug');

  const unsupportedResponse = await page.evaluate(async () => {
    const response = await window.fetch('/backend-api/f/conversation?delta=unsupported', {
      method: 'POST', body: JSON.stringify({ model: 'gpt-6-pro', conversation_id: 'conv-unsupported' })
    });
    return response.text();
  });
  expect(unsupportedResponse).toContain('[DONE]');
  await expect.poll(() => worker.evaluate(async (key) => {
    const current = (await chrome.storage.local.get(key))[key] as {
      turns: Array<{ conversationId: string; phase: string; errorCode: string }>;
    };
    const turn = current.turns.find((item) => item.conversationId === 'conv-unsupported');
    return turn && { phase: turn.phase, error: turn.errorCode };
  }, storageKey)).toEqual({ phase: 'failed', error: 'stream_parse_failed' });

  const encode = (topic: string, value: unknown) => JSON.stringify([{
    topic_id: topic, payload: { payload: { encoded_item: `event: delta\ndata: ${JSON.stringify(value)}\n\n` } }
  }]);
  // Subscription and answer use the same topic. The old generic fixture subscribed
  // to topic-private-123456 but sent ws-assistant, relying on missing topic checks.
  await page.route('**/backend-api/conversation', (route) => route.fulfill({
    contentType: 'text/event-stream',
    body: 'data: {"conversation_id":"conv-ws-delta"}\n\n' +
      'data: {"type":"subscribe_ws_topic","topic":"ws-assistant"}\n\n'
  }));
  frames.push(
    encode('wrong-topic', { p: '', o: 'add', v: {
      conversation_id: 'conv-ws-delta', parent_id: 'input-ws-delta', resolved_model_slug: 'wrong-topic-model'
    } }),
    encode('ws-assistant', { p: '', o: 'add', v: {
      message: { author: { role: 'assistant' }, metadata: {} }
    } }),
    encode('ws-user', { p: '', o: 'add', v: {
      message: { id: 'unrelated-user', author: { role: 'user' }, metadata: {} }, conversation_id: 'unrelated-conv'
    } }),
    encode('ws-user', { p: '/message/metadata/model_slug', o: 'add', v: 'untrusted-user-label' }),
    JSON.stringify([{ topic_id: 'ws-assistant', payload: { payload: { encoded_item:
      'data: {"type":"server_ste_metadata","metadata":{"model_slug":"gpt-6-pro","request_id":"req-ws-delta"}}\n\n'
    } } }]),
    encode('ws-assistant', { p: '', o: 'patch', v: [
      { p: '/message/metadata', o: 'append', v: { model_slug: 'gpt-6-pro', resolved_model_slug: 'gpt-6-pro', request_id: 'req-ws-delta' } },
      { p: '/message/content', o: 'add', v: { parts: ['SECRET_DELTA_WS_ANSWER'] } }
    ] }),
    JSON.stringify([{ topic_id: 'ws-assistant', payload: { payload: { encoded_item: 'data: [DONE]\n\n' } } }])
  );
  await page.evaluate(async (frameCount) => {
    await window.fetch('/backend-api/conversation', {
      method: 'POST', body: JSON.stringify({ model: 'gpt-6-pro', conversation_id: null, messages: [{ id: 'input-ws-delta', author: { role: 'user' } }] })
    }).then((response) => response.text());
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket('ws://127.0.0.1:43996/delta-ws');
      let count = 0;
      socket.addEventListener('open', () => socket.send('next'));
      socket.addEventListener('error', reject);
      socket.addEventListener('message', () => {
        if (++count === frameCount) { socket.close(); resolve(); }
        else socket.send('next');
      });
    });
  }, frames.length);
  await expect.poll(() => worker.evaluate(async (key) => {
    const current = (await chrome.storage.local.get(key))[key] as {
      turns: Array<{ requestId: string; responseModelSlug: string; resolvedModelSlug: string; conversationId: string; phase: string; verdict: string; sources: string[] }>;
    };
    const turn = current.turns.find((item) => item.requestId === 'req-ws-delta');
    return turn && { label: turn.responseModelSlug, resolved: turn.resolvedModelSlug, conversation: turn.conversationId,
      phase: turn.phase, verdict: turn.verdict, sources: turn.sources };
  }, storageKey)).toEqual({ label: 'gpt-6-pro', resolved: 'gpt-6-pro', conversation: 'conv-ws-delta',
    phase: 'completed', verdict: 'normal', sources: ['page_fetch', 'page_websocket'] });
  const stored = await worker.evaluate(async (key) => JSON.stringify((await chrome.storage.local.get(key))[key]), storageKey);
  expect(stored).not.toMatch(/SECRET_DELTA|untrusted-user-label|wrong-topic-model|ws-assistant/);
  await page.close();
  await popup.close();
});

test('aligns diagnostic evidence fields without adding PoW', async () => {
  const dashboard = await context.newPage();
  await dashboard.setViewportSize({ width: 1600, height: 1100 });
  await dashboard.goto(`chrome-extension://${extensionId}/ui/dashboard/index.html`);
  await dashboard.evaluate(async () => {
    await chrome.runtime.sendMessage({ type: 'route:update-settings', settings: { uiLanguage: 'zh' } });
    await chrome.runtime.sendMessage({ type: 'route:clear' });
  });
  const evidence = (name: string) => dashboard.locator('#detail .evidence').filter({ has: dashboard.locator('small', { hasText: name }) }).locator('code');
  for (const [phase, label] of [['requested', '已发起请求'], ['responding', '响应中'], ['completed', '已完成'], ['failed', '捕获失败']] as const) {
    await dashboard.evaluate(async (phase) => {
      const time = new Date(Date.now() + 1000).toISOString();
      await chrome.runtime.sendMessage({ type: 'route:clear' });
      await chrome.runtime.sendMessage({ type: 'route:observation', observation: {
        captureId: `detail-${phase}`, source: 'page_fetch', captureMode: 'live', phase, observedAt: time, startedAt: time,
        requestedModel: 'gpt-test', ...(phase === 'failed' ? { errorCode: 'http_403' } : {})
      } });
    }, phase);
    await expect(evidence('捕获状态')).toHaveText(label);
    await expect(evidence('请求模型')).toHaveText('gpt-test');
    await expect(evidence('深度研究剩余额度')).toHaveText('未捕获');
    await expect(evidence('图片生成重置时间')).toHaveText('未捕获');
    await expect(dashboard.locator('#detail .evidence-note')).toHaveCount(0);
    if (phase === 'failed') await expect(evidence('错误码')).toHaveText('http_403');
    else await expect(evidence('错误码')).toHaveCount(0);
  }
  await dashboard.evaluate(async () => {
    const time = new Date(Date.now() + 1000).toISOString();
    await chrome.runtime.sendMessage({ type: 'route:clear' });
    await chrome.runtime.sendMessage({ type: 'route:observation', observation: {
      captureId: 'detail-conflict', source: 'page_fetch', captureMode: 'live', phase: 'completed', observedAt: time, startedAt: time,
      requestedModel: 'gpt-pro', resolvedModelSlug: 'gpt-pro', serverModelSlug: 'gpt-mini',
      responseModelSlug: 'gpt-pro', domModelSlug: 'gpt-pro', planType: 'pro', thinkingEffort: 'max', fastConvo: true,
      requestId: 'detail-request'
    } });
  });
  await expect(evidence('响应路由')).toHaveText('路由字段冲突');
  await expect(dashboard.locator('#detail .evidence small')).toHaveText([
    '捕获模式', '捕获状态',
    '请求模型', '响应路由', '响应来源', '解析模型', '服务端模型', '回答模型标签', '回答标签来源',
    '页面模型标签', '思考强度', '快速会话', '套餐类型',
    '深度研究剩余额度', '深度研究重置时间', '图片生成剩余额度', '图片生成重置时间', '请求 ID', '耗时', '捕获来源'
  ]);
  await expect(evidence('回答标签来源')).toHaveText('assistant.metadata.model_slug');
  await expect(evidence('请求模型')).toHaveText('gpt-pro');
  const referenceNote = dashboard.locator('#detail .evidence-note');
  await expect(referenceNote).toHaveText('*');
  await expect(dashboard.locator('#detail')).not.toContainText('仅供参考');
  expect(await referenceNote.evaluate((element) => getComputedStyle(element).borderTopWidth)).toBe('0px');
  await referenceNote.hover();
  await expect(referenceNote).toHaveAttribute('title', /assistant\.metadata\.model_slug\n回答元数据中的模型标签，不保证与实际执行模型一致/);
  await referenceNote.locator('..').locator('..').screenshot({ path: path.join(root, 'output', 'playwright', 'dashboard-label-asterisk.png') });
  await expect(evidence('套餐类型')).toHaveText('pro');
  await expect(evidence('思考强度')).toHaveText('max');
  await expect(evidence('快速会话')).toHaveText('true');
  await expect(dashboard.locator('#detail small').filter({ hasText: /^模型标签$/ })).toHaveCount(0);
  const fieldLabels = [
    ['resolved_model_slug', '解析模型', 'Resolved model'],
    ['server_ste_metadata.model_slug', '服务端模型', 'Server model'],
    ['assistant.metadata.model_slug', '回答模型标签', 'Assistant model label'],
    ['assistant[data-message-model-slug]', '页面模型标签', 'Page model label']
  ] as const;
  for (const [field, chinese] of fieldLabels) {
    const label = dashboard.locator('#detail .evidence small').filter({ hasText: chinese });
    await expect(label).toHaveText(chinese);
    await label.hover();
    if (field === 'assistant.metadata.model_slug') await expect(label).toHaveAttribute('title', await referenceNote.getAttribute('title') ?? '');
    else await expect(label).toHaveAttribute('title', field);
  }
  await expect(dashboard.locator('#detail')).not.toContainText(/PoW|工具名称/i);
  await dashboard.screenshot({ path: path.join(root, 'output', 'playwright', 'dashboard-evidence-aligned-zh.png'), fullPage: true });
  await dashboard.locator('#detail').screenshot({ path: path.join(root, 'output', 'playwright', 'dashboard-evidence-reference-zh.png') });
  await dashboard.evaluate(async () => chrome.runtime.sendMessage({ type: 'route:update-settings', settings: { uiLanguage: 'en' } }));
  await expect(evidence('Capture status')).toHaveText('Completed');
  await expect(evidence('Response route')).toHaveText('Route conflict');
  await expect(evidence('Assistant label source')).toHaveText('assistant.metadata.model_slug');
  await expect(evidence('Requested model')).toHaveText('gpt-pro');
  await expect(referenceNote).toHaveText('*');
  await expect(dashboard.locator('#detail')).not.toContainText('Reference only');
  await expect(referenceNote).toHaveAttribute('title', /does not guarantee the model that actually executed/);
  await expect(dashboard.locator('#detail small').filter({ hasText: /^Model label$/ })).toHaveCount(0);
  for (const [field, , english] of fieldLabels) {
    const label = dashboard.locator('#detail .evidence small').filter({ hasText: english });
    await expect(label).toHaveText(english);
    if (field !== 'assistant.metadata.model_slug') await expect(label).toHaveAttribute('title', field);
  }
  await expect(dashboard.locator('#detail')).not.toContainText(/[\u4e00-\u9fff]/);
  expect(await dashboard.locator('#detail .evidence small').evaluateAll((labels) => labels.every((label) =>
    label.scrollWidth <= label.clientWidth + 1 && getComputedStyle(label).textTransform === 'none'
  ))).toBe(true);
  expect(await dashboard.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await dashboard.screenshot({ path: path.join(root, 'output', 'playwright', 'dashboard-evidence-aligned-en.png'), fullPage: true });
  await dashboard.close();
});

test('shows only GPT-5.6 and GPT-5.5 auto reasoning in the dashboard, popup and overlay', async () => {
  const dashboard = await context.newPage();
  await dashboard.setViewportSize({ width: 1600, height: 1150 });
  await dashboard.goto(`chrome-extension://${extensionId}/ui/dashboard/index.html`);
  await dashboard.evaluate(async () => {
    await chrome.runtime.sendMessage({ type: 'route:update-settings', settings: {
      uiLanguage: 'zh', captureMode: 'live', autoCaptureEnabled: true, overlayEnabled: true, overlayMode: 'full'
    } });
    await chrome.runtime.sendMessage({ type: 'route:clear' });
  });
  const samples = [
    { id: 'auto-55', requested: 'gpt-5-5', route: 'gpt-5-5-auto-thinking', label: 'gpt-5-5-thinking', verdict: 'auto_reasoning' },
    { id: 'auto-54', requested: 'gpt-5-6', route: 'gpt-5-4-auto-thinking', label: null, verdict: 'mismatch' },
    { id: 'auto-54-conflict', requested: 'gpt-5-6', route: 'gpt-5-4-auto-thinking', label: 'gpt-5-6-thinking', verdict: 'conflict' },
    { id: 'normal', requested: 'gpt-5-6-thinking', route: 'gpt-5-6-thinking', label: 'gpt-5-6-thinking', verdict: 'normal' },
    { id: 'auto-56', requested: 'gpt-5-6', route: 'gpt-5-6-auto-thinking', label: 'gpt-5-6-thinking', verdict: 'auto_reasoning' }
  ];
  const page = await context.newPage();
  await page.route('**/backend-api/f/conversation?auto-case=*', (route) => {
    const id = new URL(route.request().url()).searchParams.get('auto-case');
    const sample = samples.find((item) => item.id === id)!;
    const body = [
      { conversation_id: `preview-${id}`, message: { author: { role: 'assistant' }, metadata: { model_slug: sample.label } } },
      { type: 'server_ste_metadata', metadata: { model_slug: sample.route, resolved_model_slug: sample.route, request_id: `preview-${id}`, plan_type: 'plus', fast_convo: true } }
    ].map((item) => `data: ${JSON.stringify(item)}\n\n`).join('') + 'data: [DONE]\n\n';
    return route.fulfill({ contentType: 'text/event-stream', body });
  });
  await page.goto('http://127.0.0.1:43996/delta-fixture');
  const overlay = page.locator('#chatgpt-route-inspector-root');
  await expect(overlay).toHaveCount(1);
  for (const sample of samples) {
    await page.evaluate(async (sample) => {
      await window.fetch(`/backend-api/f/conversation?auto-case=${sample.id}`, {
        method: 'POST', body: JSON.stringify({ model: sample.requested, conversation_id: `preview-${sample.id}` })
      }).then((response) => response.text());
    }, sample);
    await expect.poll(() => worker.evaluate(async ({ key, id }) => {
      const state = (await chrome.storage.local.get(key))[key];
      return state.turns.find((turn: { requestId: string }) => turn.requestId === `preview-${id}`)?.verdict;
    }, { key: storageKey, id: sample.id })).toBe(sample.verdict);
  }
  await expect(overlay.locator('.status')).toHaveText('自动推理');
  expect(await overlay.locator('.status').evaluate((item) => getComputedStyle(item).color)).toBe('rgb(117, 197, 216)');
  await overlay.locator('.probe').screenshot({ path: path.join(root, 'output', 'playwright', 'auto-reasoning-overlay-zh.png') });
  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({})).find((tab) => tab.url?.endsWith('/delta-fixture'))!.id!);
  await expect.poll(() => worker.evaluate((tabId) => chrome.action.getBadgeText({ tabId }), tabId)).toBe('AUTO');

  await expect(dashboard.locator('#rows tr')).toHaveCount(5);
  await dashboard.locator('[data-filter="auto_reasoning"]').click();
  await expect(dashboard.locator('#rows tr')).toHaveCount(2);
  await dashboard.locator('#rows tr').first().click();
  await expect(dashboard.locator('#detail-tag')).toHaveText('自动推理');
  await expect(dashboard.locator('#detail-tag')).toHaveClass('tag auto');
  await expect(dashboard.locator('#detail')).toContainText('gpt-5-6-auto-thinking');
  await expect(dashboard.locator('#detail')).toContainText('gpt-5-6-thinking');
  await dashboard.screenshot({ path: path.join(root, 'output', 'playwright', 'auto-reasoning-dashboard-zh.png'), fullPage: true });
  await dashboard.locator('aside .panel').first().screenshot({ path: path.join(root, 'output', 'playwright', 'auto-reasoning-detail-zh.png') });

  const popup = await context.newPage();
  await popup.setViewportSize({ width: 640, height: 600 });
  await popup.goto(`chrome-extension://${extensionId}/ui/popup/index.html`);
  await page.bringToFront();
  await popup.reload();
  await expect(popup.locator('.verdict-line b')).toHaveText('自动推理');
  await expectPopupFits(popup);
  await popup.screenshot({ path: path.join(root, 'output', 'playwright', 'auto-reasoning-popup-zh.png') });
  await dashboard.evaluate(async () => chrome.runtime.sendMessage({ type: 'route:update-settings', settings: { uiLanguage: 'en' } }));
  await expect(dashboard.locator('#detail-tag')).toHaveText('Auto reasoning');
  await expect(popup.locator('.verdict-line b')).toHaveText('Auto reasoning');
  await expect(overlay.locator('.status')).toHaveText('Auto reasoning');
  const downloadPromise = dashboard.waitForEvent('download');
  await dashboard.locator('#export-json').click();
  const download = await downloadPromise;
  const exported = JSON.parse(await readFile((await download.path())!, 'utf8'));
  expect(exported.turns.filter((turn: { verdict: string }) => turn.verdict === 'auto_reasoning')).toHaveLength(2);
  expect(exported.turns.find((turn: { resolvedModelSlug: string }) => turn.resolvedModelSlug === 'gpt-5-6-auto-thinking')).toMatchObject({
    responseModelSlug: 'gpt-5-6-thinking', requestedModel: 'gpt-5-6', serverModelSlug: 'gpt-5-6-auto-thinking'
  });
  await Promise.all([page.close(), popup.close(), dashboard.close()]);
});

test('captures passive quota snapshots and displays four rows immediately above request ID', async () => {
  const dashboard = await context.newPage();
  await dashboard.setViewportSize({ width: 1600, height: 1250 });
  await dashboard.goto(`chrome-extension://${extensionId}/ui/dashboard/index.html`);
  await dashboard.evaluate(async () => {
    await chrome.runtime.sendMessage({ type: 'route:update-settings', settings: { captureMode: 'live', autoCaptureEnabled: true, overlayEnabled: true, uiLanguage: 'zh' } });
    await chrome.runtime.sendMessage({ type: 'route:clear' });
  });
  const page = await context.newPage();
  let imageRemaining = 987;
  const quotaRequests: string[] = [];
  page.on('request', (request) => { if (request.url().includes('/backend-api/conversation/init')) quotaRequests.push(request.url()); });
  await page.route('**/backend-api/conversation/init', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({
    type: 'conversation_detail_metadata', limits_progress: [
      { feature_name: 'deep_research', remaining: 0, reset_after: '2026-10-11T12:37:00Z' },
      { feature_name: 'image_gen', remaining: imageRemaining, reset_after: '2026-09-12T12:37:00Z', token: 'SECRET_QUOTA_TOKEN' }
    ]
  }) }));
  await page.goto('http://127.0.0.1:43996/delta-fixture');
  await expect(page.locator('#chatgpt-route-inspector-root')).toHaveCount(1);
  const capture = async (variant: string) => page.evaluate(async (variant) => {
    await window.fetch('/backend-api/conversation/init', { method: 'POST', body: '{}' }).then((response) => response.json());
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await window.fetch(`/backend-api/f/conversation?delta=${variant}`, {
      method: 'POST', body: JSON.stringify({ model: 'gpt-6-pro', conversation_id: `conv-${variant}` })
    }).then((response) => response.text());
  }, variant);
  await capture('normal');
  const evidence = (name: string) => dashboard.locator('#detail .evidence').filter({ has: dashboard.locator('small', { hasText: name }) }).locator('code');
  await expect(evidence('深度研究剩余额度')).toHaveText('0');
  await expect(evidence('图片生成剩余额度')).toHaveText('987');
  await expect(evidence('深度研究重置时间')).toHaveText('2026/10/11 20:37 （北京时间）');
  await expect(evidence('图片生成重置时间')).toHaveText('2026/09/12 20:37 （北京时间）');
  const labels = await dashboard.locator('#detail .evidence small').allTextContents();
  expect(labels.slice(labels.indexOf('请求 ID') - 4, labels.indexOf('请求 ID'))).toEqual([
    '深度研究剩余额度', '深度研究重置时间', '图片生成剩余额度', '图片生成重置时间'
  ]);
  await expect(dashboard.locator('#detail small').filter({ hasText: '图片生成剩余额度' })).toHaveAttribute('title', /limits_progress\[feature_name=image_gen\]\.remaining/);
  const firstId = await dashboard.locator('#rows tr').first().getAttribute('data-id');
  await dashboard.locator('#detail').screenshot({ path: path.join(root, 'output', 'playwright', 'dashboard-usage-quota-zh.png') });
  imageRemaining = 986;
  await capture('missing-resolved');
  await expect(dashboard.locator('#rows tr')).toHaveCount(2);
  await dashboard.locator('#rows tr').first().click();
  await expect(evidence('图片生成剩余额度')).toHaveText('986');
  await dashboard.locator(`#rows tr[data-id="${firstId}"]`).click();
  await expect(evidence('图片生成剩余额度')).toHaveText('987');
  expect(quotaRequests).toHaveLength(2);
  const stored = await worker.evaluate(async (key) => JSON.stringify((await chrome.storage.local.get(key))[key]), storageKey);
  expect(stored).not.toContain('SECRET_QUOTA_TOKEN');
  await dashboard.evaluate(async () => chrome.runtime.sendMessage({ type: 'route:update-settings', settings: { uiLanguage: 'en' } }));
  await expect(evidence('Deep research remaining')).toHaveText('0');
  await expect(evidence('Image generation reset time')).toHaveText('12/09/2026, 20:37 (UTC+08:00)');
  await expect(dashboard.locator('#detail')).not.toContainText(/[\u4e00-\u9fff]/);
  await page.close();
  await dashboard.close();
});

test('rejects stale UI snapshots, keeps overlay nodes stable, and blocks post-clear resurrection', async () => {
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/ui/options/index.html`);
  await options.evaluate(async () => {
    await chrome.runtime.sendMessage({ type: 'route:update-settings', settings: {
      captureMode: 'live', uiLanguage: 'en', overlayEnabled: true, overlayMode: 'full', autoCaptureEnabled: true
    } });
    await chrome.runtime.sendMessage({ type: 'route:clear' });
  });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:43996/c/audit-regression');
  const overlay = page.locator('#chatgpt-route-inspector-root');
  await expect(overlay).toHaveCount(1);
  const startedAt = new Date().toISOString();
  const observation = {
    captureId: 'audit-stable-capture', source: 'page_fetch', captureMode: 'live', phase: 'completed',
    observedAt: startedAt, startedAt, requestedModel: 'gpt-audit', resolvedModelSlug: 'gpt-audit', conversationId: 'audit-regression'
  };
  await page.evaluate((observation) => window.postMessage({ source: 'chatgpt-route-inspector', version: 1, observation }, location.origin), observation);
  await expect(overlay).toContainText('gpt-audit');
  const dashboard = await context.newPage();
  await dashboard.goto(`chrome-extension://${extensionId}/ui/dashboard/index.html`);
  await expect(dashboard.locator('#rows tr')).toHaveCount(1);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/ui/popup/index.html`);
  await expect(popup.locator('#overlay-show')).toHaveClass(/active/);

  // A metadata timestamp refresh must not rebuild identical visible overlay controls.
  await overlay.evaluate((element) => {
    const root = element.shadowRoot!;
    (element as HTMLElement & { auditButton?: Element }).auditButton = root.querySelector('#mini')!;
  });
  await page.evaluate((observation) => window.postMessage({ source: 'chatgpt-route-inspector', version: 1,
    observation: { ...observation, observedAt: new Date().toISOString() }
  }, location.origin), observation);
  const staleSnapshot = await options.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'route:get-state' })).state);
  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({})).find((tab) => tab.url?.endsWith('/c/audit-regression'))!.id!);
  await worker.evaluate(async ({ tabId, snapshot }) => {
    snapshot.revision -= 1;
    snapshot.settings.overlayEnabled = false;
    snapshot.settings.uiLanguage = 'zh';
    snapshot.turns = [];
    await chrome.tabs.sendMessage(tabId, { type: 'route:state-changed', state: snapshot });
    await chrome.runtime.sendMessage({ type: 'route:state-changed', state: snapshot }).catch(() => undefined);
  }, { tabId, snapshot: staleSnapshot });
  await expect(overlay).toHaveCount(1);
  expect(await overlay.evaluate((element) => (element as HTMLElement & { auditButton?: Element }).auditButton === element.shadowRoot?.querySelector('#mini'))).toBe(true);
  await expect(popup.locator('#overlay-show')).toHaveClass(/active/);
  await expect(dashboard.locator('#rows tr')).toHaveCount(1);
  await expect(options.locator('html')).toHaveAttribute('lang', 'en');

  const cleared = await options.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'route:clear' })).state);
  await page.evaluate((observation) => window.postMessage({ source: 'chatgpt-route-inspector', version: 1,
    observation: { ...observation, observedAt: new Date().toISOString() }
  }, location.origin), observation);
  await expect.poll(() => worker.evaluate(async (key) => (await chrome.storage.local.get(key))[key].turns.length, storageKey)).toBe(0);
  await expect(dashboard.locator('#rows tr')).toHaveCount(0);
  await expect.poll(() => worker.evaluate((tabId) => chrome.action.getBadgeText({ tabId }), tabId)).toBe('');
  const rejected = await options.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'route:get-state' })).state);
  expect(rejected.revision).toBe(cleared.revision);

  // A failed save reports failure without a success toast or an unhandled promise rejection.
  const errors: string[] = [];
  options.on('pageerror', (error) => errors.push(error.message));
  await options.evaluate(() => {
    chrome.runtime.sendMessage = (async () => ({ ok: false, error: 'Simulated storage failure' })) as typeof chrome.runtime.sendMessage;
  });
  await options.locator('#save').click();
  await expect(options.getByRole('alert')).toHaveText('Simulated storage failure');
  await expect(options.locator('#toast')).not.toHaveClass(/show/);
  expect(errors).toEqual([]);
  await Promise.all([options.close(), popup.close(), dashboard.close(), page.close()]);
});
