export interface PreparedImage {
    filename: string;
    content: Buffer;
    mimeType: string;
}
export declare function resolveImage(image: string, fallbackName: string): Promise<PreparedImage>;
//# sourceMappingURL=imageResolver.d.ts.map