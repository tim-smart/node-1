/// <reference types="vitest" />
import { effectPlugin } from "@effect/vite-plugin"
import path from "path"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [
    effectPlugin({
      babel: {
        plugins: [["annotate-pure-calls"]],
        compact: false
      },
      tsconfig: "tsconfig.test.json"
    })
  ],
  test: {
    include: ["./test/**/*.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
    exclude: ["./test/utils/**/*.ts", "./test/**/*.init.ts"],
    globals: true,
    deps: {
      inline: ["vitest-mock-process"]
    }
  },
  resolve: {
    alias: {
      "@effect/node/test": path.resolve(__dirname, "/test"),
      "@effect/node": path.resolve(__dirname, "/src")
    }
  }
})
