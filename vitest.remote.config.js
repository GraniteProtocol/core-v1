/// <reference types="vitest" />

import { defineConfig } from "vite";
import {
  vitestSetupFilePath,
  getClarinetVitestsArgv,
} from "@stacks/clarinet-sdk/vitest";

export default defineConfig({
  test: {
    include: ["./remote-tests/**/*.test.ts"],
    environment: "clarinet",
    singleThread: true,
    setupFiles: [vitestSetupFilePath],
    testTimeout: 60000,
    environmentOptions: {
      clarinet: {
        ...getClarinetVitestsArgv(),
      },
    },
  },
});
