import { buildApiApp } from "./app.js";
import { loadConfig } from "@lumenbazaar/shared";
import {
  assertRuntimeSignerReady,
  createRuntimeFacilitatorSignerProvider
} from "@lumenbazaar/stellar-payments";


const config = loadConfig();
const signerProvider = createRuntimeFacilitatorSignerProvider(config);
await assertRuntimeSignerReady(signerProvider);

const app = buildApiApp({
  config,
  // Only forward the signer provider when one was actually configured;
  // otherwise leave the option absent so downstream code can detect the
  // "no signer" case explicitly.
  ...(signerProvider === undefined ? {} : { signerProvider })
});

await app.listen({ host: config.api.host, port: config.api.port });
