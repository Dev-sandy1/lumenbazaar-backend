import { type Job, type Queue, Worker } from "bullmq";

import {
  disconnectPrismaClient,
  getPrismaClient,
  type AppConfig,
  loadConfig,
  redactSensitiveText,
  runWithTraceparent,
  safeIdentifierHash,
  startTraceSpan
} from "@lumenbazaar/shared";
import { settlementReconciliationJobId } from "@lumenbazaar/stellar-payments";
import { createBullMqConnection, createBullMqQueue, queueNames, type QueueName } from "./queues.js";
import { handleNetworkHealth, type NetworkHealthJobData } from "./workers/networkHealth.js";
import { handleOutboxRelay, type OutboxRelayJobData } from "./workers/outboxRelay.js";
import { handleOutboxCleanup, type OutboxCleanupJobData } from "./workers/outboxCleanup.js";
import {
  handleReceiptFinalizer,
  type ReceiptFinalizerJobData
} from "./workers/receiptFinalizer.js";
import {
  handleResourceIndexing,
  type ResourceIndexingJobData
} from "./workers/resourceIndexing.js";
import { handleSearchSync, type SearchSyncJobData } from "./workers/searchSync.js";
import {
  handleSettlementConfirmation,
  markReconciliationDeadLetter,
  resumePendingSettlements,
  type SettlementConfirmationJobData
} from "./workers/settlementConfirmation.js";
import {
  handleStalePaymentCleanup,
  type StalePaymentCleanupJobData
} from "./workers/stalePaymentCleanup.js";

async function traceWorkerJob(
  job: Job<Record<string, unknown>>,
  queueName: QueueName,
  callback: () => Promise<void>
) {
  const parent = typeof job.data.traceparent === "string" ? job.data.traceparent : undefined;
  return runWithTraceparent(parent, async () => {
    const settlementHash = safeIdentifierHash(job.data.settlementId);
    const receiptHash = safeIdentifierHash(job.data.receiptId);
    const span = startTraceSpan("worker.job", {
      "messaging.destination.name": queueName,
      "messaging.operation": "process",
      "app.job.name": job.name,
      ...(settlementHash === undefined ? {} : { "app.settlement.id_hash": settlementHash }),
      ...(receiptHash === undefined ? {} : { "app.receipt.id_hash": receiptHash })
    }, 4);
    return span.run(async () => {
      try {
        await callback();
      } finally {
        span.end();
      }
    });
  });
}

export type WorkerJob = {
  id: string;
  name: string;
  queueName: QueueName;
  data: Record<string, unknown>;
};

export type WorkerBackend = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  enqueue: (job: WorkerJob) => Promise<void>;
  processedJobs: () => WorkerJob[];
};

export class InMemoryWorkerBackend implements WorkerBackend {
  private readonly jobs: WorkerJob[] = [];
  private readonly processed: WorkerJob[] = [];
  private running = false;

  async start() {
    this.running = true;
    await this.drain();
  }

  async stop() {
    this.running = false;
  }

  async enqueue(job: WorkerJob) {
    this.jobs.push(job);
    await this.drain();
  }

  processedJobs() {
    return [...this.processed];
  }

  private async drain() {
    if (!this.running) {
      return;
    }

    while (this.jobs.length > 0) {
      const job = this.jobs.shift();

      if (job !== undefined) {
        this.processed.push(job);
      }
    }
  }
}

export class BullMqWorkerBackend implements WorkerBackend {
  private readonly connection;
  private readonly workers: Worker[] = [];
  private readonly processed: WorkerJob[] = [];
  private readonly settlementQueue: Queue;
  private readonly deadLetterQueue: Queue;

  constructor(private readonly config: AppConfig) {
    this.connection = createBullMqConnection(config);
    this.settlementQueue = createBullMqQueue(queueNames.settlementConfirmation, config);
    this.deadLetterQueue = createBullMqQueue(queueNames.deadLetter, config);
  }

