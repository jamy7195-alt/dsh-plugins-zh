/**
 * dsh-thinking-zh — 让模型的「思考」使用简体中文。
 *
 * 两条独立的机制，任意一条都可以单独开关：
 *
 * 1. `promptRule`（默认开）—— 往系统提示词里插入一条最高优先级的语言规则，
 *    要求 reasoning / thinking 一律用简体中文书写。这是最可靠的一条路：
 *    模型直接说中文，不需要任何后处理，也不额外消耗 token。
 *
 * 2. `translate`（默认开）—— 兜底。有些模型（或某些被上游强制英文思考的
 *    推理模型）无视提示词规则，思考流仍然是英文。这里挂到 `llm/stream`
 *    waterfall 上，把英文的 `reasoning-delta` 按句切成小段，调用一次
 *    「子请求」请模型把它翻成中文，仍然以 `reasoning-delta` 的形式发出去，
 *    并把 `block-end.block.text` 重写成真正发出去的中文，保证
 *    「实时增量」与「收尾整块」两种渲染路径看到同一份文本。
 *
 * 子请求自身也走 `ctx.llm.stream()`，所以它同样会经过 `llm/stream`
 * waterfall。用一个 WeakSet 记住自己发出的 options 对象（waterfall 传给
 * 监听器和转发给 adapter 的是同一个对象引用），命中即直接 `next()`，
 * 因此不会无限递归。
 *
 * 失败一律「放行原文」：超时、报错、限流、模型没吐字，都退回未翻译的
 * 英文，并且当前这一路流后续不再重试（fail fast），避免答案被反复拖慢。
 */

/** 系统提示词里的语言规则段。 */
const LANGUAGE_RULE = [
  '【语言规则 · 最高优先级】',
  '1. 思考过程（reasoning / thinking）必须使用简体中文书写。',
  '2. 最终回复的语言跟随用户：用户用中文提问就用中文回复，用其他语言提问就用该语言回复。',
  '3. 代码、命令行、文件路径、包名、函数名、API 名称、报错与日志原文、URL、专有名词保持原样，不要翻译。',
  '4. 需要引用英文错误信息时保留英文原文，必要时在其后用中文补充说明。',
].join('\n');

/** 翻译子请求的系统提示词。 */
const TRANSLATE_SYSTEM = [
  '你是一个「思考流翻译器」。用户会给你一段 AI 的思考（reasoning）片段。',
  '你只做一件事：把它翻译成简体中文。',
  '',
  '规则：',
  '1. 只输出译文本身。不要任何前后缀、说明、引号，也不要 Markdown 代码围栏。',
  '2. 代码、命令行、文件路径、包名、函数名、API 名称、变量名、报错与日志原文、URL、专有名词保持原样。',
  '3. 已经是中文的部分保持不动。',
  '4. 保留原文的换行与列表结构。',
  '5. 如果原文没有可翻译的自然语言（只有代码或符号），原样返回。',
].join('\n');

const SECTION_NAME = 'plugin:thinking-zh:language';

/** 自己发出的子请求，用于打断 `llm/stream` waterfall 的递归。 */
const INTERNAL_REQUESTS = new WeakSet();

/** 句末标点：遇到就切一段。 */
const HARD_BREAK = /[\n。！？!?；;]/;
/** 段中软标点：超长时优先在这些位置切。 */
const SOFT_BREAK = /[\s,，、:：)）\]】」》]/;

export const name = 'dsh-thinking-zh';

export const inject = ['llm', 'systemPrompt'];

export function apply(ctx, config) {
  const cfg = normalizeConfig(config);

  if (cfg.promptRule) {
    ctx.effect(
      () => ctx.systemPrompt.section({
        name: SECTION_NAME,
        order: cfg.promptOrder,
        text: LANGUAGE_RULE,
      }),
      'dsh-thinking-zh: 中文思考语言规则',
    );
  }

  if (!cfg.translate) return;

  const limiter = createRateLimiter(cfg.maxPerMinute);

  ctx.effect(
    () => ctx.on('llm/stream', (options, next) => {
      // 自己发出的翻译子请求：原样放行。
      if (!options || typeof options !== 'object' || INTERNAL_REQUESTS.has(options)) return next();
      if (typeof options.provider !== 'string' || typeof options.model !== 'string') return next();
      return rewriteReasoning(next(), options, cfg, ctx, limiter);
    }, { global: true }),
    'dsh-thinking-zh: 思考流翻译',
  );
}

