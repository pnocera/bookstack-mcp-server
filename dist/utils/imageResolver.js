"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveImage = resolveImage;
const axios_1 = __importDefault(require("axios"));
const dns_1 = require("dns");
const url_1 = require("url");
// Own server hostname (staging URLs bypass SSRF check)
const ownUrl = (() => {
    try {
        return process.env.BASE_URL ? new url_1.URL(process.env.BASE_URL) : null;
    }
    catch {
        return null;
    }
})();
const MIME_TO_EXT = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/bmp': '.bmp',
    'image/tiff': '.tiff',
    'image/svg+xml': '.svg',
};
function ensureExtension(filename, mimeType) {
    if (/\.[a-zA-Z0-9]+$/.test(filename))
        return filename;
    return filename + (MIME_TO_EXT[mimeType] ?? '.jpg');
}
const ALLOWED_MIME_TYPES = new Set([
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/bmp',
    'image/tiff',
    'image/svg+xml',
]);
const MAX_IMAGE_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 30000;
const DATA_URL_RE = /^data:([^;,]+)?(;base64)?,(.*)$/i;
const DEFAULT_MIME_TYPE = 'image/jpeg';
function classifyInternalIp(ip) {
    if (ip === '127.0.0.1' || ip === '::1' || ip === '0:0:0:0:0:0:0:1')
        return 'loopback';
    if (ip === '0.0.0.0' || ip === '::')
        return 'unspecified';
    const parts = ip.split('.').map(Number);
    if (parts.length === 4 && parts.every(p => !isNaN(p))) {
        if (parts[0] === 127)
            return 'loopback';
        if (parts[0] === 10)
            return 'private';
        if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
            return 'private';
        if (parts[0] === 192 && parts[1] === 168)
            return 'private';
        if (parts[0] === 169 && parts[1] === 254)
            return 'link-local';
        if (parts[0] >= 224 && parts[0] <= 239)
            return 'multicast';
    }
    // IPv6: ULA (fc00::/7), link-local (fe80::/10), multicast (ff00::/8)
    const lower = ip.toLowerCase();
    if (lower.startsWith('fc') || lower.startsWith('fd'))
        return 'private';
    if (lower.startsWith('fe80'))
        return 'link-local';
    if (lower.startsWith('ff'))
        return 'multicast';
    return null;
}
async function validateNotInternalHost(hostname) {
    let addresses;
    try {
        addresses = await dns_1.promises.lookup(hostname, { all: true });
    }
    catch {
        throw new Error(`Failed to resolve hostname: ${hostname}`);
    }
    for (const { address } of addresses) {
        const reason = classifyInternalIp(address);
        if (reason) {
            throw new Error(`URL resolves to a ${reason} IP address (${address}) — only public URLs are allowed`);
        }
    }
}
function extractFilenameFromUrl(url, fallback) {
    try {
        const parsed = new url_1.URL(url);
        const segments = parsed.pathname.replace(/\/$/, '').split('/');
        const name = segments[segments.length - 1];
        if (name && name.includes('.')) {
            return name.replace(/[^\w\-.]/g, '_').slice(0, 255);
        }
    }
    catch {
        // ignore
    }
    return fallback;
}
async function fetchImageFromUrl(url, fallbackName) {
    let currentUrl = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        let parsed;
        try {
            parsed = new url_1.URL(currentUrl);
        }
        catch {
            throw new Error(`Invalid URL: ${currentUrl}`);
        }
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            throw new Error(`Unsupported URL scheme: ${parsed.protocol} — only http and https are allowed`);
        }
        const isOwnServer = ownUrl &&
            parsed.hostname === ownUrl.hostname &&
            (parsed.port || (parsed.protocol === 'https:' ? '443' : '80')) ===
                (ownUrl.port || (ownUrl.protocol === 'https:' ? '443' : '80'));
        if (!isOwnServer)
            await validateNotInternalHost(parsed.hostname);
        let response;
        try {
            response = await axios_1.default.get(currentUrl, {
                responseType: 'arraybuffer',
                maxRedirects: 0,
                timeout: REQUEST_TIMEOUT_MS,
                validateStatus: (status) => status < 500,
                headers: { 'User-Agent': 'BookStack-MCP/1.0', Accept: 'image/*' },
            });
        }
        catch (err) {
            if (err.code === 'ECONNABORTED') {
                throw new Error(`Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s fetching ${url}`);
            }
            throw new Error(`Failed to fetch image from URL: ${err.message}`);
        }
        if (response.status >= 300 && response.status < 400) {
            const location = response.headers['location'];
            if (!location)
                throw new Error('Redirect response missing Location header');
            if (hop >= MAX_REDIRECTS) {
                throw new Error(`Too many redirects (max ${MAX_REDIRECTS}) fetching ${url}`);
            }
            currentUrl = new url_1.URL(location, currentUrl).toString();
            continue;
        }
        if (response.status >= 400) {
            throw new Error(`HTTP ${response.status} when fetching image from ${url}`);
        }
        const contentLengthHeader = response.headers['content-length'];
        if (contentLengthHeader) {
            const contentLength = parseInt(String(contentLengthHeader), 10);
            if (!isNaN(contentLength) && contentLength > MAX_IMAGE_SIZE_BYTES) {
                throw new Error(`Image too large: ${contentLength} bytes exceeds ${MAX_IMAGE_SIZE_BYTES} byte limit`);
            }
        }
        const content = Buffer.from(response.data);
        if (content.length > MAX_IMAGE_SIZE_BYTES) {
            throw new Error(`Downloaded image exceeds ${MAX_IMAGE_SIZE_BYTES} byte limit`);
        }
        if (content.length === 0) {
            throw new Error('Downloaded image is empty');
        }
        const contentTypeHeader = response.headers['content-type'];
        const rawMime = (typeof contentTypeHeader === 'string' ? contentTypeHeader : '').split(';')[0].trim().toLowerCase();
        if (!ALLOWED_MIME_TYPES.has(rawMime)) {
            throw new Error(`Unsupported image MIME type: "${rawMime || '(none)'}". Allowed: ${[...ALLOWED_MIME_TYPES].sort().join(', ')}`);
        }
        const filename = ensureExtension(extractFilenameFromUrl(currentUrl, fallbackName), rawMime);
        return { filename, content, mimeType: rawMime };
    }
    throw new Error(`Too many redirects (max ${MAX_REDIRECTS}) fetching ${url}`);
}
async function resolveImage(image, fallbackName) {
    const value = image.trim();
    // HTTP/HTTPS URL
    if (/^https?:\/\//i.test(value)) {
        return fetchImageFromUrl(value, fallbackName);
    }
    // Data-URI
    const match = DATA_URL_RE.exec(value);
    if (match) {
        const mimeType = (match[1] ?? DEFAULT_MIME_TYPE).toLowerCase();
        const isBase64 = !!match[2];
        const payload = match[3] ?? '';
        if (!isBase64) {
            throw new Error('Only base64-encoded data URIs are supported (data:...;base64,...)');
        }
        const content = Buffer.from(payload.replace(/\s+/g, ''), 'base64');
        if (content.length === 0) {
            throw new Error('Data URI image payload is empty after decoding');
        }
        return { filename: ensureExtension(fallbackName, mimeType), content, mimeType };
    }
    // Plain Base64
    const content = Buffer.from(value.replace(/\s+/g, ''), 'base64');
    if (content.length === 0) {
        throw new Error('Decoded base64 image payload is empty');
    }
    return { filename: ensureExtension(fallbackName, DEFAULT_MIME_TYPE), content, mimeType: DEFAULT_MIME_TYPE };
}
//# sourceMappingURL=imageResolver.js.map