  async start() {
    this.workers.push(
      new Worker(
        queueNames.resourceIndexing,
        async (job: Job<Record<string, unknown>>) =>
          traceWorkerJob(job, queueNames.resourceIndexing, async () => {
            await handleResourceIndexing(job as Job<ResourceIndexingJobData>);
            this.recordProcessedJob(job, queueNames.resourceIndexing);
          }),
        {
          connection: this.connection
        }
      )
    );

    // Add settlement confirmation worker
    const settlementWorker = new Worker(
      queueNames.settlementConfirmation,
      async (job: Job<Record<string, unknown>>) =>
        traceWorkerJob(job, queueNames.settlementConfirmation, async () => {
          await handleSettlementConfirmation(
            job as Job<SettlementConfirmationJobData>,
            this.config
          );
          this.recordProcessedJob(job, queueNames.settlementConfirmation);
        }),
      {
        connection: this.connection
      }
    );
    settlementWorker.on("failed", (job, error) => {
      if (job !== undefined && job.attemptsMade >= (job.opts.attempts ?? 1)) {
        void this.deadLetterSettlement(job as Job<SettlementConfirmationJobData>, error);
      }
    });
    this.workers.push(settlementWorker);

    // Add search sync worker
    this.workers.push(
      new Worker(
        queueNames.searchSync,
        async (job: Job<Record<string, unknown>>) =>
          traceWorkerJob(job, queueNames.searchSync, async () => {
            await handleSearchSync(job as Job<SearchSyncJobData>);
            this.recordProcessedJob(job, queueNames.searchSync);
          }),
        {
          connection: this.connection
        }
      )
    );

    // Add network health worker
    this.workers.push(
      new Worker(
        queueNames.networkHealth,
        async (job: Job<Record<string, unknown>>) =>
          traceWorkerJob(job, queueNames.networkHealth, async () => {
            await handleNetworkHealth(job as Job<NetworkHealthJobData>);
            this.recordProcessedJob(job, queueNames.networkHealth);
          }),
        {
          connection: this.connection
        }
      )
    );

    // Add outbox relay worker
    this.workers.push(
      new Worker(
        queueNames.outboxRelay,
        async (job: Job<Record<string, unknown>>) =>
          traceWorkerJob(job, queueNames.outboxRelay, async () => {
            await handleOutboxRelay(job as Job<OutboxRelayJobData>, this.config);
            this.recordProcessedJob(job, queueNames.outboxRelay);
          }),
        {
          connection: this.connection
        }
      )
    );

    // Add receipt finalizer worker
    this.workers.push(
      new Worker(
        queueNames.receiptFinalizer,
        async (job: Job<Record<string, unknown>>) =>
          traceWorkerJob(job, queueNames.receiptFinalizer, async () => {
            await handleReceiptFinalizer(job as Job<ReceiptFinalizerJobData>);
            this.recordProcessedJob(job, queueNames.receiptFinalizer);
          }),
        {
          connection: this.connection
        }
      )
    );

    // Add stale payment cleanup worker
    this.workers.push(
      new Worker(
        queueNames.stalePaymentCleanup,
        async (job: Job<Record<string, unknown>>) =>
          traceWorkerJob(job, queueNames.stalePaymentCleanup, async () => {
            await handleStalePaymentCleanup(job as Job<StalePaymentCleanupJobData>);
            this.recordProcessedJob(job, queueNames.stalePaymentCleanup);
          }),
        {
          connection: this.connection
        }
      )
    );

    // Add outbox cleanup worker
    this.workers.push(
      new Worker(
        queueNames.outboxCleanup,
        async (job: Job<Record<string, unknown>>) =>
          traceWorkerJob(job, queueNames.outboxCleanup, async () => {
            await handleOutboxCleanup(job as Job<OutboxCleanupJobData>, this.config);
            this.recordProcessedJob(job, queueNames.outboxCleanup);
          }),
        {
          connection: this.connection
        }
      )
    );

    await Promise.all(this.workers.map(async (worker) => worker.waitUntilReady()));
    await this.resumePendingSettlements();
  }

  async stop() {
    await Promise.all(this.workers.map((worker) => worker.close()));
    await Promise.all([this.settlementQueue.close(), this.deadLetterQueue.close()]);
    await this.connection.quit();
    await disconnectPrismaClient();
  }

  async enqueue(_job: WorkerJob) {
    throw new Error("Use BullMQ Queue instances to enqueue jobs for BullMqWorkerBackend.");
  }

  processedJobs() {
    return [...this.processed];
  }

  private recordProcessedJob(job: Job<Record<string, unknown>>, queueName: QueueName) {
    this.processed.push({
      id: String(job.id),
      name: job.name,
      queueName,
      data: job.data
    });
  }

  private async resumePendingSettlements() {
    await resumePendingSettlements(getPrismaClient(), this.settlementQueue);
  }

  private async deadLetterSettlement(job: Job<SettlementConfirmationJobData>, error: Error) {
    const reason =
      error.name === "ReconciliationPendingError"
        ? `Reconciliation retries exhausted: ${redactSensitiveText(error.message).slice(0, 300)}`
        : "Reconciliation retries exhausted after an internal dependency failure.";
    await this.deadLetterQueue.add(
      "settlement-reconciliation-dead-letter",
      {
        sourceJobId: String(job.id),
        sourceQueue: queueNames.settlementConfirmation,
        correlationId: job.data.correlationId,
        traceparent: (job.data as SettlementConfirmationJobData & { traceparent?: string }).traceparent,
        paymentAttemptId: job.data.paymentAttemptId,
        settlementId: job.data.settlementId,
        reason
      },
      {
        jobId: `dead-letter-${settlementReconciliationJobId(job.data.paymentAttemptId)}`,
        removeOnComplete: false,
        removeOnFail: false
      }
    );
    await markReconciliationDeadLetter(getPrismaClient(), job.data, reason);
  }
}

export type WorkerAppOptions = {
  config?: AppConfig;
  backend?: WorkerBackend;
};

export function createWorkerApp(options: WorkerAppOptions = {}) {
  const config = options.config ?? loadConfig();
  const backend =
    options.backend ??
    (config.nodeEnv === "production" && config.lumenEnv !== "local"
      ? new BullMqWorkerBackend(config)
      : new InMemoryWorkerBackend());
  let shutdownRegistered = false;

  return {
    config,
    queueNames,
    async start() {
      await backend.start();
      registerGracefulShutdownOnce(async () => {
        await backend.stop();
      }, shutdownRegistered);
      shutdownRegistered = true;
    },
    async stop() {
      await backend.stop();
    },
    async enqueueTestJob() {
      await backend.enqueue({
        id: "job_test",
        name: "worker.health-check",
        queueName: queueNames.resourceIndexing,
        data: {
          ok: true
        }
      });
    },
    processedJobs() {
      return backend.processedJobs();
    }
  };
}

function registerGracefulShutdownOnce(handler: () => Promise<void>, alreadyRegistered: boolean) {
  if (alreadyRegistered) {
    return;
  }

  const shutdown = async () => {
    await handler();
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
