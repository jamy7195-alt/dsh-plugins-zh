/**
 * dsh-global-persona — 一个所有会话共用的「全局人格」。
 *
 * 做什么
 * ------
 * 往系统提示词里注册一个自己的段（`plugin:global-persona`，默认 order 0，
 * 紧跟在 harness 身份之后、运行时上下文之前）。这一段的内容就是用户写的
 * 人格设定，所以它对主 agent、子 agent、所有新会话一律生效——「全局」。
 *
 * 为什么不用 `@deepseek-ai/dsh-persona`
 * ------------------------------------
 * 那个包是**预设作用域**的：它注册的是 `deployment:persona-prefix` /
 * `deployment:persona-suffix`，一次只服务一个 agent preset；把它挂到全局
 * 会和提示词注册表自己的 persona 段重名，直接报错。所以这里注册一个名字
 * 不同的独立段，两者可以并存。
 *
 * 人格存在哪里
 * ------------
 * 1. 插件配置 `persona`：写在 profile 的 `cordis.patch.yml` 里，是「出厂
 *    默认值」。
 * 2. profile 目录下的 `.dsh-global-persona.json`：界面里保存的值，优先级
 *    高于配置。**刻意不去改写用户的 cordis.patch.yml**——那是一份手工维护
 *    的 YAML，插件回写它风险太大。
 *
 * 「重置」= 删掉这个文件，于是回落到配置里的默认人格（默认是空的，等于关闭）。
 *
 * 接口
 * ----
 * 只监听回环地址：
 *   GET  /dsh-global-persona/api/persona          读取当前状态
 *   PUT  /dsh-global-persona/api/persona          { persona: "..." } 保存
 *                                                 { reset: true }    重置
 *   POST /dsh-global-persona/beacon               前端异常上报（写进日志）
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const SECTION_NAME = 'plugin:global-persona';
const ROUTE_PATH = '/dsh-global-persona/api/persona';
const BEACON_PATH = '/dsh-global-persona/beacon';
const STATE_FILE = '.dsh-global-persona.json';
const MAX_BODY = 256 * 1024;

export const name = 'dsh-global-persona';

export const inject = ['systemPrompt', 'webServer'];

export function apply(ctx, config) {
  const cfg = normalizeConfig(config);
  const store = new PersonaStore(cfg);

  ctx.effect(
    () => ctx.systemPrompt.section({
      name: SECTION_NAME,
      order: cfg.order,
      text: () => store.render(),
      // 人格是用户自由文本，`{{...}}` 必须原样保留，不能当提示词变量解析。
      interpolate: false,
    }),
    'dsh-global-persona: 全局人格段',
  );

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_PATH,
      handler: (request, response) => {
        void handlePersona(request, response, store, cfg);
      },
    }),
    'dsh-global-persona: 人格接口',
  );

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: BEACON_PATH,
      handler: (request, response) => {
        void handleBeacon(request, response);
      },
    }),
    'dsh-global-persona: 前端日志',
  );
}

/* ------------------------------------------------------------------ */
/* 人格存储                                                            */
/* ------------------------------------------------------------------ */

class PersonaStore {
  constructor(cfg) {
    this.cfg = cfg;
    this.file = join(resolveProfileDir(), STATE_FILE);
    this.stored = readState(this.file);
  }

  /** 已保存的值优先，其次配置里的默认值。 */
  value() {
    if (typeof this.stored === 'string') return this.stored;
    return this.cfg.persona;
  }

  source() {
    if (typeof this.stored === 'string') return 'profile';
    return this.cfg.persona ? 'config' : 'empty';
  }

  /** 真正拼进系统提示词的内容；空串表示这一段被丢弃。 */
  render() {
    if (!this.cfg.enabled) return '';
    const persona = String(this.value() ?? '').trim();
    if (persona.length === 0) return '';
    const template = String(this.cfg.template ?? '');
    if (template.includes('{{persona}}')) return template.split('{{persona}}').join(persona).trim();
    return `${template}\n${persona}`.trim();
  }

  set(persona) {
    const value = String(persona ?? '');
    this.stored = value;
    return writeState(this.file, value);
  }

  clear() {
    this.stored = null;
    try {
      rmSync(this.file, { force: true });
      return true;
    } catch (error) {
      log('重置失败', error);
      return false;
    }
  }
}

function resolveProfileDir() {
  const explicit = process.env.DSH_PROFILE_DIR;
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const profile = process.env.DSH_PROFILE || 'default';
  return join(home, 'profiles', profile);
}

function readState(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed && typeof parsed.persona === 'string') return parsed.persona;
  } catch {
    /* 文件不存在、被删掉、或者内容坏了，一律当作「没有保存过」 */
  }
  return null;
}

function writeState(file, persona) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const body = JSON.stringify({
      version: 1,
      persona,
      updatedAt: new Date().toISOString(),
    }, null, 2);
    const temporary = `${file}.tmp`;
    writeFileSync(temporary, body, 'utf8');
    renameSync(temporary, file);
    return true;
  } catch (error) {
    log('保存失败', error);
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

async function handlePersona(request, response, store, cfg) {
  if (!isLoopback(request)) {
    sendJson(response, 403, { ok: false, error: 'loopback only' });
    return;
  }

  const method = String(request.method || 'GET').toUpperCase();

  try {
    if (method === 'GET') {
      sendJson(response, 200, state(store, cfg));
      return;
    }

    if (method === 'PUT' || method === 'POST' || method === 'PATCH') {
      const body = await readJson(request);
      if (typeof body.persona === 'string') {
        if (!store.set(body.persona)) {
          sendJson(response, 500, { ok: false, error: '无法写入 profile 目录' });
          return;
        }
      } else if (body.reset === true) {
        store.clear();
      } else {
        sendJson(response, 400, { ok: false, error: 'body 需要 { persona: string } 或 { reset: true }' });
        return;
      }
      sendJson(response, 200, state(store, cfg));
      return;
    }

    sendJson(response, 405, { ok: false, error: `method ${method} not allowed` });
  } catch (error) {
    sendJson(response, 400, { ok: false, error: message(error) });
  }
}

async function handleBeacon(request, response) {
  if (!isLoopback(request)) {
    sendJson(response, 403, { ok: false });
    return;
  }
  try {
    const body = await readJson(request);
    log('前端上报', body.stage, body.detail);
  } catch {
    /* 上报本身失败无所谓 */
  }
  sendJson(response, 200, { ok: true });
}

function state(store, cfg) {
  return {
    ok: true,
    enabled: cfg.enabled,
    persona: store.value(),
    source: store.source(),
    order: cfg.order,
    prompt: store.render(),
    file: store.file,
  };
}

function isLoopback(request) {
  const address = request && request.socket ? request.socket.remoteAddress : '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('payload too large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw.length === 0) return {};
  return JSON.parse(raw);
}

function message(error) {
  return String(error && error.message ? error.message : error);
}

function log(...args) {
  try {
    console.error('[dsh-global-persona]', ...args);
  } catch {
    /* 日志永远不该成为故障原因 */
  }
}

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const order = Number(source.order);

  return {
    enabled: source.enabled !== false,
    persona: typeof source.persona === 'string' ? source.persona : '',
    template: typeof source.template === 'string' && source.template.length > 0
      ? source.template
      : '{{persona}}',
    order: Number.isFinite(order) ? Math.floor(order) : 0,
  };
}