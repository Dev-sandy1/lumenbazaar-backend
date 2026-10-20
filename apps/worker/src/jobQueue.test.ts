import { type Queue } from "bullmq";
import { describe, expect, it, vi } from "vitest";

import { runWithTraceparent } from "@lumenbazaar/shared";

import { enqueueResourceIndexing } from "./jobQueue.js";

describe("BullMQ trace propagation", () => {
  it("copies the current trace context into queued job data", async () => {
    const add = vi.fn(async () => ({}));
    const queue = { add } as unknown as Queue;
    const traceparent = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01";

    await runWithTraceparent(traceparent, () =>
      enqueueResourceIndexing(queue, { resourceId: "resource_test", versionId: "version_test" })
    );

    expect(add).toHaveBeenCalledWith(
      "resource-indexing",
      expect.objectContaining({ traceparent }),
      expect.any(Object)
    );
  });
});
