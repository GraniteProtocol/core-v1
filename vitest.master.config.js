/// <reference types="vitest" />

import { defineConfig } from "vite";
import {
  vitestSetupFilePath,
  getClarinetVitestsArgv,
} from "@stacks/clarinet-sdk/vitest";

// Runs the 97176 master-build reproduction against the repo's own Clarinet.toml.
// The live-fork reproduction uses vitest.remote.config.js instead.
export default defineConfig({
  test: {
    include: ["./remote-tests/97176-master.test.ts"],
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
