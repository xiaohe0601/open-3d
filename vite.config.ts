import { defineConfig } from "vite-plus";

export default defineConfig({
  defaultPackage: "./apps/web",
  run: {
    tasks: {
      "workspace-dev": {
        command: "vp -C apps/web dev",
        cache: false,
      },
      "workspace-build": {
        command: "vp -C apps/web build",
        dependsOn: ["workspace-typecheck"],
      },
      "workspace-test": {
        command: "vp test run",
      },
      "workspace-test-coverage": {
        command:
          "vp test run --coverage.enabled --coverage.provider=v8 --coverage.reporter=text --coverage.reporter=html",
        cache: false,
      },
      "workspace-web-typecheck": {
        command: "vp -C apps/web check --no-fmt --no-lint",
      },
      "workspace-e2e": {
        command: "vp -C apps/web test run",
        cache: false,
      },
      "workspace-format-check": {
        command: "vp fmt apps packages tests tooling vite.config.ts package.json pnpm-workspace.yaml --check",
      },
      "workspace-lint": {
        command: "vp lint",
      },
      "workspace-typecheck": {
        command: "vp check --no-fmt --no-lint",
      },
      "workspace-ci": {
        command: "node -e 'console.log(\"CI task graph completed\")'",
        dependsOn: [
          "workspace-build",
          "workspace-test",
          "workspace-e2e",
          "workspace-lint",
          "workspace-format-check",
          "workspace-typecheck",
          "workspace-web-typecheck",
        ],
      },
    },
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
    ignorePatterns: ["**/dist/**", "**/node_modules/**"],
  },
  test: {
    include: ["apps/web/src/**/*.test.ts", "packages/**/*.test.mjs", "tests/**/*.test.mjs"],
    exclude: ["**/node_modules/**", "apps/web/e2e/**"],
  },
});