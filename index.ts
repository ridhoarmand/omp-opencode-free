// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Root entry point so Pi's startup Extensions list shows the label
 * "pi-opencode-free" (a nested path would display as "src").
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function opencodeDirectExtension(pi: ExtensionAPI): Promise<void> {
  try {
    const compat = await import("@earendil-works/pi-ai/compat");
    if (typeof compat.getApiProvider === "function" && typeof compat.registerApiProvider === "function") {
      const { default: stockExtension } = await import("./src/index.js");
      return stockExtension(pi);
    }
  } catch {
    // OMP runtime lacks @earendil-works/pi-ai/compat
  }
  const { default: ompExtension } = await import("./omp-entry.js");
  return ompExtension(pi);
}
