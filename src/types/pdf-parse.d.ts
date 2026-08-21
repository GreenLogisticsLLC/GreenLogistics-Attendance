declare module "pdf-parse" {
    type PdfData = { text: string; numpages?: number; info?: unknown };
    function pdfParse(dataBuffer: Buffer): Promise<PdfData>;
    export default pdfParse;
}
