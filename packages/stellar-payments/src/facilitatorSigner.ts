import {
  createEd25519Signer,
  isFacilitatorStellarSigner,
  type FacilitatorStellarSigner
} from "@x402/stellar";

import {
  LumenError,
  listConfiguredNetworks,
  type AppConfig,
  type NetworkId
} from "@lumenbazaar/shared";

export type SignerSecretSnapshot = {
  secret: string;
  version: string;
};

export type SignerKeyId = string;

export type SignerState = "active" | "retiring" | "retired" | "revoked";

export type SignerStatus = {
  address: string;
  keyVersion: string;
  keyId: SignerKeyId;
  state: SignerState;
  network: NetworkId;
  provider: "environment";
  retireAt?: string;
};

export type SignerAuditEvent = {
  type:
    | "rotation_started"
    | "rotation_promoted"
    | "rotation_rolled_back"
    | "signer_retired"
    | "signer_revoked"
    | "signer_restored";
  keyId: SignerKeyId;
  address: string;
  at: string;
  previousKeyId?: SignerKeyId;
  retireAt?: string;
};

export type FacilitatorSignerProvider = {
  assertReady(): Promise<void>;
  getSigner(): Promise<FacilitatorStellarSigner>;
  getSignerByKeyId(keyId: SignerKeyId): Promise<FacilitatorStellarSigner>;
  getStatus(): Promise<SignerStatus>;
  getAuditEvents(): Promise<ReadonlyArray<SignerAuditEvent>>;
};

export type EnvironmentFacilitatorSignerOptions = {
  expectedAddress: string;
  network: NetworkId;
  readSecret: () => SignerSecretSnapshot | Promise<SignerSecretSnapshot>;
  // Optional previous signer key material for the overlap window.
  readRetiringSecret?: () => SignerSecretSnapshot | Promise<SignerSecretSnapshot> | undefined;
  // How long a retiring signer remains usable after promotion.
  retireWindowMs?: number;
  // Clock injection for testability.
  now?: () => number;
};

type CachedSigner = {
  signer: FacilitatorStellarSigner;
  version: string;
  keyId: SignerKeyId;
};

type RetiringSigner = {
  signer: FacilitatorStellarSigner;
  version: string;
  keyId: SignerKeyId;
  retireAt: number;
};

const DEFAULT_RETIRE_WINDOW_MS = 60_000;

export class EnvironmentFacilitatorSignerProvider implements FacilitatorSignerProvider {
  private cached: CachedSigner | undefined;
  private retiring: RetiringSigner | undefined;
  private revoked = false;
  private audit: SignerAuditEvent[] = [];
  private retireWindowMs: number;
  private now: () => number;

  constructor(private readonly options: EnvironmentFacilitatorSignerOptions) {
    this.retireWindowMs = options.retireWindowMs ?? DEFAULT_RETIRE_WINDOW_MS;
    this.now = options.now ?? (() => Date.now());
  }

  async assertReady(): Promise<void> {
    await this.getSigner();
  }

  async getSigner(): Promise<FacilitatorStellarSigner> {
    if (this.revoked) {
      throw signerUnavailable("Facilitator signer has been revoked.");
    }

    const snapshot = await this.readManagedSnapshot();
    const keyId = signerKeyIdFrom(snapshot.version, snapshot.secret);
    if (this.cached?.version === snapshot.version && this.cached.keyId === keyId) {
      return this.cached.signer;
    }

    const signer = this.buildSigner(snapshot.secret);
    this.cached = { signer, version: snapshot.version, keyId };
    return signer;
  }

