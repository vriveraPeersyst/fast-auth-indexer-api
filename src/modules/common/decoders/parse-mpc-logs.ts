// Parsers for the structured logs emitted by the v1.signer MPC contract
// (commit 1ee251d, NEAR mainnet). Pinned to that commit; if
// `contract_source_metadata` reports a new commit, regenerate fixtures with
// the validation script before trusting steady-state output.
//
// Two log shapes:
//
//   sign:    "sign: predecessor=AccountId(\"X\"), request=SignRequestArgs { path: \"...\", payload_v2: Some(Ecdsa/Eddsa(BoundedVec { inner: [bytes], bound: N })), domain_id: ..., key_version: ... }"
//   respond: "respond: signer=Y, request=SignatureRequest { tweak: Tweak([32 bytes]), payload: Ecdsa/Eddsa(BoundedVec { inner: [bytes] }) }"
//
// Correlation strategy (Path B'): match by `{scheme}:{hex(payload.inner)}`.
// The payload bytes appear identically on both sides; the tweak / path only
// on one side and so are not used for matching.

export type Scheme = "ecdsa" | "eddsa" | "secp256k1-legacy";

export type ParsedSignLog = {
    predecessorId: string;
    path: string;
    scheme: Scheme;
    payloadHex: string;
    domainId: number | null;
    keyVersion: number | null;
    requestKey: string;
};

export type ParsedRespondLog = {
    signerId: string;
    scheme: Scheme;
    payloadHex: string;
    requestKey: string;
};

const SIGN_PREFIX = "sign:";
const RESPOND_PREFIX = "respond:";

const PREDECESSOR_RE = /predecessor=AccountId\("([^"]+)"\)/;
const PATH_RE = /path:\s*"((?:[^"\\]|\\.)*)"/;
const SIGN_PAYLOAD_RE = /payload_v2:\s*Some\((Ecdsa|Eddsa)\(BoundedVec\s*\{\s*inner:\s*\[([0-9,\s]+)\]/;
const RESPOND_SIGNER_RE = /signer=([A-Za-z0-9_\-.]+)/;
const RESPOND_PAYLOAD_RE = /payload:\s*(Ecdsa|Eddsa)\(BoundedVec\s*\{\s*inner:\s*\[([0-9,\s]+)\]/;
const DOMAIN_ID_RE = /domain_id:\s*Some\((\d+)\)/;
const KEY_VERSION_RE = /key_version:\s*(\d+)/;

function bytesToHex(bytes: number[]): string {
    let out = "";
    for (const b of bytes) {
        out += (b & 0xff).toString(16).padStart(2, "0");
    }
    return out;
}

function parseByteArray(raw: string): number[] | null {
    const parts = raw.split(",");
    const bytes: number[] = [];
    for (const p of parts) {
        const trimmed = p.trim();
        if (trimmed === "") continue;
        const n = Number(trimmed);
        if (!Number.isInteger(n) || n < 0 || n > 255) return null;
        bytes.push(n);
    }
    return bytes;
}

function buildRequestKey(scheme: Scheme, payloadHex: string): string {
    return `${scheme}:${payloadHex}`;
}

function rustVariantToScheme(variant: string): Scheme | null {
    if (variant === "Ecdsa") return "ecdsa";
    if (variant === "Eddsa") return "eddsa";
    return null;
}

export function parseSignLog(log: string): ParsedSignLog | null {
    if (!log.startsWith(SIGN_PREFIX)) return null;

    const predecessor = log.match(PREDECESSOR_RE);
    const path = log.match(PATH_RE);
    const payload = log.match(SIGN_PAYLOAD_RE);
    if (!predecessor || !path || !payload) return null;

    const scheme = rustVariantToScheme(payload[1]);
    if (!scheme) return null;

    const bytes = parseByteArray(payload[2]);
    if (!bytes) return null;

    const payloadHex = bytesToHex(bytes);
    const domainIdMatch = log.match(DOMAIN_ID_RE);
    const keyVersionMatch = log.match(KEY_VERSION_RE);

    return {
        predecessorId: predecessor[1],
        path: path[1],
        scheme,
        payloadHex,
        domainId: domainIdMatch ? Number.parseInt(domainIdMatch[1], 10) : null,
        keyVersion: keyVersionMatch ? Number.parseInt(keyVersionMatch[1], 10) : null,
        requestKey: buildRequestKey(scheme, payloadHex),
    };
}

export function parseRespondLog(log: string): ParsedRespondLog | null {
    if (!log.startsWith(RESPOND_PREFIX)) return null;

    const signer = log.match(RESPOND_SIGNER_RE);
    const payload = log.match(RESPOND_PAYLOAD_RE);
    if (!signer || !payload) return null;

    const scheme = rustVariantToScheme(payload[1]);
    if (!scheme) return null;

    const bytes = parseByteArray(payload[2]);
    if (!bytes) return null;

    const payloadHex = bytesToHex(bytes);

    return {
        signerId: signer[1],
        scheme,
        payloadHex,
        requestKey: buildRequestKey(scheme, payloadHex),
    };
}
