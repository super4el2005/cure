import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { defineConfig, loadEnv } from "@rsbuild/core";
import { pluginBabel } from "@rsbuild/plugin-babel";
import { pluginReact } from "@rsbuild/plugin-react";
import { RsdoctorRspackPlugin } from "@rsdoctor/core";
import { sentryWebpackPlugin } from "@sentry/webpack-plugin";
import { InjectManifest } from "@serwist/webpack-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/rsbuild";

// Convex's deployment URL is public and is needed by both client and SSR.
const { publicVars } = loadEnv({ prefixes: ["CONVEX_URL", "CONVEX_SITE_URL", "PUBLIC_SENTRY_"] });
const shellRevision = randomUUID();
const linguiConfigPath = resolve(import.meta.dirname, "lingui.config.ts");

export default defineConfig({
  resolve: {
    alias: {
      "@": import.meta.dirname,
    },
  },
  source: {
    define: {
      "import.meta.env.PUBLIC_SENTRY_DSN": JSON.stringify(
        process.env.PUBLIC_SENTRY_DSN || process.env.SENTRY_DSN || "",
      ),
      ...publicVars,
      "import.meta.env.PUBLIC_SENTRY_RELEASE": JSON.stringify(
        process.env.SENTRY_RELEASE || process.env.VERCEL_GIT_COMMIT_SHA || "development",
      ),
      "import.meta.env.PUBLIC_SENTRY_ENVIRONMENT": JSON.stringify(
        process.env.VERCEL_ENV || "development",
      ),
    },
  },
  server: {
    port: 3000,
  },
  dev: {
    watchFiles: [{ paths: [linguiConfigPath], type: "restart" }],
  },
  plugins: [
    pluginBabel({
      babelLoaderOptions: (_config, { addPlugins }) => {
        addPlugins(["@lingui/babel-plugin-lingui-macro"]);
      },
    }),
    pluginReact(),
    tanstackStart({
      spa: { enabled: true, prerender: { outputPath: "/_shell.html" } },
    }),
  ],
  tools: {
    rspack: (config, { environment, isProd }) => {
      if (environment.name === "ssr") {
        // Optional native WebSocket accelerators are unnecessary for HTTP AI APIs.
        config.resolve ??= {};
        config.resolve.alias = {
          ...config.resolve.alias,
          bufferutil: false,
          "utf-8-validate": false,
        };
      }
      config.module ??= {};
      config.module.rules ??= [];
      config.module.rules.push({
        test: /\.po$/,
        type: "javascript/auto",
        use: [
          {
            loader: "@lingui/loader",
            options: { config: linguiConfigPath, failOnCompileError: true },
          },
        ],
      });
      config.plugins ??= [];
      if (
        isProd &&
        process.env.SENTRY_AUTH_TOKEN &&
        process.env.SENTRY_ORG &&
        process.env.SENTRY_PROJECT
      ) {
        config.devtool = "hidden-source-map";
        const directory = environment.name === "client" ? "dist/client" : "dist/server";
        config.plugins.push(
          sentryWebpackPlugin({
            org: process.env.SENTRY_ORG,
            project: process.env.SENTRY_PROJECT,
            authToken: process.env.SENTRY_AUTH_TOKEN,
            release: {
              name:
                process.env.SENTRY_RELEASE || process.env.VERCEL_GIT_COMMIT_SHA || "development",
            },
            sourcemaps: {
              assets: `${directory}/**`,
              filesToDeleteAfterUpload: `${directory}/**/*.map`,
            },
            telemetry: false,
          }),
        );
      }
      if (isProd && environment.name === "client") {
        config.plugins.push(
          new InjectManifest({
            swSrc: resolve(import.meta.dirname, "src/sw.ts"),
            swDest: "sw.js",
            exclude: [/\.map$/, /\.html$/],
            additionalPrecacheEntries: [{ url: "/_shell.html", revision: shellRevision }],
          }),
        );
      }
      if (process.env.RSDOCTOR === "true") {
        config.plugins.push(new RsdoctorRspackPlugin({}));
      }
    },
  },
});
