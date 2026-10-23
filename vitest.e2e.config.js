import { defineConfig } from "vite";

export default defineConfig({
  test: {
    include: ["./e2e/**/*.test.ts"],
    environment: "node",
    testTimeout: 20000,
  },
});