/* ------------------------------------------------------------------ */
/* 流改写                                                              */
/* ------------------------------------------------------------------ */

async function* rewriteReasoning(source, options, cfg, ctx, limiter) {
  let buffer = '';
  let emitted = '';
  let openIndex = -1;
  let broken = false;

  for await (const chunk of source) {
    const type = chunk && chunk.type;

    // 已放弃翻译：原文直通，但继续记账，保证 block-end 与增量一致。
    if (broken) {
      if (type === 'reasoning-delta' && typeof chunk.text === 'string') {
        emitted += chunk.text;
        yield chunk;
        continue;
      }
      if (type === 'block-end' && isReasoningEnd(chunk) && owns(chunk, openIndex)) {
        yield overrideReasoningText(chunk, emitted);
        buffer = '';
        emitted = '';
        openIndex = -1;
        continue;
      }
      yield chunk;
      continue;
    }

    if (type === 'reasoning-delta') {
      const text = typeof chunk.text === 'string' ? chunk.text : '';
      if (text.length === 0) {
        yield chunk;
        continue;
      }

      if (openIndex === -1) {
        openIndex = chunk.index;
      } else if (chunk.index !== openIndex) {
        // 上游没发 block-end 就换了 block：丢掉残留缓冲，重新开始。
        buffer = '';
        emitted = '';
        openIndex = chunk.index;
      }

      buffer += text;

      let segment = takeSegment(buffer, cfg);
      while (segment !== null) {
        buffer = buffer.slice(segment.length);
        const result = await convert(segment, options, cfg, ctx, limiter, openIndex);
        if (!result.ok) {
          broken = true;
          emitted += segment;
          yield { ...chunk, text: segment };
          break;
        }
        emitted += result.text;
        yield { ...chunk, text: result.text };
        segment = takeSegment(buffer, cfg);
      }
      continue;
    }

    if (type === 'block-end' && isReasoningEnd(chunk) && owns(chunk, openIndex)) {
      let pending = buffer;
      buffer = '';

      if (pending.length === 0 && emitted.length === 0) {
        const whole = chunk.block && typeof chunk.block.text === 'string' ? chunk.block.text : '';
        pending = whole;
      }

      if (pending.length > 0) {
        const result = await convert(pending, options, cfg, ctx, limiter, chunk.index);
        const text = result.ok ? result.text : pending;
        if (!result.ok) broken = true;
        emitted += text;
        // 上游可能只发了整块、没发增量；补一条增量让前端立刻渲染。
        yield { type: 'reasoning-delta', index: chunk.index, text };
      }

      const out = emitted.length > 0 ? overrideReasoningText(chunk, emitted) : chunk;
      emitted = '';
      openIndex = -1;
      yield out;
      continue;
    }

    yield chunk;
  }
}

function owns(chunk, openIndex) {
  return openIndex === -1 || chunk.index === openIndex;
}

function isReasoningEnd(chunk) {
  return Boolean(chunk.block) && chunk.block.type === 'reasoning' && typeof chunk.block.text === 'string';
}

function overrideReasoningText(chunk, text) {
  if (typeof text !== 'string' || text.length === 0) return chunk;
  return { ...chunk, block: { ...chunk.block, text } };
}

/**
 * 从缓冲区里取出一段可翻译的文本；不够一段就返回 null 等下一次增量。
 * 优先在句末标点处切；超过 maxSegmentChars 时退而求其次在软标点处切。
 */
function takeSegment(buffer, cfg) {
  const max = cfg.maxSegmentChars;
  const min = cfg.minChars;

  let cut = -1;
  const limit = Math.min(buffer.length, max);
  for (let i = 0; i < limit; i += 1) {
    if (HARD_BREAK.test(buffer[i])) cut = i + 1;
  }
  if (cut >= min) return buffer.slice(0, cut);

  if (buffer.length >= max) {
    let soft = -1;
    for (let i = 0; i < max; i += 1) {
      if (SOFT_BREAK.test(buffer[i])) soft = i + 1;
    }
    return buffer.slice(0, soft > 0 ? soft : max);
  }

  return null;
}

