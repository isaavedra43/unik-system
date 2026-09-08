declare module 'pdf-parse' {
  interface PdfData {
    numpages: number;
    numrender: number;
    info: {
      PDFFormatVersion?: string;
      IsAcroFormPresent?: boolean;
      IsXFAPresent?: boolean;
      Title?: string;
      Author?: string;
      Subject?: string;
      Keywords?: string;
      Creator?: string;
      Producer?: string;
      CreationDate?: string;
      ModDate?: string;
    };
    metadata: Record<string, unknown>;
    text: string;
    version?: string;
  }

  function pdfParse(buffer: Buffer): Promise<PdfData>;
  export default pdfParse;
}