  async getSignerByKeyId(keyId: SignerKeyId): Promise<FacilitatorStellarSigner> {
    if (this.revoked) {
      throw signerUnavailable("Facilitator signer has been revoked.");
    }

    const active = await this.getSigner();
    if (this.cached?.keyId === keyId) {
      return active;
    }

    const retiring = this.retiring;
    if (retiring !== undefined && retiring.keyId === keyId) {
      if (this.now() >= retiring.retireAt) {
        this.retiring = undefined;
        this.record({
          type: "signer_retired",
          keyId: retiring.keyId,
          address: retiring.signer.address,
          at: new Date(this.now()).toISOString()
        });
        throw signerUnavailable("Facilitator signer has retired.");
      }
      return retiring.signer;
    }

    throw signerUnavailable("Historical signer is not available.");
  }

  async getStatus(): Promise<SignerStatus> {
    const signer = await this.getSigner();
    const retiring = this.retiring;
    return {
      address: signer.address,
      keyVersion: this.cached?.version ?? "unknown",
      keyId: this.cached?.keyId ?? signerKeyIdFrom("unknown", ""),
      state: "active",
      network: this.options.network,
      provider: "environment",
      ...(retiring === undefined
        ? {}
        : { retireAt: new Date(retiring.retireAt).toISOString() })
    };
  }

  async getAuditEvents(): Promise<ReadonlyArray<SignerAuditEvent>> {
    return this.audit.slice();
  }

  /**
   * Start a controlled rotation. The currently active signer becomes "retiring" and
   * remains usable for the configured overlap window. New work must use the new active
   * key after this call.
   */
  async startRotation(): Promise<void> {
    const previous = this.cached;
    const retireAt = this.now() + this.retireWindowMs;
    if (previous !== undefined) {
      this.retiring = {
        signer: previous.signer,
        version: previous.version,
        keyId: previous.keyId,
        retireAt
      };
    }
    this.cached = undefined;
    this.record({
      type: "rotation_started",
      keyId: previous?.keyId ?? "unknown",
      address: previous?.signer.address ?? "",
      at: new Date(this.now()).toISOString(),
      retireAt: new Date(retireAt).toISOString()
    });
  }

  /**
   * Promote the currently configured secret as the active signer and begin the
   * retirement window for the previous active signer.
   */
  async promote(): Promise<void> {
    const previous = this.cached;
    const snapshot = await this.readManagedSnapshot();
    const keyId = signerKeyIdFrom(snapshot.version, snapshot.secret);
    const signer = this.buildSigner(snapshot.secret);
    const retireAt = this.now() + this.retireWindowMs;
    if (previous !== undefined && previous.keyId !== keyId) {
      this.retiring = {
        signer: previous.signer,
        version: previous.version,
        keyId: previous.keyId,
        retireAt
      };
    }
    this.cached = { signer, version: snapshot.version, keyId };
    this.record({
      type: "rotation_promoted",
      keyId: keyId,
      address: signer.address,
      at: new Date(this.now()).toISOString(),
      ...(previous === undefined ? {} : { previousKeyId: previous.keyId }),
      retireAt: new Date(retireAt).toISOString()
    });
  }

  /**
   * Roll back to the previous signer within the overlap window. The retiring
   * key becomes active again and the currently configured key becomes retiring.
   */
  async rollback(): Promise<void> {
    const retiring = this.retiring;
    if (retiring === undefined) {
      throw signerUnavailable("No retiring signer is available for rollback.");
    }
    if (this.now() >= retiring.retireAt) {
      this.retiring = undefined;
      throw signerUnavailable("Retiring signer has expired.");
    }
    const current = this.cached;
    this.cached = {
      signer: retiring.signer,
      version: retiring.version,
      keyId: retiring.keyId
    };
    this.retiring = current === undefined
      ? undefined
      : {
          signer: current.signer,
          version: current.version,
          keyId: current.keyId,
          retireAt: this.now() + this.retireWindowMs
        };
    this.record({
      type: "rotation_rolled_back",
      keyId: retiring.keyId,
      address: retiring.signer.address,
      at: new Date(this.now()).toISOString(),
      ...(current === undefined ? {} : { previousKeyId: current.keyId })
    });
  }

