# dsh-thinking-zh

让 DSH 的**思考（reasoning / thinking）用简体中文**。

两条互相独立的机制，各自可以单独开关：

## 1. 语言规则（`promptRule`，默认开）

往系统提示词里插入一段最高优先级的规则（段名 `plugin:thinking-zh:language`，
`order: 10100`，排在工具说明之后、运行时上下文之前）：

```
【语言规则 · 最高优先级】
1. 思考过程（reasoning / thinking）必须使用简体中文书写。
2. 最终回复的语言跟随用户：用户用中文提问就用中文回复，用其他语言提问就用该语言回复。
3. 代码、命令行、文件路径、包名、函数名、API 名称、报错与日志原文、URL、专有名词保持原样，不要翻译。
```

这是最省事也最省钱的一条路：模型直接说中文，不需要任何后处理，也不多花一个 token。

## 2. 思考流翻译（`translate`，默认开）

兜底。有些推理模型（或被上游强制的场景）不看提示词，思考流里仍然是英文。
插件挂在 `llm/stream` waterfall 上：

- 把 `reasoning-delta` 按句切成小段；
- 每一段用一次**子请求**（`ctx.llm.stream()`）请模型翻译成中文；
- 仍然以 `reasoning-delta` 的形式发出去，保持实时流式；
- 同时把 `block-end.block.text` 重写成**真正发出去的那份中文**，这样
  「实时增量」和「收尾整块」两条渲染路径看到的文本始终一致。

几个必要的防御：

- **不会递归**：`llm/stream` 的 waterfall 传给监听器和转发给 adapter 的是
  **同一个 options 对象引用**，所以插件用一个 `WeakSet` 记住自己发出的
  子请求，命中就直接 `next()`。
- **失败放行**：超时、报错、模型返回空、被限流，一律退回未翻译的英文；
  并且当前这一路流后续**不再重试**（fail fast），不会让答案被反复拖慢。
- **已经是中文的不翻**：按 CJK 字符占比判断，中文段原样直通，不浪费请求。

---

## 配置

写在 `<ProfileDir>\cordis.patch.yml` 对应那一行的 `config` 里：

```yaml
- insert:
    - id: dsh-thinking-zh
      name: dsh-thinking-zh
      config:
        promptRule: true          # 插语言规则
        translate: true           # 英文思考流兜底翻译
        translatorProvider: ""    # 空 = 跟主对话同 provider
        translatorModel: ""       # 空 = 跟主对话同 model
        reasoningEffort: ""       # 空 = 用模型默认；填 low/minimal 可以省钱
        minChars: 24              # 短于这个长度的片段根本不值得翻译
        maxSegmentChars: 1200     # 单次翻译的最大字符数，超了就在软标点处强切
        timeoutMs: 8000           # 单次翻译超时
        maxPerMinute: 40          # 每分钟翻译次数上限，0 = 不限
        debug: false              # true 就把每次翻译打到 DSH 日志
```

> `translatorModel` 建议指向一个便宜、快、中文好的模型；翻译是机械任务，
> 不需要强模型。

## 代价与注意

- **翻译子请求要花 token**，而且会产生额外的请求延迟。提示词规则生效时
  基本不会触发翻译；如果发现翻译频繁触发，说明模型不听话，可以把
  `translate` 关掉，或者换一个愿意用中文思考的模型。
- 关掉 `translate` 只留 `promptRule` 是**零成本**的。
- 提示词段的改动会让 prompt 前缀变化，可能影响 KV cache 复用；这是
  提示词注入的固有代价。
- 翻译只作用于**思考块**，不会碰最终回复，也不会碰工具调用参数。

## 验证

```powershell
# 组装出来的 profile 里应该有这一行
dsh --profile desktop --dump-config | Select-String "dsh-thinking-zh"
```

装完重启 DSH，然后随便问一个需要推理的问题，看思考块是不是中文。