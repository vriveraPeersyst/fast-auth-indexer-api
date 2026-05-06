/**
 * Decoder for FastAuth sign() payloads (NEP-366 SignableMessage).
 *
 * The bytes passed to FastAuth.sign() as `sign_payload` are:
 *   1. u32 LE discriminant = (1 << 30) + 366  (NEP-366 DelegateAction)
 *   2. Borsh-serialized DelegateAction:
 *        sender_id: AccountId          // u32 len + utf-8 bytes
 *        receiver_id: AccountId        // u32 len + utf-8 bytes
 *        actions: Vec<NonDelegateAction>
 *        nonce: u64                    // 8 bytes
 *        max_block_height: u64         // 8 bytes
 *        public_key: PublicKey         // 1 byte variant + 32 (ed25519) or 64 (secp256k1)
 *
 * Two extractors:
 *   - decodeSignActionType: cheap, just reads the first action's enum tag
 *   - decodeSignDelegatePublicKey: full Borsh skip past actions[] to read the
 *     trailing public_key field, used to populate the FastAuth pubkey set
 *     in-memory and match consumer txs in the same iteration.
 */

const NEP_366_DELEGATE_DISCRIMINANT = (1 << 30) + 366; // 1_073_742_190

const ACTION_TAG_TO_NAME: Record<number, string> = {
    0: "CreateAccount",
    1: "DeployContract",
    2: "FunctionCall",
    3: "Transfer",
    4: "Stake",
    5: "AddKey",
    6: "DeleteKey",
    7: "DeleteAccount",
    8: "Delegate",
};

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function readU32LE(buf: Uint8Array, offset: number): number | null {
    if (offset + 4 > buf.length) return null;
    return ((buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16) | (buf[offset + 3] << 24)) >>> 0) as number;
}

function skipLengthPrefixed(buf: Uint8Array, offset: number): number {
    const len = readU32LE(buf, offset);
    if (len === null) return -1;
    const next = offset + 4 + len;
    if (next > buf.length) return -1;
    return next;
}

function skipPublicKey(buf: Uint8Array, offset: number): number {
    if (offset + 1 > buf.length) return -1;
    const variant = buf[offset];
    const keyLen = variant === 0 ? 32 : variant === 1 ? 64 : -1;
    if (keyLen < 0) return -1;
    const next = offset + 1 + keyLen;
    if (next > buf.length) return -1;
    return next;
}

function skipAccessKey(buf: Uint8Array, offset: number): number {
    offset += 8; // nonce u64
    if (offset + 1 > buf.length) return -1;
    const permission = buf[offset];
    offset += 1;
    if (permission === 1) return offset;
    if (permission === 0) {
        if (offset + 1 > buf.length) return -1;
        const allowanceTag = buf[offset];
        offset += 1;
        if (allowanceTag === 1) offset += 16;
        offset = skipLengthPrefixed(buf, offset);
        if (offset < 0) return -1;
        const methodCount = readU32LE(buf, offset);
        if (methodCount === null) return -1;
        offset += 4;
        for (let i = 0; i < methodCount; i++) {
            offset = skipLengthPrefixed(buf, offset);
            if (offset < 0) return -1;
        }
        return offset;
    }
    return -1;
}

function skipAction(buf: Uint8Array, offset: number): number {
    if (offset + 1 > buf.length) return -1;
    const tag = buf[offset];
    offset += 1;
    switch (tag) {
        case 0:
            return offset;
        case 1:
            return skipLengthPrefixed(buf, offset);
        case 2: {
            offset = skipLengthPrefixed(buf, offset);
            if (offset < 0) return -1;
            offset = skipLengthPrefixed(buf, offset);
            if (offset < 0) return -1;
            offset += 8 + 16;
            return offset > buf.length ? -1 : offset;
        }
        case 3:
            return offset + 16 > buf.length ? -1 : offset + 16;
        case 4: {
            offset += 16;
            return skipPublicKey(buf, offset);
        }
        case 5: {
            offset = skipPublicKey(buf, offset);
            if (offset < 0) return -1;
            return skipAccessKey(buf, offset);
        }
        case 6:
            return skipPublicKey(buf, offset);
        case 7:
            return skipLengthPrefixed(buf, offset);
        default:
            return -1;
    }
}

function base58Encode(bytes: Uint8Array): string {
    if (bytes.length === 0) return "";

    let zeros = 0;
    while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

    const digits: number[] = [];
    for (let i = zeros; i < bytes.length; i++) {
        let carry = bytes[i];
        for (let j = 0; j < digits.length; j++) {
            carry += digits[j] * 256;
            digits[j] = carry % 58;
            carry = Math.floor(carry / 58);
        }
        while (carry > 0) {
            digits.push(carry % 58);
            carry = Math.floor(carry / 58);
        }
    }

    let result = "1".repeat(zeros);
    for (let i = digits.length - 1; i >= 0; i--) {
        result += BASE58_ALPHABET[digits[i]];
    }
    return result;
}

export function decodeSignActionType(payload: number[] | Uint8Array | null | undefined): string | null {
    if (!payload) return null;

    const buf = payload instanceof Uint8Array ? payload : Uint8Array.from(payload);
    if (buf.length < 16) return null;

    const discriminant = readU32LE(buf, 0);
    if (discriminant !== NEP_366_DELEGATE_DISCRIMINANT) return "Raw";

    let offset = 4;
    offset = skipLengthPrefixed(buf, offset);
    if (offset < 0) return null;
    offset = skipLengthPrefixed(buf, offset);
    if (offset < 0) return null;

    const actionsCount = readU32LE(buf, offset);
    if (actionsCount === null) return null;
    offset += 4;

    if (actionsCount === 0) return "Empty";
    if (offset >= buf.length) return null;

    const tag = buf[offset];
    return ACTION_TAG_TO_NAME[tag] ?? `Unknown(${tag})`;
}

function tryDecodeDelegateAction(buf: Uint8Array, startOffset: number): string | null {
    let offset = startOffset;

    offset = skipLengthPrefixed(buf, offset);
    if (offset < 0) return null;
    offset = skipLengthPrefixed(buf, offset);
    if (offset < 0) return null;

    const actionsCount = readU32LE(buf, offset);
    if (actionsCount === null) return null;
    offset += 4;
    for (let i = 0; i < actionsCount; i++) {
        offset = skipAction(buf, offset);
        if (offset < 0) return null;
    }

    offset += 16;
    if (offset + 1 > buf.length) return null;

    const variant = buf[offset];
    offset += 1;
    const keyLen = variant === 0 ? 32 : variant === 1 ? 64 : -1;
    if (keyLen < 0) return null;
    if (offset + keyLen > buf.length) return null;

    const keyBytes = buf.slice(offset, offset + keyLen);
    const prefix = variant === 0 ? "ed25519:" : "secp256k1:";
    return prefix + base58Encode(keyBytes);
}

export function decodeSignDelegatePublicKey(payload: number[] | Uint8Array | null | undefined): string | null {
    if (!payload) return null;

    const buf = payload instanceof Uint8Array ? payload : Uint8Array.from(payload);
    if (buf.length < 16) return null;

    const discriminant = readU32LE(buf, 0);
    if (discriminant === NEP_366_DELEGATE_DISCRIMINANT) {
        const decoded = tryDecodeDelegateAction(buf, 4);
        if (decoded) return decoded;
    }

    return tryDecodeDelegateAction(buf, 0);
}
