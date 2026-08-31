declare module "dcmjs" {
    const dcmjs: {
        data: {
            DicomMessage: { readFile(buffer: ArrayBuffer): { dict: Record<string, unknown>; write(): ArrayBuffer } };
        };
        anonymizer: {
            cleanTags(dict: Record<string, unknown>, replacements?: Record<string, string>, tagsToEmpty?: string[]): void;
        };
    };
    export default dcmjs;
}