  /**
   * Force the retiring signer to retire immediately. Useful for incident response.
   */
  async forceRetire(): Promise<void> {
    const retiring = this.retiring;
    if (retiring === undefined) {
      return;
    }
    this.retiring = undefined;
    this.record({
      type: "signer_retired",
      keyId: retiring.keyId,
      address: retiring.signer.address,
      at: new Date(this.now()).toISOString()
    });
  }

  rotate(): void {
    this.cached = undefined;
  }

  revoke(): void {
    const previous = this.cached;
    this.revoked = true;
    this.cached = undefined;
    this.retiring = undefined;
    if (previous !== undefined) {
      this.record({
        type: "signer_revoked",
        keyId: previous.keyId,
        address: previous.signer.address,
        at: new Date(this.now()).toISOString()
      });
    }
  }

  restore(): void {
    this.revoked = false;
    this.cached = undefined;
    this.record({
      type: "signer_restored",
      keyId: "unknown",
      address: "",
      at: new Date(this.now()).toISOString()
    });
  }

  private buildSigner(secret: string): FacilitatorStellarSigner {
    let signer: FacilitatorStellarSigner;
    try {
      signer = createEd25519Signer(secret, this.options.network);
    } catch {
      throw signerUnavailable("Facilitator signing material is invalid.");
    }

    if (!isFacilitatorStellarSigner(signer)) {
      throw signerUnavailable("Facilitator signer does not implement the required interface.");
    }
    if (signer.address !== this.options.expectedAddress) {
      throw signerUnavailable("Facilitator signer address does not match configuration.");
    }
    return signer;
  }

  private async readManagedSnapshot(): Promise<SignerSecretSnapshot> {
    let snapshot: SignerSecretSnapshot;
    try {
      snapshot = await this.options.readSecret();
    } catch {
      throw signerUnavailable("Facilitator signing material is unavailable.");
    }

    if (snapshot.secret.length === 0 || snapshot.version.length === 0) {
      throw signerUnavailable("Facilitator signing material is unavailable.");
    }
    return snapshot;
  }

  private record(event: SignerAuditEvent): void {
    this.audit.push(event);
  }
}

export function signerKeyIdFrom(version: string, secret: string): SignerKeyId {
  // Derive a stable identifier from the version label and a deterministic hash of the
  // secret so in-flight records can reference the signer without exposing key material.
  if (version.length === 0) {
    return "unknown";
  }
  const digest = hashString(secret);
  return `${version}:${digest}`;
}

export function createRuntimeFacilitatorSignerProvider(
  config: AppConfig,
  environment: NodeJS.ProcessEnv = process.env
): FacilitatorSignerProvider | undefined {
  if (config.signer.provider === "disabled") {
    return undefined;
  }

  const activeNetwork = listConfiguredNetworks(config)[0]?.id;
  if (activeNetwork === undefined || config.signer.network !== activeNetwork) {
    throw signerUnavailable("Facilitator signer network does not match the active network.");
  }

  const retireWindowMs =
    config.signer.overlapSeconds > 0
      ? config.signer.overlapSeconds * 1000
      : undefined;

  return new EnvironmentFacilitatorSignerProvider({
    expectedAddress: config.facilitatorAccount,
    network: config.signer.network,
    ...(retireWindowMs === undefined ? {} : { retireWindowMs }),
    readSecret: () => ({
      secret: environment.FACILITATOR_SIGNING_KEY ?? "",
      version:
        environment.FACILITATOR_SIGNING_KEY_VERSION ?? config.signer.keyVersion ?? ""
    })
  });
}

export async function assertRuntimeSignerReady(
  provider: FacilitatorSignerProvider | undefined
): Promise<void> {
  await provider?.assertReady();
}

function signerUnavailable(message: string) {
  return new LumenError("SETTLEMENT_FAILED", message, {
    details: { component: "facilitator_signer" }
  });
}

function hashString(value: string): string {
  // Small deterministic non-cryptographic hash for public identifiers. Signing
  // material is never included in the result.
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
