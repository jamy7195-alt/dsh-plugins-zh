# dsh-plugins-zh

两个给 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）用的中文增强插件。

| 插件 | 作用 |
| --- | --- |
| [`dsh-thinking-zh`](./dsh-thinking-zh) | 让模型的**思考过程**用简体中文 |
| [`dsh-global-persona`](./dsh-global-persona) | 设置一个**所有会话共用**的全局人格 |

两个插件互相独立，可以只装其中一个。都支持「装完重启 DSH 即可用」，不需要改配置文件。

---

## 1. `dsh-thinking-zh` — 思考用中文

思考流英文是个老问题：提示词里写了「用中文思考」，推理模型照样吐英文。这个插件双管齐下：

1. **提示词规则**（`promptRule`，默认开）——往系统提示词末尾插一段最高优先级的语言规则，要求 reasoning / thinking 一律用简体中文。模型直接说中文，**零额外开销**，这条能覆盖绝大多数情况。
2. **实时翻译兜底**（`translate`，默认开）——对无视提示词的模型，挂到 `llm/stream` waterfall 上，把英文的 `reasoning-delta` 按句切段，用一次子请求翻成中文后再以 `reasoning-delta` 发出去，并把 `block-end` 里的整块文本一起改写，保证「流式增量」和「收尾整块」两条渲染路径看到同一份中文。

失败一律**放行原文**（超时 / 报错 / 限流 / 空结果），并且当前这一路流后续不再重试，不会把回答拖慢。已经是中文的段落、纯代码/符号的段落会直接跳过，不浪费请求。

### 配置

写在 profile 的 `cordis.patch.yml`，改完重启生效：

```yaml
- id: dsh-thinking-zh
  config:
    promptRule: true          # 插入系统提示词语言规则
    translate: true           # 英文思考流实时翻译
    minChars: 24              # 短于这个长度不单独切段
    maxSegmentChars: 1200     # 单段上限，超了在标点处切
    timeoutMs: 8000           # 单次翻译超时，超时即放弃
    maxPerMinute: 40          # 每分钟最多翻译多少次，0 = 不限
    translatorProvider: ""    # 留空 = 跟随当前请求
    translatorModel: ""       # 留空 = 跟随当前请求（建议填个小模型省钱）
    reasoningEffort: ""       # 留空 = 不传
    promptOrder: 10100        # 语言规则在提示词里的位置
    debug: false              # true = 往日志打翻译过程
```

只想用便宜的那半套（不翻译、只要求模型自己说中文）：

```yaml
- id: dsh-thinking-zh
  config:
    promptRule: true
    translate: false
```

### 成本提示

`translate: true` 意味着**每一段英文思考都会额外发一次小请求**。思考很长的对话里，这笔开销不可忽略。如果用的模型本来就听话（能按提示词用中文思考），把 `translate` 关掉更划算。

---

## 2. `dsh-global-persona` — 全局人格

往系统提示词里注册一个自己的段（`plugin:global-persona`，默认 `order: 0`，紧跟在 harness 身份之后），内容是用户写的人格设定。对主 agent、子 agent、所有新会话一律生效。

在 **设置 → 通用** 里就有编辑框，输入完点保存即可，不用碰配置文件。

### 为什么不直接用 `@deepseek-ai/dsh-persona`

那个包是**预设作用域**的：它注册 `deployment:persona-prefix` / `deployment:persona-suffix`，一次只服务一个 agent preset；挂到全局会和提示词注册表自己的 persona 段重名，直接报错。所以这里注册一个名字不同的独立段，两者可以并存。

### 人格存在哪

1. 插件配置里的 `persona`：写在 `cordis.patch.yml` 里，当作「出厂默认值」。
2. profile 目录下的 `.dsh-global-persona.json`：界面里保存的值，**优先级高于配置**。

插件刻意**不回写** `cordis.patch.yml`——那是一份手工维护的 YAML，让插件去改风险太大。点「重置」等于删掉 `.dsh-global-persona.json`，回落到配置里的默认值（默认是空，等于关闭）。

### 配置

```yaml
- id: dsh-global-persona
  config:
    enabled: true             # false = 整段不注入
    persona: ""               # 默认人格，界面保存的值会覆盖它
    template: "{{persona}}"   # {{persona}} 会被替换成实际内容
    order: 0                  # 在提示词里的位置，0 = 紧跟身份声明
```

`template` 可以拿来加壳，比如：

```yaml
    template: |
      以下是你的人设，请始终按此风格回答：
      {{persona}}
```

### 接口

只监听回环地址：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/dsh-global-persona/api/persona` | 读取当前状态 |
| `PUT` | `/dsh-global-persona/api/persona` | `{ "persona": "..." }` 保存，`{ "reset": true }` 重置 |
| `POST` | `/dsh-global-persona/beacon` | 前端异常上报（写进 Host 日志） |

---

## 安装

把插件目录放到本地，然后在 profile 的 `package.json` 里加依赖、在 `dsh.profile.bundles` 里加名字：

```json
{
  "dependencies": {
    "dsh-thinking-zh": "file:D:/DSH/local-plugins/dsh-thinking-zh",
    "dsh-global-persona": "file:D:/DSH/local-plugins/dsh-global-persona"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-thinking-zh",
        "dsh-global-persona"
      ]
    }
  }
}
```

然后装依赖：

```powershell
dsh plugin --profile <profile> install
```

> 注意：`nodeLinker: hoisted` 下 `node_modules` 里是**拷贝**而不是软链，所以**改完插件源码要重跑一次 install**，否则加载的还是旧的。

最后**重启 DSH**。插件的树是在启动时组合的，改 `package.json` 不会热更新。

---

## 许可

MIT