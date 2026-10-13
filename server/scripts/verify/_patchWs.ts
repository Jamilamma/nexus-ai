// Must be imported FIRST: points the live STT client at a local fake Soniox server.
// (The Soniox URL is configurable via SONIOX_WS_URL, so `ws` itself no longer needs patching.)
export const VENDOR_PORT = 5633;
process.env.SONIOX_WS_URL = `ws://localhost:${VENDOR_PORT}`;
process.env.SONIOX_API_KEY = "fake-soniox-key";
