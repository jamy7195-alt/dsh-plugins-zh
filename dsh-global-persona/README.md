# dsh-global-persona

给 DSH 一个**所有会话共用的全局人格**，并在「设置 → 通用」里直接编辑。

## 它到底往哪儿插

系统提示词里注册一个**自己的段**：

| 项 | 值 |
| --- | --- |
| 段名 | `plugin:global-persona` |
| order | `0`（紧跟 harness 身份之后，和 `deployment:persona-prefix` 同段位） |
| 内容 | 用户写的人格文本，`interpolate: false`（里面的 `{{...}}` 原样保留） |

因为它注册在全局 `ctx` 上，所以主 agent、子 agent、所有新会话都吃得到——
这才是「全局」。

### 为什么不直接用 `@deepseek-ai/dsh-persona`

那个包是**预设作用域**的：它注册的段名是 `deployment:persona-prefix` /
`deployment:persona-suffix`，一次只服务一个 agent preset。挂到全局会和提示词
注册表自己的 persona 段**重名并直接报错**。所以这里用一个独立段名，两者可以
并存。

## 人格存在哪儿

1. **插件配置 `persona`**（`cordis.patch.yml` 里）——出厂默认值。
2. **`<ProfileDir>\.dsh-global-persona.json`**——界面里保存的值，优先级更高。

插件**刻意不去改写你的 `cordis.patch.yml`**：那是一份手工维护的 YAML，
插件回写它的风险远大于收益。

「重置」= 删掉这个 json，于是回落到配置里的默认人格（默认空，等于关闭）。

## HTTP 接口

只监听回环地址（`127.0.0.1` / `::1`），非回环一律 403：

```
GET  /dsh-global-persona/api/persona
PUT  /dsh-global-persona/api/persona   { "persona": "你是一位……" }
PUT  /dsh-global-persona/api/persona   { "reset": true }
POST /dsh-global-persona/beacon        { "stage": "...", "detail": "..." }   前端异常上报
```

`GET` / `PUT` 返回：

```json
{
  "ok": true,
  "enabled": true,
  "persona": "你是一位……",
  "source": "profile",          // profile | config | empty
  "order": 0,
  "prompt": "你是一位……",       // 实际会拼进提示词的内容
  "file": "D:\\DSH\\profiles\\desktop\\.dsh-global-persona.json"
}
```

命令行试一下：

```powershell
curl.exe http://127.0.0.1:19387/dsh-global-persona/api/persona
curl.exe -X PUT http://127.0.0.1:19387/dsh-global-persona/api/persona -H "content-type: application/json" -d "{\"persona\":\"你是一位务实的资深工程师。\"}"
```

## 界面

浏览器半边往 `settings.general.item` 槽位注册了一行（`id: global-persona`，
`order: 74`）：标题、说明、多行输入框、保存 / 重置、状态与字数。用
`--dsw-alias-*` 主题变量，明暗主题都跟得上。它不引任何 Harness 客户端包，
React 从页面的模块表 `require("react")` 进来。

保存后**下一次组装提示词**就生效，不用重启；已经在跑的会话则在下一次请求时生效。

## 配置

```yaml
- insert:
    - id: dsh-global-persona
      name: dsh-global-persona
      config:
        enabled: true       # 总开关
        persona: ""         # 出厂默认人格；界面保存的值会覆盖它
        template: "{{persona}}"
        order: 0            # 提示词段的位置
```

`template` 里可以放 `{{persona}}` 做包装，例如：

```yaml
template: |
  ## 你的角色
  {{persona}}
```

## 验证

```powershell
dsh --profile desktop --dump-config | Select-String "dsh-global-persona"
curl.exe http://127.0.0.1:19387/dsh-global-persona/api/persona
```

装完重启 DSH；打开「设置 → 通用」，最下面应该能看到「全局人格」那一行。