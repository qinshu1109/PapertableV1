/**
 * client 半 bundle(browser):tsdown 打成 window.__ModuleLoader__.load 工厂形态,
 * react / dsh client 包保持 external(由 loader 的 seed/statics 供给)。
 * host 半仍由 tsc 构建(scripts.build:host),本配置只产 lib/client.js。
 * 形态照抄已验证样板 dsh-routing-suite/injector/tsdown.config.ts。
 */
import type { UserConfig } from "tsdown";

const PLUGIN_ID = "@papertable/dsh-paperweight";

const CLIENT_EXTERNALS = [
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "cordis",
  "@deepseek-ai/dsh-client-runtime",
  "@deepseek-ai/dsh-client-runtime/client",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-ui-input-trigger",
];

const clientBundle: UserConfig = {
  entry: { client: "src/client/index.ts" },
  outDir: "lib",
  format: "cjs",
  platform: "browser",
  dts: false,
  sourcemap: true,
  clean: false,
  define: {
    "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "production"),
  },
  deps: {
    neverBundle: [...CLIENT_EXTERNALS],
    alwaysBundle: (id: string) => !CLIENT_EXTERNALS.includes(id),
  },
  outputOptions: {
    entryFileNames: "client.js",
    banner: "window.__ModuleLoader__.load({ id: " + JSON.stringify(PLUGIN_ID) + ", factory: (require) => {",
    footer: "return module.exports; } });",
    intro: "var module = { exports: {} }; var exports = module.exports;",
    codeSplitting: false,
  },
};

export default [clientBundle] satisfies UserConfig[];
