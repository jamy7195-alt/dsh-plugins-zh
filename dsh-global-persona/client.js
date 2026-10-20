/**
 * dsh-global-persona — 浏览器半边。
 *
 * 在「设置 → 通用」里加一行：一个多行输入框 + 保存/重置，直接读写 Host 的
 * `/dsh-global-persona/api/persona`。保存后下一次组装提示词就会带上新人格。
 *
 * 与 dsh-desktop-restart 一样，这里不引任何 Harness 客户端包，React 从页面
 * 的模块表里 require 进来；样式用 `--dsw-alias-*` 主题变量并带兜底值，
 * 所以明暗主题都跟得上。
 *
 * Bundle 格式：`window.__ModuleLoader__.load({ id, factory })`。
 */
window.__ModuleLoader__.load({
  id: "dsh-global-persona",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var ROUTE = "/dsh-global-persona/api/persona";
    var BEACON = "/dsh-global-persona/beacon";
    var NS = "plugin.global-persona";

    /** 页面控制台从外面看不到，所以失败要主动回报给 Host 的日志。 */
    function reportFailure(stage, error) {
      try {
        fetch(BEACON, {
          method: "POST",
          cache: "no-store",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            stage: stage,
            detail: String(error && error.message ? error.message : error),
          }),
        }).catch(function () {});
      } catch (ignored) {
        /* 上报不该成为它描述的那个故障 */
      }
    }

    var react = require("react");

    var DICTIONARIES = {
      zh: {
        title: "全局人格",
        description:
          "这段文字会插入所有会话的系统提示词开头，主 agent 与子 agent 都生效。留空即关闭。",
        placeholder: "例如：你是一位务实的资深工程师，回答先给结论，再给理由；不确定时直说不确定，不要编造。",
        save: "保存",
        saving: "保存中…",
        saved: "已保存",
        reset: "重置",
        loading: "读取中…",
        unsaved: "有未保存的修改",
        failed: "操作失败",
        count: "{n} 字",
      },
      en: {
        title: "Global persona",
        description:
          "This text is injected at the start of the system prompt for every session, subagents included. Leave it empty to disable.",
        placeholder:
          "e.g. You are a pragmatic senior engineer. Lead with the conclusion, then the reasoning; say so when you are unsure instead of guessing.",
        save: "Save",
        saving: "Saving…",
        saved: "Saved",
        reset: "Reset",
        loading: "Loading…",
        unsaved: "Unsaved changes",
        failed: "Request failed",
        count: "{n} chars",
      },
    };

    var CSS = [
      ".dshgp-root{box-sizing:border-box;width:100%;padding:12px 0 4px;font:inherit;color:var(--dsw-alias-label-primary)}",
      ".dshgp-head{display:flex;align-items:baseline;gap:8px}",
      ".dshgp-title{font-size:14px;font-weight:600}",
      ".dshgp-count{margin-left:auto;font-size:12px;color:var(--dsw-alias-label-tertiary)}",
      ".dshgp-desc{margin-top:4px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}",
      ".dshgp-input{margin-top:8px;box-sizing:border-box;width:100%;min-height:104px;padding:8px 10px;border-radius:var(--dsw-radius-md);border:1px solid var(--dsw-alias-border-secondary);background:var(--dsw-alias-bg-skeleton);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.6;resize:vertical;outline:none}",
      ".dshgp-input:focus-visible{border-color:var(--dsw-alias-brand-primary)}",
      ".dshgp-input::placeholder{color:var(--dsw-alias-label-tertiary)}",
      ".dshgp-actions{margin-top:8px;display:flex;align-items:center;gap:8px}",
      ".dshgp-btn{box-sizing:border-box;height:30px;padding:0 14px;border-radius:var(--dsw-radius-md);border:1px solid var(--dsw-alias-border-secondary);background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer}",
      ".dshgp-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
      ".dshgp-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}",
      ".dshgp-btn:disabled{cursor:default;color:var(--dsw-alias-label-tertiary)}",
      ".dshgp-btn[data-primary=true]:not(:disabled){border-color:transparent;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-inverse, #fff)}",
      ".dshgp-status{font-size:12px;color:var(--dsw-alias-label-tertiary)}",
      ".dshgp-status[data-tone=error]{color:var(--dsw-alias-state-error-primary, #d9544d)}",
      ".dshgp-status[data-tone=ok]{color:var(--dsw-alias-state-success-primary, #2f9e5f)}",
    ].join("");

    function ensureStyles() {
      if (typeof document === "undefined") return;
      if (document.querySelector('style[data-plugin-css="dsh-global-persona"]') !== null) return;
      var tag = document.createElement("style");
      tag.dataset.pluginCss = "dsh-global-persona";
      tag.textContent = CSS;
      document.head.append(tag);
    }

    function GlobalPersonaRow(props) {
      var t = typeof props.t === "function" ? props.t : function (key) { return key; };

      var textState = react.useState("");
      var text = textState[0];
      var setText = textState[1];

      var savedState = react.useState("");
      var saved = savedState[0];
      var setSaved = savedState[1];

      var phaseState = react.useState("loading");
      var phase = phaseState[0];
      var setPhase = phaseState[1];

      var errorState = react.useState("");
      var error = errorState[0];
      var setError = errorState[1];

      react.useEffect(function () {
        var cancelled = false;
        fetch(ROUTE, { method: "GET", cache: "no-store", headers: { accept: "application/json" } })
          .then(function (response) {
            return response.json().catch(function () { return {}; }).then(function (body) {
              if (!response.ok || body.ok !== true) {
                throw new Error(String(body.error ? body.error : response.status));
              }
              return body;
            });
          })
          .then(function (body) {
            if (cancelled) return;
            var value = typeof body.persona === "string" ? body.persona : "";
            setText(value);
            setSaved(value);
            setPhase("idle");
          })
          .catch(function (failure) {
            if (cancelled) return;
            setPhase("error");
            setError(String(failure && failure.message ? failure.message : failure));
          });
        return function () {
          cancelled = true;
        };
      }, []);

      function send(payload) {
        setPhase("saving");
        fetch(ROUTE, {
          method: "PUT",
          cache: "no-store",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        })
          .then(function (response) {
            return response.json().catch(function () { return {}; }).then(function (body) {
              if (!response.ok || body.ok !== true) {
                throw new Error(String(body.error ? body.error : response.status));
              }
              return body;
            });
          })
          .then(function (body) {
            var value = typeof body.persona === "string" ? body.persona : "";
            setText(value);
            setSaved(value);
            setError("");
            setPhase("saved");
          })
          .catch(function (failure) {
            setPhase("error");
            setError(String(failure && failure.message ? failure.message : failure));
          });
      }

      var dirty = text !== saved;
      var busy = phase === "saving" || phase === "loading";

      var status;
      var tone = "";
      if (phase === "loading") status = t("loading");
      else if (phase === "saving") status = t("saving");
      else if (phase === "error") { status = t("failed") + "：" + error; tone = "error"; }
      else if (phase === "saved" && !dirty) { status = t("saved"); tone = "ok"; }
      else if (dirty) status = t("unsaved");
      else status = "";

      return react.createElement("section", { className: "dshgp-root" }, [
        react.createElement("div", { className: "dshgp-head", key: "head" }, [
          react.createElement("span", { className: "dshgp-title", key: "title" }, t("title")),
          react.createElement(
            "span",
            { className: "dshgp-count", key: "count" },
            t("count").replace("{n}", String(text.length)),
          ),
        ]),
        react.createElement("div", { className: "dshgp-desc", key: "desc" }, t("description")),
        react.createElement("textarea", {
          key: "input",
          className: "dshgp-input",
          value: text,
          spellCheck: false,
          placeholder: t("placeholder"),
          disabled: phase === "loading",
          onChange: function (event) { setText(event.target.value); setPhase("idle"); },
        }),
        react.createElement("div", { className: "dshgp-actions", key: "actions" }, [
          react.createElement("button", {
            key: "save",
            type: "button",
            className: "dshgp-btn",
            "data-primary": "true",
            disabled: busy || !dirty,
            onClick: function () { send({ persona: text }); },
          }, t("save")),
          react.createElement("button", {
            key: "reset",
            type: "button",
            className: "dshgp-btn",
            disabled: busy,
            onClick: function () { send({ reset: true }); },
          }, t("reset")),
          react.createElement("span", {
            key: "status",
            className: "dshgp-status",
            "data-tone": tone,
          }, status),
        ]),
      ]);
    }

    function apply(ctx) {
      try {
        ensureStyles();
        ctx.effect(function () {
          return ctx.locale.register(NS, DICTIONARIES);
        }, "dsh-global-persona: dictionaries");

        ctx.slots.inject("settings.general.item", function () {
          return ctx.slots.register({
            name: "settings.general.item",
            id: "global-persona",
            order: 74,
            locale: NS,
          }, GlobalPersonaRow);
        });
      } catch (error) {
        reportFailure("apply", error);
        throw error;
      }
    }

    exports.apply = apply;
    exports.inject = ["slots", "locale"];
    return module.exports;
  },
});