/** 这段文本值不值得翻？已经是中文、或本来就没有英文，就直通。 */
function needsTranslation(text) {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (!/[A-Za-z]/.test(trimmed)) return false;

  const cjk = (trimmed.match(/[\u3400-\u9FFF\uF900-\uFAFF]/g) || []).length;
  if (cjk === 0) return true;

  const latin = (trimmed.match(/[A-Za-z]/g) || []).length;
  return cjk / (cjk + latin) < 0.25;
}

/* ------------------------------------------------------------------ */
/* 翻译子请求                                                          */
/* ------------------------------------------------------------------ */

async function convert(text, options, cfg, ctx, limiter, index) {
  if (!needsTranslation(text)) return { ok: true, text };
  if (!limiter.take()) {
    note(cfg, '限流，跳过翻译', index, text.slice(0, 40));
    return { ok: true, text };
  }

  const request = {
    provider: cfg.translatorProvider || options.provider,
    model: cfg.translatorModel || options.model,
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    system: TRANSLATE_SYSTEM,
    temperature: 0,
    maxTokens: Math.min(8192, Math.max(512, Math.ceil(text.length * 3))),
  };
  if (cfg.reasoningEffort) request.reasoningEffort = cfg.reasoningEffort;
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    request.signal = AbortSignal.timeout(cfg.timeoutMs);
  }

  INTERNAL_REQUESTS.add(request);

  let out = '';
  let failure = null;
  try {
    for await (const chunk of ctx.llm.stream(request)) {
      if (!chunk) continue;
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        out += chunk.text;
      } else if (chunk.type === 'finish' && chunk.reason) {
        const kind = chunk.reason.kind;
        if (kind === 'error' || kind === 'aborted') failure = chunk.reason;
      }
    }
  } catch (error) {
    failure = error;
  } finally {
    INTERNAL_REQUESTS.delete(request);
  }

  const cleaned = stripFence(out);
  if (failure || cleaned.length === 0) {
    note(cfg, '翻译失败，放行原文', index, failure ? String(failure.message || failure) : '空结果');
    return { ok: false, text };
  }

  note(cfg, '翻译', index, `${text.length} → ${cleaned.length}`);
  return { ok: true, text: cleaned };
}

/** 模型偶尔会把译文包在 ``` 里。 */
function stripFence(text) {
  let value = String(text).trim();
  if (value.startsWith('```')) {
    const firstBreak = value.indexOf('\n');
    if (firstBreak !== -1) value = value.slice(firstBreak + 1);
    else value = value.slice(3);
    if (value.endsWith('```')) value = value.slice(0, -3);
    value = value.trim();
  }
  return value;
}

/** 每分钟最多发起多少次翻译，防止失控烧 token。0 或负数 = 不限。 */
function createRateLimiter(perMinute) {
  if (!perMinute || perMinute <= 0) return { take: () => true };
  const windowMs = 60000;
  const hits = [];
  return {
    take() {
      const now = Date.now();
      while (hits.length > 0 && now - hits[0] > windowMs) hits.shift();
      if (hits.length >= perMinute) return false;
      hits.push(now);
      return true;
    },
  };
}

function note(cfg, ...args) {
  if (!cfg.debug) return;
  try {
    console.error('[dsh-thinking-zh]', ...args);
  } catch {
    /* 日志永远不该成为故障原因 */
  }
}

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const text = (value) => (typeof value === 'string' ? value.trim() : '');
  const int = (value, fallback, min, max) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(n)));
  };

  const minChars = int(source.minChars, 24, 1, 100000);
  const maxSegmentChars = Math.max(minChars * 4, int(source.maxSegmentChars, 1200, 8, 100000));

  return {
    promptRule: source.promptRule !== false,
    translate: source.translate !== false,
    promptOrder: int(source.promptOrder, 10100, -100000, 100000),
    translatorProvider: text(source.translatorProvider),
    translatorModel: text(source.translatorModel),
    reasoningEffort: text(source.reasoningEffort),
    minChars,
    maxSegmentChars,
    timeoutMs: int(source.timeoutMs, 8000, 500, 120000),
    maxPerMinute: int(source.maxPerMinute, 40, 0, 100000),
    debug: source.debug === true,
  };
}